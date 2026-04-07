import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Transport, StateError } from '../../src/transport/base.esm.js';
import {
	HDR_TYPE_CHAN_DATA, FLAG_EOM, DATA_HEADER_BYTES,
	TCC_DTAM_TRAN_STOPPED, CHANNEL_TCC,
} from '../../src/protocol.esm.js';
import { VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';

// Mock transport implementation for testing
class MockTransport extends Transport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		async sendHandshake () {
			// Mock handshake
		},

		startReader () {
			// Mock reader
		},

		startWriter () {
			// Mock writer
		},
	}, Transport.__protected));

	#_ = null;
	#_subs = new Set();

	constructor (options = {}) {
		super(options);
		this._get_(); // Get protected state from parent
	}

	_sub_ (subs) {
		super._sub_(subs);
		subs.add((g) => this.#_ ||= g);
	}

	// Helper to trigger remote config for testing
	async triggerRemoteConfig (config) {
		await this.#_.onRemoteConfig(config);
	}

	// Helper to access protected state for testing
	getProtectedState () {
		return this.#_;
	}

	// Simulate remote sending tranStopped so stop() handshake can complete
	#simulateRemoteTranStopped () {
		const _thys = this.#_;
		const tcc = _thys.channels.get(CHANNEL_TCC);
		if (tcc) {
			const data = '{}';
			_thys.receiveMessage({
				type: HDR_TYPE_CHAN_DATA,
				headerSize: DATA_HEADER_BYTES,
				dataSize: data.length * 2,
				flags: FLAG_EOM,
				channelId: CHANNEL_TCC,
				sequence: tcc.nextReadSeq,
				messageType: TCC_DTAM_TRAN_STOPPED[0],
				eom: true,
			}, data);
		}
	}

	// Mock sendChunk - consume the chunk and return remaining
	/* async */ sendChunk (token, flowControl, header, chunker, { eom } = {}) {
		const bytesToReserve = chunker.bytesToReserve();
		const sequence = flowControl.nextWriteSeq;
		if (chunker.bufferSize !== null) {
			// Binary/encoded chunk - provide a real buffer for encodeFrom
			const buf = new VirtualRWBuffer(new Uint8Array(bytesToReserve));
			chunker.nextChunk(buf);
		} else {
			// String chunk - consume it
			chunker.nextChunk();
		}
		flowControl.sent(bytesToReserve);

		// When we "send" our tranStopped, simulate remote sending theirs
		if (header.messageType === TCC_DTAM_TRAN_STOPPED[0]) {
			this.#simulateRemoteTranStopped();
		}

		return Promise.resolve(chunker.remaining);
	}

	// Mock sendAckMessage - no-op
	/* async */ sendAckMessage (token, flowControl) {
		return Promise.resolve();
	}
}

// Tests for Transport constants
Deno.test('Transport - ROLE constants', () => {
	assertEquals(Transport.ROLE_EVEN, 0);
	assertEquals(Transport.ROLE_ODD, 1);
});

Deno.test('Transport - STATE constants', () => {
	assertEquals(Transport.STATE_CREATED, 0);
	assertEquals(Transport.STATE_STARTING, 1);
	assertEquals(Transport.STATE_ACTIVE, 2);
	assertEquals(Transport.STATE_STOPPING, 3);
	assertEquals(Transport.STATE_LOCAL_STOPPING, 4);
	assertEquals(Transport.STATE_REMOTE_STOPPING, 5);
	assertEquals(Transport.STATE_STOPPED, 6);
	assertEquals(Transport.STATE_DISCONNECTED, 7);
});

// Tests for constructor
Deno.test('Transport - constructor with default logger', () => {
	const transport = new MockTransport();
	assert(transport.logger !== null);
	assertEquals(transport.state, Transport.STATE_CREATED);
	assertEquals(transport.stateString, 'created');
});

Deno.test('Transport - constructor with custom logger', () => {
	const customLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
	const transport = new MockTransport({ logger: customLogger });
	assertEquals(transport.logger, customLogger);
});

Deno.test('Transport - constructor initializes ID', () => {
	const transport = new MockTransport();
	assertExists(transport.id);
	assert(typeof transport.id === 'string');
	// UUID format check
	assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transport.id));
});

Deno.test('Transport - constructor with options', () => {
	const transport = new MockTransport({
		lowBufferBytes: 8192,
		maxChunkBytes: 8192,
		c2cSymbol: Symbol('c2c'),
		tcc: { lowBufferBytes: 4096, maxChunkBytes: 4096 },
		c2c: { lowBufferBytes: 2048, maxChunkBytes: 2048 }
	});

	assertEquals(transport.maxChunkBytes, 8192);
	assertExists(transport.logChannelId);
	assert(typeof transport.logChannelId === 'symbol');
});

// Tests for lifecycle management
Deno.test('Transport - start changes state', async () => {
	const transport = new MockTransport();
	const _thys = transport.getProtectedState();

	assertEquals(transport.state, Transport.STATE_CREATED);
	assertEquals(transport.stateString, 'created');

	const startPromise = transport.start();
	assertEquals(transport.state, Transport.STATE_STARTING);
	assertEquals(transport.stateString, 'starting');

	// Trigger remote config to complete startup
	// Use transportId that's different from local id
	await transport.triggerRemoteConfig({
		transportId: _thys.id + 'z', // Lexically greater
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});

	await startPromise;
	assertEquals(transport.state, Transport.STATE_ACTIVE);
	assertEquals(transport.stateString, 'active');
});

Deno.test('Transport - start returns same promise if already starting', async () => {
	const transport = new MockTransport();
	const _thys = transport.getProtectedState();

	const promise1 = transport.start();
	const promise2 = transport.start();

	assertEquals(promise1, promise2);

	// Complete startup
	await transport.triggerRemoteConfig({
		transportId: _thys.id + 'z',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});

	await promise1;
});

Deno.test('Transport - start throws if stopped', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});

	await startPromise;
	const _thys = transport.getProtectedState();
	await transport.stop(_thys);

	await assertRejects(
		async () => await transport.start(),
		StateError,
		'Transport is unavailable'
	);
});

Deno.test('Transport - stop changes state', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	const stopPromise = transport.stop(_thys);

	assertEquals(transport.state, Transport.STATE_STOPPING);
	assertEquals(transport.stateString, 'stopping');

	await stopPromise;

	assertEquals(transport.state, Transport.STATE_STOPPED);
	assertEquals(transport.stateString, 'stopped');
});

Deno.test('Transport - stop is idempotent', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	await transport.stop(_thys);
	await transport.stop(_thys); // Should not throw

	assertEquals(transport.state, Transport.STATE_STOPPED);
});

Deno.test('Transport - stop emits beforeStopping and stopped events', async () => {
	const transport = new MockTransport();
	const events = [];

	transport.addEventListener('beforeStopping', (event) => {
		events.push('beforeStopping');
	});

	transport.addEventListener('stopped', (event) => {
		events.push('stopped');
	});

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	await transport.stop(_thys);

	assertEquals(events, ['beforeStopping', 'stopped']);
});

// Tests for channel management
Deno.test('Transport - getChannel returns undefined for non-existent channel', () => {
	const transport = new MockTransport();

	const channel = transport.getChannel('non-existent');
	assertEquals(channel, undefined);
});

Deno.test('Transport - getChannel only accepts string or symbol', () => {
	const transport = new MockTransport();

	// Numeric IDs should not be accessible via public API
	assertEquals(transport.getChannel(123), undefined);
	assertEquals(transport.getChannel(null), undefined);
	assertEquals(transport.getChannel({}), undefined);
});

Deno.test('Transport - requestChannel throws if not active', async () => {
	const transport = new MockTransport();

	await assertRejects(
		() => transport.requestChannel('test-channel'),
		StateError,
		'Transport is not active'
	);
});

// Tests for onRemoteConfig
Deno.test('Transport - onRemoteConfig determines EVEN role', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();

	const _thys = transport.getProtectedState();
	const localId = _thys.id;

	// Remote ID is greater, so we should be EVEN
	await transport.triggerRemoteConfig({
		transportId: localId + 'z', // Lexically greater
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	assertEquals(_thys.role, Transport.ROLE_EVEN);
});

Deno.test('Transport - onRemoteConfig determines ODD role', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();

	const _thys = transport.getProtectedState();
	const localId = _thys.id;

	// Remote ID is lesser, so we should be ODD
	await transport.triggerRemoteConfig({
		transportId: '00000000-0000-0000-0000-000000000000', // Lexically lesser
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	assertEquals(_thys.role, Transport.ROLE_ODD);
});

Deno.test('Transport - onRemoteConfig throws on same transport ID', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();

	const _thys = transport.getProtectedState();
	const localId = _thys.id;

	await assertRejects(
		async () => {
			await transport.triggerRemoteConfig({
				transportId: localId, // Same ID
				minChannelId: 1024,
				minMessageTypeId: 1024,
				c2cEnabled: false
			});
			await startPromise;
		},
		Error,
		'Received own transport ID in remote config'
	);
});

Deno.test('Transport - onRemoteConfig negotiates minimum IDs', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();

	const _thys = transport.getProtectedState();

	// Remote has higher minimums
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 2048,
		minMessageTypeId: 2048,
		c2cEnabled: false
	});
	await startPromise;

	assertEquals(_thys.minChannelId, 2048);
	assertEquals(_thys.minMessageTypeId, 2048);
});

Deno.test('Transport - onRemoteConfig creates TCC channel', async () => {
	const transport = new MockTransport();

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	const tcc = _thys.channels.get(0); // CHANNEL_TCC = 0

	assertExists(tcc);
	assertEquals(tcc.constructor.name, 'ControlChannel');
});

Deno.test('Transport - onRemoteConfig creates C2C channel if mutually enabled', async () => {
	const transport = new MockTransport({ c2cSymbol: Symbol('c2c') });

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: true
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	const c2c = _thys.channels.get(1); // CHANNEL_C2C = 1

	assertExists(c2c);
	assertEquals(c2c.constructor.name, 'Con2Channel');
});

Deno.test('Transport - onRemoteConfig does not create C2C if not mutually enabled', async () => {
	const transport = new MockTransport({ c2cSymbol: Symbol('c2c') });

	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false // Remote disabled
	});
	await startPromise;

	const _thys = transport.getProtectedState();
	const c2c = _thys.channels.get(1);

	assertEquals(c2c, undefined);
});

// Tests for properties
Deno.test('Transport - needsEncodedText defaults to true', () => {
	const transport = new MockTransport();
	assertEquals(transport.needsEncodedText, true);
});

Deno.test('Transport - logChannelId returns symbol', () => {
	const transport = new MockTransport();
	const logId = transport.logChannelId;
	assert(typeof logId === 'symbol');
});

// Tests for dispatchEvent
Deno.test('Transport - dispatchEvent with string type', async () => {
	const transport = new MockTransport();
	let received = null;

	transport.addEventListener('testEvent', (event) => {
		received = event;
	});

	await transport.dispatchEvent('testEvent', { data: 'test' });

	assertExists(received);
	assertEquals(received.type, 'testEvent');
	assertEquals(received.detail.data, 'test');
});

Deno.test('Transport - dispatchEvent with event object', async () => {
	const transport = new MockTransport();
	let received = null;

	transport.addEventListener('testEvent', (event) => {
		received = event;
	});

	const eventObj = { type: 'testEvent', detail: { data: 'test' } };
	await transport.dispatchEvent(eventObj);

	assertExists(received);
	assertEquals(received.type, 'testEvent');
	assertEquals(received.detail.data, 'test');
});

// Tests for error classes
Deno.test('StateError', () => {
	const error = new StateError();
	assertEquals(error.name, 'StateError');
	assertEquals(error.message, 'Wrong state for request');

	const customError = new StateError('Custom state error', { state: 'invalid' });
	assertEquals(customError.message, 'Custom state error');
	assertEquals(customError.details.state, 'invalid');
});

// Helper to start a MockTransport and complete the handshake
async function startMockTransport (options = {}) {
	const transport = new MockTransport(options);
	const _thys = transport.getProtectedState();
	const startPromise = transport.start();
	await transport.triggerRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;
	return { transport, _thys };
}

// Tests for disconnected transport
Deno.test('Transport - STATE_DISCONNECTED constant is 7', () => {
	assertEquals(Transport.STATE_DISCONNECTED, 7);
});

Deno.test('Transport - stateString includes disconnected', () => {
	const transport = new MockTransport();
	const _thys = transport.getProtectedState();
	_thys.state = Transport.STATE_DISCONNECTED;
	assertEquals(transport.stateString, 'disconnected');
});

Deno.test('Transport - stop({ disconnected: true }) from STATE_ACTIVE transitions to STATE_DISCONNECTED', async () => {
	const { transport } = await startMockTransport();

	assertEquals(transport.state, Transport.STATE_ACTIVE);
	await transport.stop({ disconnected: true });
	assertEquals(transport.state, Transport.STATE_DISCONNECTED);
	assertEquals(transport.stateString, 'disconnected');
});

Deno.test('Transport - stop({ disconnected: true }) emits disconnected then stopped events', async () => {
	const { transport } = await startMockTransport();
	const events = [];

	transport.addEventListener('disconnected', () => events.push('disconnected'));
	transport.addEventListener('stopped', () => events.push('stopped'));
	transport.addEventListener('beforeStopping', () => events.push('beforeStopping'));

	await transport.stop({ disconnected: true });

	// disconnected fires before stopped; beforeStopping is NOT emitted
	assertEquals(events, ['disconnected', 'stopped']);
});

Deno.test('Transport - stop({ disconnected: true }) from STATE_STOPPED is a no-op', async () => {
	const { transport } = await startMockTransport();

	await transport.stop();
	assertEquals(transport.state, Transport.STATE_STOPPED);

	// Should not throw or change state
	await transport.stop({ disconnected: true });
	assertEquals(transport.state, Transport.STATE_STOPPED);
});

Deno.test('Transport - stop({ disconnected: true }) from STATE_DISCONNECTED is a no-op', async () => {
	const { transport } = await startMockTransport();

	await transport.stop({ disconnected: true });
	assertEquals(transport.state, Transport.STATE_DISCONNECTED);

	// Second call should be a no-op
	await transport.stop({ disconnected: true });
	assertEquals(transport.state, Transport.STATE_DISCONNECTED);
});

Deno.test('Transport - stop({ disconnected: true }) rejects pending channel requests', async () => {
	const { transport, _thys } = await startMockTransport();

	// Manually add a pending channel request (without actually sending TCC message)
	const request = { options: {} };
	let rejected = null;
	request.promise = new Promise((resolve, reject) => {
		request.resolve = resolve;
		request.reject = reject;
	});
	_thys.pendingChannelRequests.set('test-channel', request);

	// Disconnect
	const disconnectPromise = transport.stop({ disconnected: true });

	// The pending request should be rejected
	try {
		await request.promise;
	} catch (err) {
		rejected = err;
	}

	await disconnectPromise;
	assertEquals(rejected, 'Disconnected');
});

Deno.test('Transport - stop({ disconnected: true }) from STATE_STOPPING rejects prior stopped promise', async () => {
	const { transport, _thys } = await startMockTransport();

	// Start a graceful stop but don't let it complete (no TCC)
	// We'll manually set state to STOPPING and create a stopped promise
	_thys.state = Transport.STATE_STOPPING;
	const priorStopped = _thys.stopped = { promise: null };
	let priorRejected = null;
	priorStopped.promise = new Promise((resolve, reject) => {
		priorStopped.resolve = resolve;
		priorStopped.reject = reject;
	});

	// Now disconnect
	const disconnectPromise = transport.stop({ disconnected: true });

	// Prior stopped promise should be rejected
	try {
		await priorStopped.promise;
	} catch (err) {
		priorRejected = err;
	}

	await disconnectPromise;
	assertEquals(priorRejected, 'Disconnected');
	assertEquals(transport.state, Transport.STATE_DISCONNECTED);
});

Deno.test('Transport - requestChannel throws StateError for STATE_DISCONNECTED channel', async () => {
	const { transport, _thys } = await startMockTransport();

	// Manually add a disconnected channel record
	_thys.channels.set('test-channel', { state: 'disconnected', name: 'test-channel', id: 1024 });

	await assertRejects(
		() => transport.requestChannel('test-channel'),
		StateError,
		'was disconnected and cannot be reopened'
	);
});

Deno.test('Transport - onDisconnect protected method calls stop({ disconnected: true })', async () => {
	const { transport, _thys } = await startMockTransport();

	assertEquals(transport.state, Transport.STATE_ACTIVE);

	// Call onDisconnect via protected state
	await _thys.onDisconnect();

	assertEquals(transport.state, Transport.STATE_DISCONNECTED);
});
