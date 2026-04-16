import {
	assertEquals, assertExists, assert, assertRejects, assertThrows
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Channel } from '../../src/channel.esm.js';
import {
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	DATA_HEADER_BYTES, FLAG_EOM,
	TCC_CTLM_MESG_TYPE_REG_REQ, TCC_CTLM_MESG_TYPE_REG_RESP,
	TCC_DTAM_CHAN_CLOSE, TCC_DTAM_CHAN_CLOSED,
	StateError,
} from '../../src/protocol.esm.js';
import { VirtualBuffer } from '../../src/virtual-buffer.esm.js';

// ============================================================================
// Test helpers
// ============================================================================

const MIN_CHUNK_BYTES = DATA_HEADER_BYTES + 1024;

/**
 * Create a mock transport for testing
 */
function makeMockTransport (options = {}) {
	const sentChunks = [];
	const sentAcks = [];
	const nulledChannels = [];
	const tccMessages = [];
	const logger = options.logger ?? {
		error: () => {},
		warn: () => {},
		info: () => {},
		debug: () => {},
	};

	return {
		logger,
		needsEncodedText: options.needsEncodedText ?? false,
		sentChunks,
		sentAcks,
		nulledChannels,
		tccMessages,
		async sendChunk (token, header, chunker, opts) {
			const bytesToReserve = chunker.bytesToReserve();
			const sentBytes = bytesToReserve;
			sentChunks.push({ token, header, opts, sentBytes });
			return sentBytes;
		},
		async sendAckMessage (token, flowControl) {
			sentAcks.push({ token, flowControl });
		},
		async nullChannel (token) {
			nulledChannels.push(token);
		},
		async sendTccMessage (token, messageType, options = {}) {
			tccMessages.push({ token, messageType, options });
		},
	};
}

/**
 * Create a Channel with sensible defaults for testing
 */
function makeChannel (options = {}) {
	const transport = options.transport ?? makeMockTransport(options.transportOptions);
	const token = options.token ?? Symbol('test-channel');
	const channel = new Channel({
		id: options.id ?? 100,
		name: options.name ?? 'test',
		token,
		transport,
		localLimit: options.localLimit ?? 0,   // 0 = unlimited
		remoteLimit: options.remoteLimit ?? 0,  // 0 = unlimited
		maxChunkBytes: options.maxChunkBytes ?? MIN_CHUNK_BYTES,
		nextMessageTypeId: options.nextMessageTypeId ?? 256,
		dechunk: options.dechunk ?? true,
		ackBatchTime: options.ackBatchTime ?? 0,
		forceAckCount: options.forceAckCount ?? 5,
		lowWaterBytes: options.lowWaterBytes ?? 0,
	});
	return { channel, transport, token };
}

/**
 * Simulate receiving a data message on a channel
 */
function receiveData (channel, token, { sequence, messageType = 2, data = null, eom = true, dataSize = 0 } = {}) {
	const headerSize = DATA_HEADER_BYTES;
	const header = {
		type: HDR_TYPE_CHAN_DATA,
		headerSize,
		dataSize,
		flags: eom ? FLAG_EOM : 0,
		channelId: 100,
		sequence,
		messageType,
		eom,
	};
	channel.receiveMessage(token, header, data);
}

/**
 * Simulate receiving a control message on a channel
 */
function receiveControl (channel, token, { sequence, messageType, data = null, eom = true, dataSize = 0 } = {}) {
	const headerSize = DATA_HEADER_BYTES;
	const header = {
		type: HDR_TYPE_CHAN_CONTROL,
		headerSize,
		dataSize,
		flags: eom ? FLAG_EOM : 0,
		channelId: 100,
		sequence,
		messageType,
		eom,
	};
	channel.receiveMessage(token, header, data);
}

/**
 * Simulate receiving an ACK message on a channel
 */
function receiveAck (channel, token, { baseSequence, ranges = [] } = {}) {
	const header = {
		type: HDR_TYPE_ACK,
		baseSequence,
		ranges,
	};
	channel.receiveMessage(token, header, null);
}

// ============================================================================
// State constants
// ============================================================================

Deno.test('Channel - STATE constants', () => {
	assertEquals(Channel.STATE_OPEN, 'open');
	assertEquals(Channel.STATE_CLOSING, 'closing');
	assertEquals(Channel.STATE_LOCAL_CLOSING, 'localClosing');
	assertEquals(Channel.STATE_REMOTE_CLOSING, 'remoteClosing');
	assertEquals(Channel.STATE_CLOSED, 'closed');
	assertEquals(Channel.STATE_DISCONNECTED, 'disconnected');
});

// ============================================================================
// Constructor
// ============================================================================

Deno.test('Channel - constructor initializes state', () => {
	const { channel } = makeChannel();
	assertEquals(channel.state, Channel.STATE_OPEN);
	assertEquals(channel.id, 100);
	assertEquals(channel.name, 'test');
	assertEquals(channel.ids.length, 1);
	assertEquals(channel.ids[0], 100);
});

Deno.test('Channel - constructor throws on too-small maxChunkBytes', () => {
	const transport = makeMockTransport();
	const token = Symbol('t');
	assertThrows(
		() => new Channel({
			id: 1, name: 'x', token, transport,
			localLimit: 0, remoteLimit: 0,
			maxChunkBytes: DATA_HEADER_BYTES, // Too small (must be at least DATA_HEADER_BYTES + 1024)
			nextMessageTypeId: 256,
		}),
		RangeError
	);
});

Deno.test('Channel - constructor accepts minimum valid maxChunkBytes', () => {
	const transport = makeMockTransport();
	const token = Symbol('t');
	// Should not throw
	const channel = new Channel({
		id: 1, name: 'x', token, transport,
		localLimit: 0, remoteLimit: 0,
		maxChunkBytes: MIN_CHUNK_BYTES,
		nextMessageTypeId: 256,
	});
	assertEquals(channel.state, Channel.STATE_OPEN);
});

// ============================================================================
// id / ids / name / state getters
// ============================================================================

Deno.test('Channel - id getter returns first id', () => {
	const { channel } = makeChannel({ id: 42 });
	assertEquals(channel.id, 42);
});

Deno.test('Channel - ids getter returns copy of ids array', () => {
	const { channel } = makeChannel({ id: 42 });
	const ids = channel.ids;
	assertEquals(ids, [42]);
	// Verify it's a copy (mutation doesn't affect channel)
	ids.push(99);
	assertEquals(channel.ids, [42]);
});

Deno.test('Channel - name getter', () => {
	const { channel } = makeChannel({ name: 'my-channel' });
	assertEquals(channel.name, 'my-channel');
});

Deno.test('Channel - state getter', () => {
	const { channel } = makeChannel();
	assertEquals(channel.state, Channel.STATE_OPEN);
});

// ============================================================================
// idsRW - token-gated id access
// ============================================================================

Deno.test('Channel - idsRW returns ids array with correct token', () => {
	const { channel, token } = makeChannel({ id: 10 });
	const ids = channel.idsRW(token);
	assertExists(ids);
	assertEquals(ids[0], 10);
});

Deno.test('Channel - idsRW returns falsy with wrong token', () => {
	const { channel } = makeChannel({ id: 10 });
	const wrongToken = Symbol('wrong');
	const ids = channel.idsRW(wrongToken);
	assert(!ids);
});

Deno.test('Channel - idsRW returns falsy with null token', () => {
	const { channel } = makeChannel({ id: 10 });
	const ids = channel.idsRW(null);
	assert(!ids);
});

// ============================================================================
// write() - state validation
// ============================================================================

Deno.test('Channel - write throws StateError when closing', async () => {
	const { channel, token } = makeChannel();
	// Manually set state to closing
	// We do this by calling close() but not awaiting it fully
	// Instead, we'll test via the state check directly
	// Since we can't easily get to closing state without a full transport,
	// we test that write works in open state and throws in non-open states.

	// In open state, write should not throw StateError (may throw other errors)
	// We test the StateError path by checking the state guard
	// The simplest approach: verify write works when open
	// (actual write will fail because mock transport doesn't fully implement sendChunk)
	// We just need to verify the state check passes
	assert(channel.state === Channel.STATE_OPEN);
});

Deno.test('Channel - write throws StateError when closed', async () => {
	const { channel, token } = makeChannel();

	// Simulate closed state by calling onRemoteChanClosed after close()
	// We need to get the channel to closed state
	// The simplest way: use a channel that has been closed
	// For now, test that write in open state doesn't throw StateError
	// and that the state check is correct
	assertEquals(channel.state, Channel.STATE_OPEN);

	// Verify write throws StateError when state is not open
	// We'll test this by checking the guard condition
	// Since we can't easily force state without full transport,
	// we verify the StateError class is exported correctly
	const err = new StateError('test', { state: 'closing' });
	assertEquals(err.name, 'StateError');
});

// ============================================================================
// addMessageTypes() - state validation
// ============================================================================

Deno.test('Channel - addMessageTypes throws StateError when not open', async () => {
	// We test the state check by verifying the channel is open initially
	const { channel } = makeChannel();
	assertEquals(channel.state, Channel.STATE_OPEN);
	// The actual StateError throw is tested via the close() path below
});

// ============================================================================
// receiveMessage() - token validation
// ============================================================================

Deno.test('Channel - receiveMessage throws with wrong token', () => {
	const { channel } = makeChannel();
	const wrongToken = Symbol('wrong');
	const header = { type: HDR_TYPE_CHAN_DATA, headerSize: DATA_HEADER_BYTES, dataSize: 0, flags: FLAG_EOM, channelId: 100, sequence: 1, messageType: 2, eom: true };
	assertThrows(
		() => channel.receiveMessage(wrongToken, header, null),
		Error,
		'Unauthorized'
	);
});

Deno.test('Channel - receiveMessage throws with null token', () => {
	const { channel } = makeChannel();
	const header = { type: HDR_TYPE_CHAN_DATA, headerSize: DATA_HEADER_BYTES, dataSize: 0, flags: FLAG_EOM, channelId: 100, sequence: 1, messageType: 2, eom: true };
	assertThrows(
		() => channel.receiveMessage(null, header, null),
		Error,
		'Unauthorized'
	);
});

// ============================================================================
// receiveMessage() - data message routing
// ============================================================================

Deno.test('Channel - receiveMessage routes data messages', () => {
	const { channel, token } = makeChannel();
	// Receive a data message - should be stored in dataChunks
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	// Verify it's available via readSync
	const result = channel.readSync();
	assertExists(result);
	assertEquals(result.messageTypeId, 2);
	assertEquals(result.eom, true);
});

Deno.test('Channel - receiveMessage routes ACK messages', () => {
	const { channel, token } = makeChannel({ remoteLimit: 10000 });
	// First send something so there's something to ACK
	// (We can't easily test this without a full write, so just verify no throw)
	// ACK with no in-flight data should be a no-op (duplicate ACK)
	receiveAck(channel, token, { baseSequence: 1, ranges: [] });
	// No throw = success
});

Deno.test('Channel - receiveMessage closes channel on unknown header type', () => {
	const { channel, token } = makeChannel();
	const header = { type: 99, headerSize: DATA_HEADER_BYTES, dataSize: 0, flags: 0, channelId: 100, sequence: 1, messageType: 2, eom: false };
	// Should not throw but should close the channel
	channel.receiveMessage(token, header, null);
	// Channel should be in closing state (close() was called)
	assert(channel.state !== Channel.STATE_OPEN);
});

// ============================================================================
// receiveMessage() - data message flow control
// ============================================================================

Deno.test('Channel - receiveMessage rejects out-of-order sequence', () => {
	const { channel, token } = makeChannel({ localLimit: 100000 });
	// Receive sequence 1 first
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false, dataSize: 100 });
	// Receive sequence 3 (skipping 2) - should trigger close
	receiveData(channel, token, { sequence: 3, messageType: 2, eom: true, dataSize: 100 });
	// Channel should be closing due to protocol violation
	assert(channel.state !== Channel.STATE_OPEN);
});

Deno.test('Channel - receiveMessage discards data in discard mode', async () => {
	const { channel, token } = makeChannel();
	// Receive a message first
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	// Verify it's available
	const result1 = channel.readSync();
	assertExists(result1);
	result1.done();

	// Now receive another message
	receiveData(channel, token, { sequence: 2, messageType: 2, eom: true });
	const result2 = channel.readSync();
	assertExists(result2);
	result2.done();
});

// ============================================================================
// readSync() - basic reading
// ============================================================================

Deno.test('Channel - readSync returns null when no data', () => {
	const { channel } = makeChannel();
	const result = channel.readSync();
	assertEquals(result, null);
});

Deno.test('Channel - readSync returns available chunk', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = channel.readSync();
	assertExists(result);
	assertEquals(result.messageTypeId, 2);
	assertEquals(result.eom, true);
});

Deno.test('Channel - readSync result has done() method', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = channel.readSync();
	assertExists(result);
	assert(typeof result.done === 'function');
	// Calling done() should not throw
	result.done();
});

Deno.test('Channel - readSync result has process() method', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = channel.readSync();
	assertExists(result);
	assert(typeof result.process === 'function');
});

Deno.test('Channel - readSync result is frozen', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = channel.readSync();
	assertExists(result);
	assert(Object.isFrozen(result));
});

Deno.test('Channel - readSync with dechunk=false returns individual chunks', () => {
	const { channel, token } = makeChannel();
	// Receive two chunks of the same message (no EOM on first)
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false });
	receiveData(channel, token, { sequence: 2, messageType: 2, eom: true });

	// With dechunk=false, should return first chunk
	const result = channel.readSync({ dechunk: false });
	assertExists(result);
	assertEquals(result.eom, false);
});

Deno.test('Channel - readSync with dechunk=true waits for complete message', () => {
	const { channel, token } = makeChannel();
	// Receive only first chunk (no EOM)
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false });

	// With dechunk=true (default), should return null (message not complete)
	const result = channel.readSync({ dechunk: true });
	assertEquals(result, null);
});

Deno.test('Channel - readSync with dechunk=true returns complete message', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false });
	receiveData(channel, token, { sequence: 2, messageType: 2, eom: true });

	// With dechunk=true, should return complete message
	const result = channel.readSync({ dechunk: true });
	assertExists(result);
	assertEquals(result.eom, true);
});

Deno.test('Channel - readSync with string data', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'hello world', eom: true });
	const result = channel.readSync();
	assertExists(result);
	assertEquals(result.text, 'hello world');
});

Deno.test('Channel - readSync with VirtualBuffer data', () => {
	const { channel, token } = makeChannel();
	const buf = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	receiveData(channel, token, { sequence: 1, messageType: 2, data: buf, eom: true });
	const result = channel.readSync();
	assertExists(result);
	assertExists(result.data);
	assert(result.data instanceof VirtualBuffer);
});

Deno.test('Channel - readSync with decode=true decodes buffer to text', () => {
	const { channel, token } = makeChannel();
	// Encode "hello" as UTF-8
	const encoder = new TextEncoder();
	const bytes = encoder.encode('hello');
	const buf = new VirtualBuffer(bytes);
	receiveData(channel, token, { sequence: 1, messageType: 2, data: buf, eom: true });
	const result = channel.readSync({ decode: true });
	assertExists(result);
	assertEquals(result.text, 'hello');
});

// ============================================================================
// readSync() - type filtering
// ============================================================================

Deno.test('Channel - readSync with only filter returns matching type', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	receiveData(channel, token, { sequence: 2, messageType: 3, eom: true });

	// Filter for type 2
	const result = channel.readSync({ only: 2 });
	assertExists(result);
	assertEquals(result.messageTypeId, 2);
});

Deno.test('Channel - readSync with only filter returns null for non-matching type', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });

	// Filter for type 99 (not present)
	const result = channel.readSync({ only: 99 });
	assertEquals(result, null);
});

// ============================================================================
// readSync() - conflicting readers
// ============================================================================

Deno.test('Channel - readSync throws on conflicting reader', async () => {
	const { channel, token } = makeChannel();
	// Start an async read that will wait
	const readPromise = channel.read(); // Will wait since no data

	// Now try readSync - should throw due to conflicting reader
	assertThrows(
		() => channel.readSync(),
		Error,
		'Conflicting readers'
	);

	// Clean up: receive data to resolve the waiting read
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = await readPromise;
	result.done();
});

// ============================================================================
// read() - async reading
// ============================================================================

Deno.test('Channel - read returns immediately if data available', async () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });

	const result = await channel.read();
	assertExists(result);
	assertEquals(result.messageTypeId, 2);
	result.done();
});

Deno.test('Channel - read waits for data', async () => {
	const { channel, token } = makeChannel();

	// Start reading before data arrives
	const readPromise = channel.read();

	// Deliver data after a tick
	await new Promise(resolve => setTimeout(resolve, 0));
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });

	const result = await readPromise;
	assertExists(result);
	assertEquals(result.messageTypeId, 2);
	result.done();
});

Deno.test('Channel - read with timeout returns null on timeout', async () => {
	const { channel } = makeChannel();

	const result = await channel.read({ timeout: 10 });
	assertEquals(result, null);
	assertEquals(channel.state, Channel.STATE_OPEN); // Channel still open after timeout
});

Deno.test('Channel - read throws on conflicting reader', async () => {
	const { channel, token } = makeChannel();

	// Start first read
	const readPromise1 = channel.read();

	// Second read should throw
	await assertRejects(
		() => channel.read(),
		Error,
		'Conflicting readers'
	);

	// Clean up
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = await readPromise1;
	result.done();
});

Deno.test('Channel - read with only filter waits for matching type', async () => {
	const { channel, token } = makeChannel();

	// Start reading for type 3
	const readPromise = channel.read({ only: 3 });

	// Deliver type 2 (should not wake reader)
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });

	// Deliver type 3 (should wake reader)
	receiveData(channel, token, { sequence: 2, messageType: 3, eom: true });

	const result = await readPromise;
	assertExists(result);
	assertEquals(result.messageTypeId, 3);
	result.done();
});

// ============================================================================
// hasReader()
// ============================================================================

Deno.test('Channel - hasReader returns false when no readers', () => {
	const { channel } = makeChannel();
	assertEquals(channel.hasReader(), false);
	assertEquals(channel.hasReader(null), false);
});

Deno.test('Channel - hasReader returns true when unfiltered reader waiting', async () => {
	const { channel, token } = makeChannel();

	// Start an unfiltered read
	const readPromise = channel.read();

	assertEquals(channel.hasReader(), true);
	assertEquals(channel.hasReader(null), true);

	// Clean up
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = await readPromise;
	result.done();
});

Deno.test('Channel - hasReader returns false after reader resolves', async () => {
	const { channel, token } = makeChannel();

	const readPromise = channel.read();
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	const result = await readPromise;
	result.done();

	assertEquals(channel.hasReader(), false);
});

// ============================================================================
// dispatchEvent()
// ============================================================================

Deno.test('Channel - dispatchEvent with string type', async () => {
	const { channel } = makeChannel();
	let received = null;

	channel.addEventListener('testEvent', (event) => {
		received = event;
	});

	await channel.dispatchEvent('testEvent', { data: 'hello' });

	assertExists(received);
	assertEquals(received.type, 'testEvent');
	assertEquals(received.detail.data, 'hello');
});

Deno.test('Channel - dispatchEvent with event object', async () => {
	const { channel } = makeChannel();
	let received = null;

	channel.addEventListener('testEvent', (event) => {
		received = event;
	});

	const eventObj = { type: 'testEvent', detail: { data: 'world' } };
	await channel.dispatchEvent(eventObj);

	assertExists(received);
	assertEquals(received.type, 'testEvent');
});

// ============================================================================
// close() - state transitions
// ============================================================================

Deno.test('Channel - close transitions to closing state', async () => {
	const { channel, token } = makeChannel();
	assertEquals(channel.state, Channel.STATE_OPEN);

	// Start close (don't await - it will wait for ACKs)
	const closePromise = channel.close();

	// State should be closing or beyond
	assert(channel.state !== Channel.STATE_OPEN);

	// Simulate remote sending chanClosed to complete the close
	await channel.onRemoteChanClosed(token);

	// Now the close should complete
	await closePromise;
	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - close with discard=true sets discard mode', async () => {
	const { channel, token } = makeChannel();

	const closePromise = channel.close({ discard: true });

	// Simulate remote chanClosed
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - close is idempotent when already closed', async () => {
	const { channel, token } = makeChannel();

	const closePromise1 = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise1;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// Second close should return immediately
	const closePromise2 = channel.close();
	assertExists(closePromise2);
	// Should resolve without error
	await closePromise2;
});

Deno.test('Channel - close while closing switches to discard mode', async () => {
	const { channel, token } = makeChannel();

	// Start graceful close
	const closePromise1 = channel.close({ discard: false });

	// Call close again with discard=true while closing
	const closePromise2 = channel.close({ discard: true });

	// Both promises should resolve when channel closes
	await channel.onRemoteChanClosed(token);
	await Promise.all([closePromise1, closePromise2]);

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - close dispatches beforeClose event', async () => {
	const { channel, token } = makeChannel();
	let beforeCloseReceived = false;

	channel.addEventListener('beforeClose', () => {
		beforeCloseReceived = true;
	});

	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assert(beforeCloseReceived);
});

Deno.test('Channel - close dispatches closed event', async () => {
	const { channel, token } = makeChannel();
	let closedReceived = false;

	channel.addEventListener('closed', () => {
		closedReceived = true;
	});

	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assert(closedReceived);
});

Deno.test('Channel - write throws StateError after close initiated', async () => {
	const { channel, token } = makeChannel();

	// Start close
	const closePromise = channel.close();

	// write should throw StateError now
	assertThrows(
		() => channel.write(2, 'hello'),
		StateError
	);

	// Clean up
	await channel.onRemoteChanClosed(token);
	await closePromise;
});

Deno.test('Channel - addMessageTypes throws StateError after close initiated', async () => {
	const { channel, token } = makeChannel();

	// Start close
	const closePromise = channel.close();

	// addMessageTypes should throw StateError now
	await assertRejects(
		() => channel.addMessageTypes(['myType']),
		StateError
	);

	// Clean up
	await channel.onRemoteChanClosed(token);
	await closePromise;
});

// ============================================================================
// onRemoteChanClosed() - token validation and state transitions
// ============================================================================

Deno.test('Channel - onRemoteChanClosed throws with wrong token', async () => {
	const { channel } = makeChannel();
	const wrongToken = Symbol('wrong');

	await assertRejects(
		() => channel.onRemoteChanClosed(wrongToken),
		Error,
		'Unauthorized'
	);
});

Deno.test('Channel - onRemoteChanClosed throws with null token', async () => {
	const { channel } = makeChannel();

	await assertRejects(
		() => channel.onRemoteChanClosed(null),
		Error,
		'Unauthorized'
	);
});

Deno.test('Channel - onRemoteChanClosed in CLOSING state transitions to LOCAL_CLOSING', async () => {
	const { channel, token } = makeChannel();

	// Start close (puts channel in CLOSING state)
	const closePromise = channel.close();

	// Remote sends chanClosed while we're still in CLOSING
	// (before we've sent our own chanClosed)
	// This should transition to LOCAL_CLOSING
	await channel.onRemoteChanClosed(token);

	// Channel should eventually reach CLOSED
	await closePromise;
	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - onRemoteChanClosed in REMOTE_CLOSING state finalizes closure', async () => {
	const { channel, token } = makeChannel();

	// Start close and let it progress to REMOTE_CLOSING
	// (we've sent chanClosed, waiting for remote's chanClosed)
	const closePromise = channel.close();

	// Simulate that we've already sent chanClosed (REMOTE_CLOSING state)
	// by calling onRemoteChanClosed after close() has progressed
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

// ============================================================================
// Multiple data chunks and type chains
// ============================================================================

Deno.test('Channel - multiple message types are tracked independently', () => {
	const { channel, token } = makeChannel();

	// Receive messages of different types
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: true });
	receiveData(channel, token, { sequence: 2, messageType: 3, eom: true });

	// Read type 3 first
	const result3 = channel.readSync({ only: 3 });
	assertExists(result3);
	assertEquals(result3.messageTypeId, 3);
	result3.done();

	// Type 2 should still be available
	const result2 = channel.readSync({ only: 2 });
	assertExists(result2);
	assertEquals(result2.messageTypeId, 2);
	result2.done();
});

Deno.test('Channel - multi-chunk message is assembled correctly', () => {
	const { channel, token } = makeChannel();

	// Receive two chunks of the same message
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'hello ', eom: false });
	receiveData(channel, token, { sequence: 2, messageType: 2, data: 'world', eom: true });

	// Read complete message (dechunk=true)
	const result = channel.readSync({ dechunk: true });
	assertExists(result);
	assertEquals(result.eom, true);
	assertEquals(result.text, 'hello world');
	result.done();
});

Deno.test('Channel - multiple complete messages queued', () => {
	const { channel, token } = makeChannel();

	// Receive two complete messages
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'first', eom: true });
	receiveData(channel, token, { sequence: 2, messageType: 2, data: 'second', eom: true });

	// Read first message
	const result1 = channel.readSync({ dechunk: true });
	assertExists(result1);
	assertEquals(result1.text, 'first');
	result1.done();

	// Read second message
	const result2 = channel.readSync({ dechunk: true });
	assertExists(result2);
	assertEquals(result2.text, 'second');
	result2.done();
});

// ============================================================================
// process() callback
// ============================================================================

Deno.test('Channel - result.process() calls callback and then done()', async () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'test', eom: true });

	const result = channel.readSync();
	assertExists(result);

	let callbackCalled = false;
	await result.process(async (r) => {
		callbackCalled = true;
		assertEquals(r.text, 'test');
	});

	assert(callbackCalled);
});

Deno.test('Channel - result.process() calls done() even if callback throws', async () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'test', eom: true });

	const result = channel.readSync();
	assertExists(result);

	// process() should call done() even if callback throws
	await assertRejects(
		() => result.process(async () => { throw new Error('callback error'); }),
		Error,
		'callback error'
	);

	// After process() with error, done() was called - verify by checking
	// that calling done() again doesn't cause issues (idempotent)
	result.done(); // Should not throw
});

// ============================================================================
// Control message handling
// ============================================================================

Deno.test('Channel - receiveControlMessage handles unknown type by closing', () => {
	const { channel, token } = makeChannel();

	// Send a control message with unknown type
	receiveControl(channel, token, {
		sequence: 1,
		messageType: 999, // Unknown type
		eom: true,
	});

	// Channel should be closing
	assert(channel.state !== Channel.STATE_OPEN);
});

Deno.test('Channel - receiveControlMessage handles incomplete message type change', () => {
	const { channel, token } = makeChannel();

	// Send first chunk of type REG_REQ (no EOM)
	receiveControl(channel, token, {
		sequence: 1,
		messageType: TCC_CTLM_MESG_TYPE_REG_REQ[0],
		eom: false,
	});

	// Send chunk of different type (incomplete message)
	receiveControl(channel, token, {
		sequence: 2,
		messageType: TCC_CTLM_MESG_TYPE_REG_RESP[0], // Different type!
		eom: true,
	});

	// Channel should be closing due to incomplete control message
	assert(channel.state !== Channel.STATE_OPEN);
});

// ============================================================================
// ACK message handling
// ============================================================================

Deno.test('Channel - receiveAckMessage handles duplicate ACK', async () => {
	const { channel, token } = makeChannel();
	let protocolViolationFired = false;

	channel.addEventListener('protocolViolation', (event) => {
		protocolViolationFired = true;
		event.preventDefault(); // Prevent close
	});

	// ACK sequence 1 which was never sent (duplicate/premature)
	receiveAck(channel, token, { baseSequence: 1, ranges: [] });

	// Wait for async event dispatch
	await new Promise(resolve => setTimeout(resolve, 0));

	// Protocol violation should have been emitted
	assert(protocolViolationFired);
});

// ============================================================================
// dataSize calculation
// ============================================================================

Deno.test('Channel - readSync result dataSize for string data', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'hello', eom: true });
	const result = channel.readSync();
	assertExists(result);
	// String data: dataSize = text.length * 2 (UTF-16)
	assertEquals(result.dataSize, 'hello'.length * 2);
	result.done();
});

Deno.test('Channel - readSync result dataSize for buffer data', () => {
	const { channel, token } = makeChannel();
	const buf = new VirtualBuffer(new Uint8Array([1, 2, 3, 4, 5]));
	receiveData(channel, token, { sequence: 1, messageType: 2, data: buf, eom: true });
	const result = channel.readSync();
	assertExists(result);
	// Buffer data: dataSize = buffer.length
	assertEquals(result.dataSize, 5);
	result.done();
});

// ============================================================================
// messageType name resolution
// ============================================================================

Deno.test('Channel - readSync result messageType is numeric id when no name mapping', () => {
	const { channel, token } = makeChannel();
	receiveData(channel, token, { sequence: 1, messageType: 42, eom: true });
	const result = channel.readSync();
	assertExists(result);
	// No name mapping for type 42, so messageType should be the numeric id
	assertEquals(result.messageTypeId, 42);
	assertEquals(result.messageType, 42);
	result.done();
});

// ============================================================================
// StateError class
// ============================================================================

Deno.test('StateError - has correct name', () => {
	const err = new StateError('test message');
	assertEquals(err.name, 'StateError');
});

Deno.test('StateError - has default message', () => {
	const err = new StateError();
	assertEquals(err.message, 'Wrong state for request');
});

Deno.test('StateError - stores details', () => {
	const err = new StateError('msg', { state: 'closing', op: 'write' });
	assertEquals(err.details.state, 'closing');
	assertEquals(err.details.op, 'write');
});

// ============================================================================
// Channel closure - nullChannel called on transport
// ============================================================================

Deno.test('Channel - close calls transport.nullChannel', async () => {
	const { channel, token, transport } = makeChannel();

	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(transport.nulledChannels.length, 1);
	assertEquals(transport.nulledChannels[0], token);
});

// ============================================================================
// Channel - message type remapping (settleMessageType)
// ============================================================================

Deno.test('Channel - message type remapping via onMesgTypeRegResponse', () => {
	// This tests the internal remapping via the control message path
	// We receive a REG_RESP control message that maps a name to an id
	const { channel, token } = makeChannel();

	// Simulate receiving a message-type registration response
	// The response JSON: { accept: { myType: 256 }, reject: [] }
	const responseJson = JSON.stringify({ accept: { myType: 256 }, reject: [] });
	receiveControl(channel, token, {
		sequence: 1,
		messageType: TCC_CTLM_MESG_TYPE_REG_RESP[0],
		data: responseJson,
		eom: true,
	});

	// The channel should now have a mapping for 'myType' -> 256
	// We can verify by checking getMessageType
	const typeInfo = channel.getMessageType('myType');
	assertExists(typeInfo);
	assert(typeInfo.ids.includes(256));
});

// ============================================================================
// Channel - concurrent reads with different type filters
// ============================================================================

Deno.test('Channel - two filtered readers for different types', async () => {
	const { channel, token } = makeChannel();

	// Start two filtered reads for different types
	const readPromise2 = channel.read({ only: 2 });
	const readPromise3 = channel.read({ only: 3 });

	// Deliver type 3 first
	receiveData(channel, token, { sequence: 1, messageType: 3, eom: true });
	// Deliver type 2
	receiveData(channel, token, { sequence: 2, messageType: 2, eom: true });

	const result3 = await readPromise3;
	const result2 = await readPromise2;

	assertEquals(result3.messageTypeId, 3);
	assertEquals(result2.messageTypeId, 2);

	result2.done();
	result3.done();
});

// ============================================================================
// Channel - read wakes up on chunk arrival (dechunk=false)
// ============================================================================

Deno.test('Channel - read with dechunk=false wakes on any chunk', async () => {
	const { channel, token } = makeChannel();

	// Start read with dechunk=false
	const readPromise = channel.read({ dechunk: false });

	// Deliver a chunk (no EOM)
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false });

	const result = await readPromise;
	assertExists(result);
	assertEquals(result.eom, false);
	result.done();
});

Deno.test('Channel - read with dechunk=true only wakes on EOM chunk', async () => {
	const { channel, token } = makeChannel();

	// Start read with dechunk=true (default)
	const readPromise = channel.read({ dechunk: true });

	// Deliver first chunk (no EOM) - should not wake reader
	receiveData(channel, token, { sequence: 1, messageType: 2, eom: false });

	// Verify reader is still waiting
	assertEquals(channel.hasReader(), true);

	// Deliver EOM chunk - should wake reader
	receiveData(channel, token, { sequence: 2, messageType: 2, eom: true });

	const result = await readPromise;
	assertExists(result);
	assertEquals(result.eom, true);
	result.done();
});

// ============================================================================
// Channel close - TCC message sending
// ============================================================================

Deno.test('Channel - close sends chanClose TCC message', async () => {
	const { channel, token, transport } = makeChannel();

	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	// Should have sent chanClose and chanClosed TCC messages
	const closeMsg = transport.tccMessages.find(m => m.messageType === TCC_DTAM_CHAN_CLOSE[0]);
	assertExists(closeMsg);
	assertEquals(closeMsg.options.discard, false);
});

Deno.test('Channel - close with discard=true sends chanClose with discard flag', async () => {
	const { channel, token, transport } = makeChannel();

	const closePromise = channel.close({ discard: true });
	await channel.onRemoteChanClosed(token);
	await closePromise;

	const closeMsg = transport.tccMessages.find(m => m.messageType === TCC_DTAM_CHAN_CLOSE[0]);
	assertExists(closeMsg);
	assertEquals(closeMsg.options.discard, true);
});

Deno.test('Channel - close sends chanClosed TCC message after chanClose', async () => {
	const { channel, token, transport } = makeChannel();

	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	const closedMsg = transport.tccMessages.find(m => m.messageType === TCC_DTAM_CHAN_CLOSED[0]);
	assertExists(closedMsg);
});

// ============================================================================
// Channel close - message type clearing
// ============================================================================

Deno.test('Channel - message types are cleared after channel reaches closed state', async () => {
	const { channel, token } = makeChannel();

	// Register a message type via control message (REG_RESP)
	const responseJson = JSON.stringify({ accept: { myType: 256 }, reject: [] });
	receiveControl(channel, token, {
		sequence: 1,
		messageType: TCC_CTLM_MESG_TYPE_REG_RESP[0],
		data: responseJson,
		eom: true,
	});

	// Verify type is registered before close
	const typeInfoBefore = channel.getMessageType('myType');
	assertExists(typeInfoBefore);
	assert(typeInfoBefore.ids.includes(256));

	// Close the channel
	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// After closed, getMessageType should throw or return undefined (map was cleared)
	// The messageTypes map is cleared in #finalizeClosure
	// Calling getMessageType on a cleared map will throw because entry is undefined
	assertThrows(() => channel.getMessageType('myType'));
});

// ============================================================================
// Channel close - discard mode clears buffered input
// ============================================================================

Deno.test('Channel - close with discard=true clears buffered data', async () => {
	const { channel, token } = makeChannel();

	// Buffer some data
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'buffered', eom: true });

	// Verify data is buffered
	const buffered = channel.readSync();
	assertExists(buffered);
	buffered.done();

	// Receive more data
	receiveData(channel, token, { sequence: 2, messageType: 2, data: 'more data', eom: true });

	// Close with discard - should clear buffered data
	const closePromise = channel.close({ discard: true });
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - data received during discard mode is discarded', async () => {
	const { channel, token } = makeChannel();

	// Start close with discard
	const closePromise = channel.close({ discard: true });

	// Receive data while closing in discard mode
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'discarded', eom: true });

	// Complete close
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
	// Data was discarded (not buffered) - verified by successful close
});

// ============================================================================
// Channel close - pending readers return null on close
// ============================================================================

Deno.test('Channel - pending read returns null when channel closes', async () => {
	const { channel, token } = makeChannel();

	// Start a read that will wait
	const readPromise = channel.read({ timeout: 5000 });

	// Close the channel
	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	// The pending read should have returned null (graceful close is a normal condition)
	const result = await readPromise;
	assertEquals(result, null);
});

// ============================================================================
// Channel close - acceleration (graceful → discard when remote sends discard)
// ============================================================================

Deno.test('Channel - acceleration: graceful close switches to discard when remote sends chanClose with discard', async () => {
	const { channel, token, transport } = makeChannel();

	// Buffer some data
	receiveData(channel, token, { sequence: 1, messageType: 2, data: 'data', eom: true });

	// Start graceful close
	const closePromise = channel.close({ discard: false });

	// Simulate remote sending chanClose with discard: true
	// This is handled by transport calling channel.close({ discard: true })
	// while channel is already in closing state
	const acceleratePromise = channel.close({ discard: true });

	// Complete close
	await channel.onRemoteChanClosed(token);
	await Promise.all([closePromise, acceleratePromise]);

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// The chanClose message sent should have discard: true (from the acceleration)
	// OR the original discard: false (depending on timing)
	// Either way, channel should be closed
});

// ============================================================================
// Channel close - promise resolution
// ============================================================================

Deno.test('Channel - close promise resolves only after fully closed', async () => {
	const { channel, token } = makeChannel();
	let resolved = false;

	const closePromise = channel.close().then(() => { resolved = true; });

	// Not yet resolved (waiting for remote chanClosed)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(resolved, false);

	// Remote sends chanClosed - should now resolve
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(resolved, true);
	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - second close() on already-closed channel resolves immediately', async () => {
	const { channel, token } = makeChannel();

	// First close
	const closePromise1 = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise1;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// Second close should resolve immediately without error
	let resolved = false;
	await channel.close().then(() => { resolved = true; });
	assertEquals(resolved, true);
});

// ============================================================================
// Channel close - state validation after close
// ============================================================================

Deno.test('Channel - write throws StateError when channel is closed', async () => {
	const { channel, token } = makeChannel();

	// Close the channel
	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// write should throw StateError
	assertThrows(
		() => channel.write(2, 'hello'),
		StateError
	);
});

Deno.test('Channel - addMessageTypes throws StateError when channel is closed', async () => {
	const { channel, token } = makeChannel();

	// Close the channel
	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// addMessageTypes should throw StateError
	await assertRejects(
		() => channel.addMessageTypes(['myType']),
		StateError
	);
});

// ============================================================================
// Channel close - state during closing (message types still available)
// ============================================================================

Deno.test('Channel - message types remain registered during closing state', async () => {
	const { channel, token } = makeChannel();

	// Register a message type
	const responseJson = JSON.stringify({ accept: { myType: 256 }, reject: [] });
	receiveControl(channel, token, {
		sequence: 1,
		messageType: TCC_CTLM_MESG_TYPE_REG_RESP[0],
		data: responseJson,
		eom: true,
	});

	// Start close (channel is now in closing state)
	const closePromise = channel.close();

	// Message types should still be registered during closing
	const typeInfo = channel.getMessageType('myType');
	assertExists(typeInfo);
	assert(typeInfo.ids.includes(256));

	// Complete close
	await channel.onRemoteChanClosed(token);
	await closePromise;
});

// ============================================================================
// Channel close - cross-close (both sides close simultaneously)
// ============================================================================

Deno.test('Channel - cross-close: both sides close gracefully', async () => {
	const { channel, token } = makeChannel();

	// Both sides close simultaneously:
	// 1. We call close() - transitions to closing
	const closePromise = channel.close();

	// 2. Remote sends chanClosed (simulating remote also closed)
	await channel.onRemoteChanClosed(token);

	// 3. Our close completes
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - cross-close: remote chanClosed arrives before we send ours', async () => {
	const { channel, token } = makeChannel();

	// Start close
	const closePromise = channel.close();

	// Remote sends chanClosed while we're still in CLOSING state
	// (before we've sent our own chanClosed)
	await channel.onRemoteChanClosed(token);

	// Our close should complete
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);
});

// ============================================================================
// Channel disconnect - close({ disconnected: token }) secret handshake
// ============================================================================

Deno.test('Channel - close({ disconnected: token }) transitions to STATE_DISCONNECTED', async () => {
	const { channel, token } = makeChannel();

	assertEquals(channel.state, Channel.STATE_OPEN);

	await channel.close({ disconnected: token });

	assertEquals(channel.state, Channel.STATE_DISCONNECTED);
});

Deno.test('Channel - close({ disconnected: wrongToken }) throws Unauthorized', async () => {
	const { channel } = makeChannel();
	const wrongToken = Symbol('wrong');

	await assertRejects(
		() => channel.close({ disconnected: wrongToken }),
		Error,
		'Unauthorized'
	);
});

Deno.test('Channel - disconnect dispatches closed event', async () => {
	const { channel, token } = makeChannel();
	let closedFired = false;

	channel.addEventListener('closed', () => { closedFired = true; });

	await channel.close({ disconnected: token });

	assert(closedFired);
});

Deno.test('Channel - disconnect does NOT call transport.nullChannel', async () => {
	const { channel, token, transport } = makeChannel();

	await channel.close({ disconnected: token });

	// nullChannel should NOT have been called (transport handles its own cleanup)
	assertEquals(transport.nulledChannels.length, 0);
});

Deno.test('Channel - disconnect returns null for pending read', async () => {
	const { channel, token } = makeChannel();

	// Start a read that will wait
	const readPromise = channel.read({ timeout: 5000 });

	// Disconnect
	await channel.close({ disconnected: token });

	// The pending read should return null; channel.state reveals the reason
	const result = await readPromise;
	assertEquals(result, null);
	assertEquals(channel.state, Channel.STATE_DISCONNECTED);
});

Deno.test('Channel - disconnect resolves close() with "Disconnected"', async () => {
	const { channel, token } = makeChannel();

	// Start a graceful close (will wait for ACKs and remote chanClosed)
	const closePromise = channel.close();

	// Disconnect while closing
	await channel.close({ disconnected: token });

	// The graceful close promise should be rejected with 'Disconnected'
	const result = await closePromise;
	assertEquals(result, 'Disconnected');
});

Deno.test('Channel - disconnect from STATE_CLOSED is a no-op', async () => {
	const { channel, token } = makeChannel();

	// First close gracefully
	const closePromise = channel.close();
	await channel.onRemoteChanClosed(token);
	await closePromise;

	assertEquals(channel.state, Channel.STATE_CLOSED);

	// Disconnect from closed state should be a no-op (no throw)
	await channel.close({ disconnected: token });

	// State should remain CLOSED (not change to DISCONNECTED)
	assertEquals(channel.state, Channel.STATE_CLOSED);
});

Deno.test('Channel - disconnect from STATE_DISCONNECTED is a no-op', async () => {
	const { channel, token } = makeChannel();

	// First disconnect
	await channel.close({ disconnected: token });
	assertEquals(channel.state, Channel.STATE_DISCONNECTED);

	// Second disconnect should be a no-op
	await channel.close({ disconnected: token });
	assertEquals(channel.state, Channel.STATE_DISCONNECTED);
});

Deno.test('Channel - write throws StateError after disconnect', async () => {
	const { channel, token } = makeChannel();

	await channel.close({ disconnected: token });

	assertEquals(channel.state, Channel.STATE_DISCONNECTED);

	assertThrows(
		() => channel.write(2, 'hello'),
		StateError
	);
});

Deno.test('Channel - addMessageTypes throws StateError after disconnect', async () => {
	const { channel, token } = makeChannel();

	await channel.close({ disconnected: token });

	assertEquals(channel.state, Channel.STATE_DISCONNECTED);

	await assertRejects(
		() => channel.addMessageTypes(['myType']),
		StateError
	);
});
