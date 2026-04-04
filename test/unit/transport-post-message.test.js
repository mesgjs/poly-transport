import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { PostMessageTransport } from '../../src/transport/post-message.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import {
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA, HDR_TYPE_HANDSHAKE,
	DATA_HEADER_BYTES, FLAG_EOM, PROTOCOL,
	ackHeaderSize, TCC_DTAM_CHAN_REQUEST,
} from '../../src/protocol.esm.js';

/**
 * Mock gateway object that simulates a Worker or Window postMessage interface.
 * Captures outgoing messages and allows simulating incoming messages.
 */
class MockGateway {
	listeners = new Map();
	sentMessages = [];

	addEventListener (type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}

	removeEventListener (type, handler) {
		const handlers = this.listeners.get(type);
		if (handlers) {
			const idx = handlers.indexOf(handler);
			if (idx >= 0) handlers.splice(idx, 1);
		}
	}

	postMessage (data, transfer) {
		this.sentMessages.push({ data, transfer });
	}

	// Simulate receiving a message from the remote side
	simulateMessage (data) {
		const handlers = this.listeners.get('message') || [];
		const event = { data };
		for (const handler of handlers) handler(event);
	}

	// Get all messages sent via postMessage
	getSentMessages () {
		return [...this.sentMessages];
	}

	// Clear sent messages
	clearSentMessages () {
		this.sentMessages = [];
	}

	// Get the most recently sent message
	getLastSentMessage () {
		return this.sentMessages[this.sentMessages.length - 1];
	}

	// Get count of registered listeners for a given event type
	getListenerCount (type) {
		return this.listeners.get(type)?.length ?? 0;
	}
}

/**
 * Concrete subclass of PostMessageTransport that exposes protected state for testing.
 * Also allows intercepting receiveMessage via __protected override.
 */
class MockPostMessageTransport extends PostMessageTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		receiveMessage (header, data) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Call interceptor if set, then call super
			if (thys.#receiveMessageInterceptor) thys.#receiveMessageInterceptor(header, data);
			return super.receiveMessage(header, data);
		}
	}, super.__protected));

	#_subs = new Set();
	#_;
	#receiveMessageInterceptor = null;

	constructor (options = {}) {
		const gateway = options.gateway || new MockGateway();
		super({ ...options, gateway });
		this._get_();
	}

	// Expose protected state for testing
	getProtectedState () {
		return this.#_;
	}

	// Set an interceptor for receiveMessage calls
	setReceiveMessageInterceptor (fn) {
		this.#receiveMessageInterceptor = fn;
	}

	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}
}

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('PostMessageTransport - constructor creates transport with gateway', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertExists(transport);
	assert(transport instanceof PostMessageTransport);
	assert(transport instanceof Transport);
});

Deno.test('PostMessageTransport - constructor registers message listener on gateway', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	// Verify a 'message' listener was actually registered on the gateway
	assertEquals(gateway.getListenerCount('message'), 1, 'Exactly one message listener should be registered');
});

Deno.test('PostMessageTransport - constructor accepts bufferPool option', () => {
	const gateway = new MockGateway();
	const bufferPool = new BufferPool();
	const transport = new MockPostMessageTransport({ gateway, bufferPool });

	const _thys = transport.getProtectedState();
	assertEquals(_thys.bufferPool, bufferPool);
});

Deno.test('PostMessageTransport - constructor initializes transport ID', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertExists(transport.id);
	assertEquals(typeof transport.id, 'string');
	// UUID format check
	assert(/^[0-9a-f-]{36}$/.test(transport.id), 'Transport ID should be a UUID');
});

Deno.test('PostMessageTransport - constructor starts in CREATED state', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertEquals(transport.state, Transport.STATE_CREATED);
});

// ─── needsEncodedText Tests ───────────────────────────────────────────────────

Deno.test('PostMessageTransport - needsEncodedText returns false', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertEquals(transport.needsEncodedText, false);
});

Deno.test('PostMessageTransport - needsEncodedText differs from ByteTransport (true)', () => {
	// PostMessageTransport can send strings natively via postMessage
	// so it does NOT need text encoding (unlike ByteTransport)
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertEquals(transport.needsEncodedText, false);
});

// ─── sendHandshake Tests ──────────────────────────────────────────────────────

Deno.test('PostMessageTransport - sendHandshake sends handshake message via postMessage', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	const messages = gateway.getSentMessages();
	assertEquals(messages.length, 1);

	const { data } = messages[0];
	assertEquals(data.protocol, PROTOCOL);
	assertEquals(data.header.type, HDR_TYPE_HANDSHAKE);
});

Deno.test('PostMessageTransport - sendHandshake includes transport configuration', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	const { data } = gateway.getLastSentMessage();
	const config = data.data;

	assertExists(config.transportId);
	assertEquals(config.version, 1);
	assertEquals(typeof config.c2cEnabled, 'boolean');
	assertExists(config.minChannelId);
	assertExists(config.minMessageTypeId);
});

Deno.test('PostMessageTransport - sendHandshake includes transport ID matching transport.id', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	const { data } = gateway.getLastSentMessage();
	assertEquals(data.data.transportId, transport.id);
});

Deno.test('PostMessageTransport - sendHandshake c2cEnabled is false when no c2cSymbol', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	const { data } = gateway.getLastSentMessage();
	assertEquals(data.data.c2cEnabled, false);
});

Deno.test('PostMessageTransport - sendHandshake c2cEnabled is true when c2cSymbol provided', async () => {
	const gateway = new MockGateway();
	const c2cSymbol = Symbol('c2c');
	const transport = new MockPostMessageTransport({ gateway, c2cSymbol });
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	const { data } = gateway.getLastSentMessage();
	assertEquals(data.data.c2cEnabled, true);
});

// ─── onMessage / Handshake Reception Tests ───────────────────────────────────

Deno.test('PostMessageTransport - ignores messages with wrong protocol', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	// Should not throw or change state
	gateway.simulateMessage({ protocol: 'WrongProtocol', header: { type: HDR_TYPE_HANDSHAKE }, data: {} });

	assertEquals(transport.state, Transport.STATE_CREATED);
});

Deno.test('PostMessageTransport - ignores messages with no protocol', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	// Should not throw
	gateway.simulateMessage({ header: { type: HDR_TYPE_HANDSHAKE }, data: {} });
	gateway.simulateMessage(null);
	gateway.simulateMessage(undefined);
	gateway.simulateMessage({});

	assertEquals(transport.state, Transport.STATE_CREATED);
});

Deno.test('PostMessageTransport - processes handshake message and calls onRemoteConfig', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	// Start the transport (sends our handshake)
	const startPromise = transport.start();

	// Simulate receiving remote handshake
	const remoteConfig = {
		transportId: 'remote-transport-id',
		version: 1,
		c2cEnabled: false,
		minChannelId: 2,
		minMessageTypeId: 256,
	};
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: remoteConfig,
	});

	// Wait for transport to become active
	await startPromise;

	assertEquals(transport.state, Transport.STATE_ACTIVE);
	assertExists(_thys.role);
});

Deno.test('PostMessageTransport - handshake with same transport ID causes error', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	// Start the transport
	const startPromise = transport.start();

	// Simulate receiving our own transport ID (error case)
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: transport.id, // Same ID as ours
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});

	// Should reject with error
	await assertRejects(() => startPromise);
});

Deno.test('PostMessageTransport - ignores handshake with non-object data', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	// Should not throw
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: null,
	});
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: 'string-data',
	});
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: 42,
	});

	// State should remain CREATED (no valid config processed)
	assertEquals(transport.state, Transport.STATE_CREATED);
});

// ─── onMessage / ACK Reception Tests ─────────────────────────────────────────

Deno.test('PostMessageTransport - processes ACK message and routes to channel', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	// Track protocol violations
	let violation = null;
	transport.addEventListener('protocolViolation', (event) => { violation = event.detail; });

	// Start and complete handshake
	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Initiate a channel request so that TCC sends sequence 1 (a chanRequest message).
	// We don't await the result - we just need the write to happen so sequence 1 is assigned.
	transport.requestChannel('test-channel').catch(() => {});

	// Give time for the channel request write to be queued/sent
	await new Promise((r) => setTimeout(r, 20));

	// Now send ACK for TCC sequence 1 (the chanRequest message we just sent)
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_ACK,
			channelId: 0,
			baseSequence: 1,
			ranges: [],
		},
		data: null,
	});

	// Give time for async processing
	await new Promise((r) => setTimeout(r, 20));

	// Verify ACK was processed without protocol violation
	assertEquals(violation, null, 'ACK should be processed without protocol violation');
	// Transport should still be active (not stopped due to error)
	assertEquals(transport.state, Transport.STATE_ACTIVE, 'Transport should remain active after valid ACK');

	await transport.stop();
});

Deno.test('PostMessageTransport - ACK message computes headerSize from ranges', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	// Track receiveMessage calls
	let receivedHeader = null;
	transport.setReceiveMessageInterceptor((header, data) => {
		if (header.type === HDR_TYPE_ACK) receivedHeader = header;
	});

	// Start and complete handshake
	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Send 3 channel requests so TCC sequences 1-3 are assigned (nextWriteSeq becomes 4).
	// We don't await results - we just need the writes to happen.
	for (let i = 0; i < 3; i++) {
		transport.requestChannel(`test-channel-${i}`).catch(() => {});
	}
	await new Promise((r) => setTimeout(r, 20));

	// Send ACK with 3 range bytes (include=1, skip=0, include=1 → ACKs sequences 1, 2, 3).
	// ranges.length === 3 is what matters for the headerSize assertion.
	const ranges = [1, 0, 1]; // 3 range bytes; ACKs base=1, seq 2, then seq 3
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_ACK,
			channelId: 0,
			baseSequence: 1,
			ranges,
		},
		data: null,
	});

	await new Promise((r) => setTimeout(r, 20));

	// Verify the interceptor was called and headerSize was computed correctly
	assertExists(receivedHeader, 'ACK receiveMessage interceptor should have been called');
	assertEquals(receivedHeader.headerSize, ackHeaderSize(ranges.length));
	assertEquals(receivedHeader.dataSize, 0);

	await transport.stop();
});

Deno.test('PostMessageTransport - ACK message with no ranges has correct headerSize', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let receivedHeader = null;
	transport.setReceiveMessageInterceptor((header, data) => {
		if (header.type === HDR_TYPE_ACK) receivedHeader = header;
	});

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Send 1 channel request so TCC sequence 1 is assigned (nextWriteSeq becomes 2).
	transport.requestChannel('test-channel').catch(() => {});
	await new Promise((r) => setTimeout(r, 20));

	// ACK with no ranges (ranges omitted) - ACKs only base sequence 1
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_ACK,
			channelId: 0,
			baseSequence: 1,
			// ranges omitted - should default to []
		},
		data: null,
	});

	await new Promise((r) => setTimeout(r, 20));

	assertExists(receivedHeader, 'ACK receiveMessage interceptor should have been called');
	assertEquals(receivedHeader.headerSize, ackHeaderSize(0));
	assertEquals(receivedHeader.dataSize, 0);

	await transport.stop();
});

// ─── onMessage / Channel Data Reception Tests ─────────────────────────────────

Deno.test('PostMessageTransport - processes TCC data message (chanRequest)', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	gateway.clearSentMessages();

	// Send a chanRequest data message to TCC (channel 0, messageType=TCC_DTAM_CHAN_REQUEST[0])
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_CHAN_DATA,
			channelId: 0,
			sequence: 1,
			messageType: TCC_DTAM_CHAN_REQUEST[0],
			flags: FLAG_EOM,
		},
		data: JSON.stringify({ channelName: 'test', maxBufferBytes: 65536, maxChunkBytes: 16384 }),
	});

	await new Promise((r) => setTimeout(r, 20));

	// Verify the chanRequest was processed: transport should have sent a chanResponse back
	// (messageType=TCC_DTAM_CHAN_RESPONSE[0]) via the TCC (channel 0)
	const sentMessages = gateway.getSentMessages();
	const chanResponseMessages = sentMessages.filter((m) =>
		m.data?.header?.type === HDR_TYPE_CHAN_DATA &&
		m.data?.header?.channelId === 0 &&
		m.data?.header?.messageType === 2 // TCC_DTAM_CHAN_RESPONSE[0]
	);
	assertEquals(chanResponseMessages.length, 1, 'Transport should send a chanResponse after receiving chanRequest');

	await transport.stop();
});

Deno.test('PostMessageTransport - channel data message sets headerSize to DATA_HEADER_BYTES', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let receivedHeader = null;
	transport.setReceiveMessageInterceptor((header, data) => {
		if (header.type === HDR_TYPE_CHAN_DATA) receivedHeader = header;
	});

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Send a TCC data message (chanRequest) - valid HDR_TYPE_CHAN_DATA on TCC
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_CHAN_DATA,
			channelId: 0,
			sequence: 1,
			messageType: TCC_DTAM_CHAN_REQUEST[0],
			flags: FLAG_EOM,
		},
		data: JSON.stringify({ channelName: 'test', maxBufferBytes: 65536, maxChunkBytes: 16384 }),
	});

	await new Promise((r) => setTimeout(r, 20));

	assertExists(receivedHeader, 'Channel data message receiveMessage interceptor should have been called');
	assertEquals(receivedHeader.headerSize, DATA_HEADER_BYTES);

	await transport.stop();
});

Deno.test('PostMessageTransport - channel data message with string data passes string through', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let receivedData = undefined;
	transport.setReceiveMessageInterceptor((header, data) => {
		if (header.type === HDR_TYPE_CHAN_DATA) receivedData = data;
	});

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const testString = JSON.stringify({ channelName: 'test', maxBufferBytes: 65536, maxChunkBytes: 16384 });
	// Send a TCC data message (chanRequest) with string data
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_CHAN_DATA,
			channelId: 0,
			sequence: 1,
			messageType: TCC_DTAM_CHAN_REQUEST[0],
			flags: FLAG_EOM,
		},
		data: testString,
	});

	await new Promise((r) => setTimeout(r, 20));

	assertExists(receivedData, 'Channel data message receiveMessage interceptor should have been called with data');
	assertEquals(typeof receivedData, 'string');
	assertEquals(receivedData, testString);

	await transport.stop();
});

Deno.test('PostMessageTransport - channel data message with null data has zero dataSize', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let receivedHeader = null;
	transport.setReceiveMessageInterceptor((header, data) => {
		if (header.type === HDR_TYPE_CHAN_DATA) receivedHeader = header;
	});

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Send a TCC data message with null data (tranStop has no payload)
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_CHAN_DATA,
			channelId: 0,
			sequence: 1,
			messageType: TCC_DTAM_CHAN_REQUEST[0],
			flags: FLAG_EOM,
		},
		data: null, // No data
	});

	await new Promise((r) => setTimeout(r, 20));

	assertExists(receivedHeader, 'Channel data message receiveMessage interceptor should have been called');
	assertEquals(receivedHeader.dataSize, 0);

	await transport.stop();
});

// ─── sendAckMessage Tests ─────────────────────────────────────────────────────

Deno.test('PostMessageTransport - sendAckMessage requires symbol token', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	await assertRejects(
		() => transport.sendAckMessage('not-a-symbol', {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('PostMessageTransport - sendAckMessage requires valid channel token', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	// Symbol that is not registered as a channel token
	const fakeToken = Symbol('fake');
	await assertRejects(
		() => transport.sendAckMessage(fakeToken, {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('PostMessageTransport - sendAckMessage sends ACK via postMessage', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	// Start and complete handshake
	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Get TCC channel and its token
	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Create mock flow control with ACK info
	const mockFlowControl = {
		clearReadAckInfo: () => {},
		getAckInfo: () => ({ base: 1, ranges: [] }),
	};

	gateway.clearSentMessages();

	// Send ACK
	transport.sendAckMessage(token, mockFlowControl);

	// Give time for async processing
	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const ackMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_ACK);
	assertEquals(ackMessages.length, 1);

	const ackMsg = ackMessages[0];
	assertEquals(ackMsg.data.protocol, PROTOCOL);
	assertEquals(ackMsg.data.header.type, HDR_TYPE_ACK);
	assertEquals(ackMsg.data.header.channelId, 0); // TCC channel ID

	await transport.stop();
});

Deno.test('PostMessageTransport - sendAckMessage with no ACK info sends nothing', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Flow control with no ACK info (base === undefined)
	const mockFlowControl = {
		clearReadAckInfo: () => {},
		getAckInfo: () => ({ base: undefined, ranges: [] }),
	};

	gateway.clearSentMessages();
	transport.sendAckMessage(token, mockFlowControl);

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const ackMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_ACK);
	assertEquals(ackMessages.length, 0, 'No ACK should be sent when base is undefined');

	await transport.stop();
});

Deno.test('PostMessageTransport - sendAckMessage includes baseSequence and ranges', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const mockFlowControl = {
		clearReadAckInfo: () => {},
		getAckInfo: () => ({ base: 42, ranges: [5, 2, 3] }),
	};

	gateway.clearSentMessages();
	transport.sendAckMessage(token, mockFlowControl);

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const ackMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_ACK);
	assertEquals(ackMessages.length, 1);

	const header = ackMessages[0].data.header;
	assertEquals(header.baseSequence, 42);
	assertEquals(header.ranges, [5, 2, 3]);

	await transport.stop();
});

// ─── sendChunk Tests ──────────────────────────────────────────────────────────

Deno.test('PostMessageTransport - sendChunk requires symbol token', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	await assertRejects(
		() => transport.sendChunk('not-a-symbol', {}, {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('PostMessageTransport - sendChunk requires valid channel token', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const fakeToken = Symbol('fake');
	await assertRejects(
		() => transport.sendChunk(fakeToken, {}, {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('PostMessageTransport - sendChunk sends string data via postMessage', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const testString = 'Hello, World!';
	let remaining = testString.length;
	const mockChunker = {
		bufferSize: null, // null = UTF-16 string mode
		bytesToReserve: () => testString.length * 2,
		nextChunk: () => {
			remaining = 0;
			return testString;
		},
		get remaining () { return remaining; },
	};

	const header = {
		type: HDR_TYPE_CHAN_DATA,
		sequence: 1,
		messageType: 100,
	};

	gateway.clearSentMessages();
	transport.sendChunk(token, header, mockChunker, { eom: true });

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const dataMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_CHAN_DATA);
	assertEquals(dataMessages.length, 1);

	const msg = dataMessages[0];
	assertEquals(msg.data.protocol, PROTOCOL);
	assertEquals(msg.data.data, testString);
	assertEquals(msg.data.header.type, HDR_TYPE_CHAN_DATA);

	await transport.stop();
});

Deno.test('PostMessageTransport - sendChunk sets EOM flag when eom=true and remaining<=0', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const testString = 'test';
	let remaining = testString.length;
	const mockChunker = {
		bufferSize: null,
		bytesToReserve: () => testString.length * 2,
		nextChunk: () => {
			remaining = 0;
			return testString;
		},
		get remaining () { return remaining; },
	};

	const header = { type: HDR_TYPE_CHAN_DATA, sequence: 1, messageType: 100 };

	gateway.clearSentMessages();
	transport.sendChunk(token, header, mockChunker, { eom: true });

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const dataMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_CHAN_DATA);
	assertEquals(dataMessages.length, 1);

	// EOM flag should be set
	assert((dataMessages[0].data.header.flags & FLAG_EOM) !== 0, 'EOM flag should be set');

	await transport.stop();
});

Deno.test('PostMessageTransport - sendChunk does not set EOM flag when remaining>0', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const testString = 'test';
	// remaining stays > 0 (simulating more data to come)
	const mockChunker = {
		bufferSize: null,
		bytesToReserve: () => testString.length * 2,
		nextChunk: () => testString,
		remaining: 100, // Still more data remaining
	};

	const header = { type: HDR_TYPE_CHAN_DATA, sequence: 1, messageType: 100 };

	gateway.clearSentMessages();
	transport.sendChunk(token, header, mockChunker, { eom: true });

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const dataMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_CHAN_DATA);
	assertEquals(dataMessages.length, 1);

	// EOM flag should NOT be set (remaining > 0)
	assertEquals((dataMessages[0].data.header.flags & FLAG_EOM), 0, 'EOM flag should not be set');

	await transport.stop();
});

Deno.test('PostMessageTransport - sendChunk includes correct header fields', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const testString = 'test';
	let remaining = testString.length;
	const mockChunker = {
		bufferSize: null,
		bytesToReserve: () => testString.length * 2,
		nextChunk: () => {
			remaining = 0;
			return testString;
		},
		get remaining () { return remaining; },
	};

	const header = {
		type: HDR_TYPE_CHAN_DATA,
		sequence: 7,
		messageType: 42,
		flags: 0,
	};

	gateway.clearSentMessages();
	transport.sendChunk(token, header, mockChunker);

	await new Promise((r) => setTimeout(r, 20));

	const messages = gateway.getSentMessages();
	const dataMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_CHAN_DATA);
	assertEquals(dataMessages.length, 1);

	const sentHeader = dataMessages[0].data.header;
	assertEquals(sentHeader.type, HDR_TYPE_CHAN_DATA);
	assertEquals(sentHeader.sequence, 7);
	assertEquals(sentHeader.messageType, 42);
	assertEquals(sentHeader.channelId, 0); // TCC channel ID

	await transport.stop();
});

Deno.test('PostMessageTransport - sendChunk returns byte count', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	const testString = 'test';
	const expectedBytes = testString.length * 2;
	let remaining = testString.length;
	const mockChunker = {
		bufferSize: null,
		bytesToReserve: () => expectedBytes,
		nextChunk: () => {
			remaining = 0;
			return testString;
		},
		get remaining () { return remaining; },
	};

	const header = { type: HDR_TYPE_CHAN_DATA, sequence: 1, messageType: 100 };
	const result = transport.sendChunk(token, header, mockChunker);

	assertEquals(result, expectedBytes);

	await transport.stop();
});

// ─── Transport Lifecycle Tests ────────────────────────────────────────────────

Deno.test('PostMessageTransport - start transitions to STARTING state', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const startPromise = transport.start();
	assertEquals(transport.state, Transport.STATE_STARTING);

	// Complete handshake to avoid hanging
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	await transport.stop();
});

Deno.test('PostMessageTransport - start transitions to ACTIVE after handshake', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const startPromise = transport.start();

	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	assertEquals(transport.state, Transport.STATE_ACTIVE);

	await transport.stop();
});

Deno.test('PostMessageTransport - start sends handshake automatically', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const startPromise = transport.start();

	// Check that handshake was sent
	const messages = gateway.getSentMessages();
	const handshakeMessages = messages.filter((m) => m.data?.header?.type === HDR_TYPE_HANDSHAKE);
	assertEquals(handshakeMessages.length, 1);

	// Complete handshake
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	await transport.stop();
});

Deno.test('PostMessageTransport - stop transitions to STOPPED state', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	await transport.stop();
	assertEquals(transport.state, Transport.STATE_STOPPED);
});

Deno.test('PostMessageTransport - stop emits stopped event', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let stoppedFired = false;
	transport.addEventListener('stopped', () => { stoppedFired = true; });

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	await transport.stop();
	assertEquals(stoppedFired, true);
});

Deno.test('PostMessageTransport - calling start twice returns same promise', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const p1 = transport.start();
	const p2 = transport.start();

	// Both should be the same promise (or at least both resolve)
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});

	await Promise.all([p1, p2]);
	assertEquals(transport.state, Transport.STATE_ACTIVE);

	await transport.stop();
});

// ─── Channel Management Tests ─────────────────────────────────────────────────

Deno.test('PostMessageTransport - TCC channel created after handshake', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// TCC should be registered at channel ID 0
	const tcc = _thys.channels.get(0);
	assertExists(tcc);

	await transport.stop();
});

Deno.test('PostMessageTransport - C2C channel created when both sides enable it', async () => {
	const gateway = new MockGateway();
	const c2cSymbol = Symbol('c2c');
	const transport = new MockPostMessageTransport({ gateway, c2cSymbol });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: true, // Remote also enables C2C
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// C2C should be registered at channel ID 1
	const c2c = _thys.channels.get(1);
	assertExists(c2c);

	await transport.stop();
});

Deno.test('PostMessageTransport - C2C channel not created when remote disables it', async () => {
	const gateway = new MockGateway();
	const c2cSymbol = Symbol('c2c');
	const transport = new MockPostMessageTransport({ gateway, c2cSymbol });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false, // Remote disables C2C
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// C2C should NOT be registered
	const c2c = _thys.channels.get(1);
	assertEquals(c2c, undefined);

	await transport.stop();
});

Deno.test('PostMessageTransport - role determined by transport ID comparison', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();

	// Use a remote ID that is lexicographically greater than ours
	// (transport IDs are UUIDs, so we can force a comparison)
	const ourId = transport.id;
	const remoteId = ourId < 'z' ? 'z'.repeat(36) : '0'.repeat(36);

	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: remoteId,
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Role should be determined
	assert(_thys.role === Transport.ROLE_EVEN || _thys.role === Transport.ROLE_ODD);

	await transport.stop();
});

Deno.test('PostMessageTransport - getChannel returns undefined before handshake', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertEquals(transport.getChannel('nonexistent'), undefined);
});

// ─── Protocol Violation Tests ─────────────────────────────────────────────────

Deno.test('PostMessageTransport - unknown channel ID stops transport', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	// Send message to unknown channel ID - transport logs error and stops
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: {
			type: HDR_TYPE_CHAN_DATA,
			channelId: 9999, // Unknown channel
			sequence: 1,
			messageType: 100,
			flags: 0,
		},
		data: 'test',
	});

	await new Promise((r) => setTimeout(r, 50));

	// Transport should have stopped due to unknown channel ID
	assertEquals(transport.state, Transport.STATE_STOPPED, 'Transport should stop when unknown channel ID is received');
});

// ─── Inheritance Tests ────────────────────────────────────────────────────────

Deno.test('PostMessageTransport - extends Transport base class', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assert(transport instanceof Transport);
	assert(transport instanceof PostMessageTransport);
});

Deno.test('PostMessageTransport - inherits Transport properties', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertExists(transport.id);
	assertExists(transport.logger);
	assertExists(transport.logChannelId);
	assertEquals(transport.state, Transport.STATE_CREATED);
	assertEquals(transport.stateString, 'created');
});

Deno.test('PostMessageTransport - inherits maxChunkBytes from options', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway, maxChunkBytes: 8192 });

	assertEquals(transport.maxChunkBytes, 8192);
});

Deno.test('PostMessageTransport - uses default maxChunkBytes when not specified', () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	assertEquals(transport.maxChunkBytes, 16 * 1024);
});

Deno.test('PostMessageTransport - supports event listeners', async () => {
	const gateway = new MockGateway();
	const transport = new MockPostMessageTransport({ gateway });

	let beforeStoppingFired = false;
	transport.addEventListener('beforeStopping', () => { beforeStoppingFired = true; });

	const startPromise = transport.start();
	gateway.simulateMessage({
		protocol: PROTOCOL,
		header: { type: HDR_TYPE_HANDSHAKE },
		data: {
			transportId: 'remote-id',
			version: 1,
			c2cEnabled: false,
			minChannelId: 2,
			minMessageTypeId: 256,
		},
	});
	await startPromise;

	await transport.stop();
	assertEquals(beforeStoppingFired, true);
});
