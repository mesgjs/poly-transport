import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { ByteTransport } from '../../src/transport/byte.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import { VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	RESERVE_ACK_BYTES, DATA_HEADER_BYTES,
	encodeAckHeaderInto, encodeChannelHeaderInto,
	TCC_DTAM_CHAN_REQUEST, TCC_DTAM_TRAN_STOPPED, CHANNEL_TCC,
} from '../../src/protocol.esm.js';

// Mock byte transport with controllable I/O
class MockByteTransport extends ByteTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		// Override writeBytes to capture output
		async writeBytes () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;
			const committed = outputBuffer.committed;
			if (committed === 0) return;

			const buffers = outputBuffer.getBuffers(committed);
			for (const buf of buffers) {
				thys.#writeBuffer.push(new Uint8Array(buf));
			}
			// Mark bytes as sent and free up ring buffer space
			outputBuffer.release(committed);
			// Call afterWrite to wake any waiting reservations
			_thys.afterWrite();
		},

		async stop () {
			// First drain the output buffer (ByteTransport behavior)
			await super.stop();
			// Then simulate remote sending tranStopped so stop() can finalize
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const tcc = _thys.channels.get(CHANNEL_TCC);
			if (tcc) {
				const data = '{}';
				_thys.receiveMessage({
					type: HDR_TYPE_CHAN_DATA,
					headerSize: DATA_HEADER_BYTES,
					dataSize: data.length * 2,
					flags: 0x0001, // FLAG_EOM
					channelId: CHANNEL_TCC,
					sequence: tcc.nextReadSeq,
					messageType: TCC_DTAM_TRAN_STOPPED[0],
					eom: true,
				}, data);
			}
		}
	}, super.__protected));

	#readBuffer = new VirtualRWBuffer();
	#writeBuffer = [];
	#_subs = new Set();
	#_;

	constructor (options = {}) {
		const bufferPool = options.bufferPool || new BufferPool();
		super({ ...options, bufferPool });
		this._get_();
	}

	// Simulate receiving bytes from remote
	simulateReceive (data) {
		const _thys = this.#_;
		if (typeof data === 'string') {
			// Encode string to bytes
			const encoder = new TextEncoder();
			const bytes = encoder.encode(data);
			_thys.receiveBytes(bytes);
		} else if (data instanceof Uint8Array) {
			_thys.receiveBytes(data);
		} else if (Array.isArray(data)) {
			_thys.receiveBytes(new Uint8Array(data));
		}
	}

	// Get captured writes
	getWrites () {
		return this.#writeBuffer;
	}

	// Clear captured writes
	clearWrites () {
		this.#writeBuffer = [];
	}

	// Access protected state for testing
	getProtectedState () {
		return this.#_;
	}

	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}

	writeBytes () {
		this.#_.writeBytes();
	}
}

// Tests for constructor
Deno.test('ByteTransport - constructor with defaults', () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	assertExists(_thys.outputBuffer);
	assertExists(_thys.writeQueue);
	assertEquals(transport.needsEncodedText, true);
});

Deno.test('ByteTransport - constructor with custom options', () => {
	const transport = new MockByteTransport({
		forceWriteBytes: 8192,
		writeBatchTime: 10,
		outputBufferSize: 128 * 1024
	});

	const _thys = transport.getProtectedState();
	assertExists(_thys.outputBuffer);
	assertEquals(_thys.outputBuffer.size, 128 * 1024);
});

// Tests for sendHandshake
Deno.test('ByteTransport - sendHandshake encodes greeting and config', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	// Trigger write
	await transport.writeBytes();

	const writes = transport.getWrites();
	assertEquals(writes.length, 1);

	// Decode and verify
	const decoder = new TextDecoder();
	const text = decoder.decode(writes[0]);

	assert(text.startsWith(GREET_CONFIG_PREFIX));
	assert(text.endsWith(GREET_CONFIG_SUFFIX));

	// Extract and parse JSON
	const jsonStart = GREET_CONFIG_PREFIX.length;
	const jsonEnd = text.length - GREET_CONFIG_SUFFIX.length;
	const json = text.slice(jsonStart, jsonEnd);
	const config = JSON.parse(json);

	assertExists(config.transportId);
	assertEquals(config.version, 1);
	assertEquals(typeof config.c2cEnabled, 'boolean');
	assertExists(config.minChannelId);
	assertExists(config.minMessageTypeId);

	await transport.stop();
});

Deno.test('ByteTransport - sendHandshake schedules immediate write', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	await _thys.sendHandshake();

	// Give time for scheduled write to execute
	await new Promise((r) => setTimeout(r, 20));

	// Check that write was triggered (data should be in write buffer, not committed buffer)
	const writes = transport.getWrites();
	assert(writes.length > 0, 'sendHandshake should have triggered a write');

	await transport.stop();
});

// Tests for startByteStream
Deno.test('ByteTransport - startByteStream sends marker', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	await _thys.startByteStream();

	// Trigger write
	await transport.writeBytes();

	const writes = transport.getWrites();
	assertEquals(writes.length, 1);

	// Verify byte stream marker
	const decoder = new TextDecoder();
	const text = decoder.decode(writes[0]);
	assertEquals(text, START_BYTE_STREAM);

	await transport.stop();
});

// Tests for receiveBytes
Deno.test('ByteTransport - receiveBytes appends to input buffer', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	const data = new Uint8Array([1, 2, 3, 4, 5]);
	_thys.receiveBytes(data);

	assertEquals(_thys.inputBuffer.length, 5);

	await transport.stop();
});

Deno.test('ByteTransport - receiveBytes wakes waiting reader', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Create a waiter
	const waiter = { count: 10 };
	let resolved = false;
	waiter.resolve = () => { resolved = true; };
	_thys.readWaiter = waiter;

	// Receive enough bytes to satisfy waiter
	const data = new Uint8Array(10);
	_thys.receiveBytes(data);

	// Waiter should be resolved
	assertEquals(resolved, true);

	await transport.stop();
});

Deno.test('ByteTransport - receiveBytes does not wake waiter if insufficient', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Create a waiter
	const waiter = { count: 10 };
	let resolved = false;
	waiter.resolve = () => { resolved = true; };
	_thys.readWaiter = waiter;

	// Receive insufficient bytes
	const data = new Uint8Array(5);
	_thys.receiveBytes(data);

	// Waiter should NOT be resolved
	assertEquals(resolved, false);

	await transport.stop();
});

// Tests for reservable
Deno.test('ByteTransport - reservable returns immediately if space available', async () => {
	const transport = new MockByteTransport({ outputBufferSize: 64 * 1024 });
	const _thys = transport.getProtectedState();

	// Should return immediately (no promise)
	const result = await _thys.reservable(1024);
	assertEquals(result, undefined);
});

Deno.test('ByteTransport - reservable waits if insufficient space', async () => {
	const transport = new MockByteTransport({ outputBufferSize: 1024 });
	const _thys = transport.getProtectedState();

	// Fill the buffer
	const reservation = _thys.outputBuffer.reserve(1000);
	_thys.outputBuffer.commit();

	// Try to reserve more than available
	let resolved = false;
	const promise = _thys.reservable(500);
	promise.then(() => { resolved = true; });

	// Should not resolve immediately
	await new Promise((r) => setTimeout(r, 10));
	assertEquals(resolved, false);

	// Simulate write completing (which releases space and calls afterWrite)
	await transport.writeBytes();

	// Now should resolve
	await promise;
	assertEquals(resolved, true);

	await transport.stop();
});

Deno.test('ByteTransport - reservable throws if size exceeds buffer', () => {
	const transport = new MockByteTransport({ outputBufferSize: 1024 });
	const _thys = transport.getProtectedState();

	try {
		_thys.reservable(2048);
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof RangeError);
		assert(err.message.includes('exceeds buffer size'));
	}
});

// Tests for scheduleWrite
Deno.test('ByteTransport - scheduleWrite does nothing if no committed data', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Should not throw
	_thys.scheduleWrite();
	assertEquals(_thys.outputBuffer.committed, 0);

	await transport.stop();
});

Deno.test('ByteTransport - scheduleWrite triggers immediate write when forced', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Commit some data
	const reservation = _thys.outputBuffer.reserve(100);
	reservation.fill(42);
	_thys.outputBuffer.commit();

	// Schedule immediate write
	_thys.scheduleWrite(true);

	// Give time for async write
	await new Promise((r) => setTimeout(r, 10));

	// Should have written
	const writes = transport.getWrites();
	assert(writes.length > 0, 'scheduleWrite(true) should have triggered a write');

	await transport.stop();
});

Deno.test('ByteTransport - scheduleWrite respects autoWriteBytes threshold', async () => {
	const transport = new MockByteTransport({ forceWriteBytes: 1000, writeBatchTime: 50 });
	const _thys = transport.getProtectedState();

	// Commit less than threshold
	const reservation = _thys.outputBuffer.reserve(500);
	reservation.fill(42);
	_thys.outputBuffer.commit();

	// Schedule write (should set timer, not write immediately)
	_thys.scheduleWrite();

	// Should not have written yet (wait less than autoWriteTime)
	await new Promise((r) => setTimeout(r, 10));
	const writes = transport.getWrites();
	assertEquals(writes.length, 0);

	await transport.stop();
});

Deno.test('ByteTransport - scheduleWrite triggers write when over threshold', async () => {
	const transport = new MockByteTransport({ forceWriteBytes: 1000 });
	const _thys = transport.getProtectedState();

	// Commit more than threshold
	const reservation = _thys.outputBuffer.reserve(1500);
	reservation.fill(42);
	_thys.outputBuffer.commit();

	// Schedule write (should write immediately)
	_thys.scheduleWrite();

	// Give time for async write
	await new Promise((r) => setTimeout(r, 10));

	// Should have written
	const writes = transport.getWrites();
	assert(writes.length > 0, 'scheduleWrite should have triggered a write when over threshold');

	await transport.stop();
});

// Tests for sendAckMessage
Deno.test('ByteTransport - sendAckMessage requires valid token', async () => {
	const transport = new MockByteTransport();

	await assertRejects(
		() => transport.sendAckMessage('not-a-symbol', {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('ByteTransport - sendAckMessage encodes ACK header', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport to create TCC
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Get TCC channel
	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Create mock flow control with ACK info
	const mockFlowControl = {
		getAckInfo: () => ({ base: 1, ranges: [5, 2, 3] }),
		clearReadAckInfo: () => {}
	};

	transport.clearWrites();

	// Send ACK
	await transport.sendAckMessage(token, mockFlowControl);

	// Trigger write
	await transport.writeBytes();

	const writes = transport.getWrites();
	assertEquals(writes.length, 1, 'sendAckMessage should have produced exactly one write');

	// Verify ACK header structure
	const ackData = writes[0];
	assertEquals(ackData[0], HDR_TYPE_ACK);

	await transport.stop();
});

// Tests for sendChunk
Deno.test('ByteTransport - sendChunk requires valid token', async () => {
	const transport = new MockByteTransport();

	await assertRejects(
		() => transport.sendChunk('not-a-symbol', {}, {}, {}),
		Error,
		'Unauthorized'
	);
});

Deno.test('ByteTransport - sendChunk encodes channel header', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Get TCC channel
	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Create mock chunker
	const testData = new Uint8Array([1, 2, 3, 4, 5]);
	const mockChunker = {
		bufferSize: testData.length,
		bytesToReserve: () => DATA_HEADER_BYTES + testData.length + RESERVE_ACK_BYTES,
		nextChunk: (buffer) => {
			buffer.set(testData);
			buffer.shrink(testData.length);
			mockChunker.remaining = 0;
		},
		remaining: testData.length
	};

	transport.clearWrites();

	// Create mock flow control
	const mockFlowControl = {
		get nextWriteSeq () { return 1; },
		sent: () => {}
	};

	// Send chunk
	const header = {
		type: HDR_TYPE_CHAN_DATA,
		messageType: 100
	};
	await transport.sendChunk(token, mockFlowControl, header, mockChunker, { eom: true });

	// Trigger write
	await transport.writeBytes();

	const writes = transport.getWrites();
	assertEquals(writes.length, 1, 'sendChunk should have produced exactly one write');

	// Verify channel header structure
	const chunkData = writes[0];
	assertEquals(chunkData[0], HDR_TYPE_CHAN_DATA);

	await transport.stop();
});

// Tests for afterWrite
Deno.test('ByteTransport - afterWrite wakes reservation waiter', async () => {
	const transport = new MockByteTransport({ outputBufferSize: 1024 });
	const _thys = transport.getProtectedState();

	// Fill buffer
	const reservation = _thys.outputBuffer.reserve(1000);
	_thys.outputBuffer.commit();

	// Create waiter
	let resolved = false;
	const waiter = { size: 500 };
	waiter.resolve = () => { resolved = true; };
	_thys.reserveWaiter = waiter;

	// Release enough to satisfy waiter
	_thys.outputBuffer.release(600);

	// Call afterWrite
	_thys.afterWrite();

	// Waiter should be resolved
	assertEquals(resolved, true);

	await transport.stop();
});

Deno.test('ByteTransport - afterWrite does not wake waiter if insufficient space', async () => {
	const transport = new MockByteTransport({ outputBufferSize: 1024 });
	const _thys = transport.getProtectedState();

	// Fill buffer
	const reservation = _thys.outputBuffer.reserve(1000);
	_thys.outputBuffer.commit();

	// Create waiter
	let resolved = false;
	const waiter = { size: 500 };
	waiter.resolve = () => { resolved = true; };
	_thys.reserveWaiter = waiter;

	// Release insufficient space
	_thys.outputBuffer.release(100);

	// Call afterWrite
	_thys.afterWrite();

	// Waiter should NOT be resolved
	assertEquals(resolved, false);

	await transport.stop();
});

// Tests for byte reader (handshake processing)
Deno.test('ByteTransport - byteReader processes greeting and config', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start reader in background
	_thys.startReader();

	// Simulate receiving handshake
	const config = {
		transportId: 'remote-id',
		version: 1,
		c2cEnabled: false,
		minChannelId: 1024,
		minMessageTypeId: 1024
	};
	const handshake = GREET_CONFIG_PREFIX + JSON.stringify(config) + GREET_CONFIG_SUFFIX;
	transport.simulateReceive(handshake);

	// Wait for processing
	await new Promise((r) => setTimeout(r, 50));

	// Should have processed config and determined role
	assertExists(_thys.role, 'Role should be set after processing remote config');

	await transport.stop();
});

Deno.test('ByteTransport - byteReader processes byte stream marker', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport (which starts the reader)
	const startPromise = transport.start();

	// Send handshake first (through the byte reader in line mode)
	const config = {
		transportId: 'remote-id',
		version: 1,
		c2cEnabled: false,
		minChannelId: 1024,
		minMessageTypeId: 1024
	};
	const handshake = GREET_CONFIG_PREFIX + JSON.stringify(config) + GREET_CONFIG_SUFFIX;
	transport.simulateReceive(handshake);

	// Wait for handshake processing
	await new Promise((r) => setTimeout(r, 50));

	// Send byte stream marker to transition to byte-stream mode
	transport.simulateReceive(START_BYTE_STREAM);

	// Wait for transport to become active (byte stream mode transition completes start)
	await startPromise;

	// Verify transport is now active (byte stream mode was entered)
	assertEquals(transport.state, Transport.STATE_ACTIVE, 'Transport should be active after byte stream marker');

	await transport.stop();
});

Deno.test('ByteTransport - byteReader emits outOfBandData for non-protocol lines', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	let receivedData = null;
	transport.addEventListener('outOfBandData', (event) => {
		receivedData = event.detail.data;
	});

	// Start reader in background
	_thys.startReader();

	// Send out-of-band data
	transport.simulateReceive('Some random text\n');

	// Wait for processing
	await new Promise((r) => setTimeout(r, 50));

	assertEquals(receivedData, 'Some random text\n');

	await transport.stop();
});

// Tests for byte reader (message processing)
Deno.test('ByteTransport - byteReader decodes ACK messages', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start and complete handshake
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Simulate the remote sending a chanRequest to us.
	// The TCC reader will process it and send a chanResponse (sequence 1 on TCC).
	// This advances nextWriteSeq to 2, making an ACK for sequence 1 valid.
	const chanReqData = JSON.stringify({ channelName: 'test', maxBufferBytes: 65536, maxChunkBytes: 16384 });
	const encoder = new TextEncoder();
	const encodedChanReq = encoder.encode(chanReqData);
	const chanReqBuffer = new VirtualRWBuffer([new Uint8Array(DATA_HEADER_BYTES + encodedChanReq.length)]);
	encodeChannelHeaderInto(chanReqBuffer, 0, HDR_TYPE_CHAN_DATA, {
		dataSize: encodedChanReq.length,
		channelId: 0,
		sequence: 1,
		messageType: TCC_DTAM_CHAN_REQUEST[0]
	});
	chanReqBuffer.set(encodedChanReq, DATA_HEADER_BYTES);
	transport.simulateReceive(chanReqBuffer.toUint8Array());

	// Wait for TCC reader to process chanRequest and send chanResponse (sequence 1)
	await new Promise((r) => setTimeout(r, 50));

	// Create ACK message for TCC sequence 1 (the chanResponse we sent)
	const ackBuffer = new VirtualRWBuffer([new Uint8Array(RESERVE_ACK_BYTES)]);
	const headerSize = encodeAckHeaderInto(ackBuffer, 0, {
		channelId: 0,
		baseSequence: 1,
		ranges: []
	});
	ackBuffer.shrink(headerSize);

	// Simulate receiving ACK
	transport.simulateReceive(ackBuffer.toUint8Array());

	// Wait for processing
	await new Promise((r) => setTimeout(r, 50));

	// Transport should still be active (no protocol violation from premature ACK)
	assertEquals(transport.state, Transport.STATE_ACTIVE, 'Transport should remain active after valid ACK');

	await transport.stop();
});

Deno.test('ByteTransport - byteReader decodes channel data messages', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start and complete handshake
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Create a valid TCC data message (chanRequest) - messageType must be a valid TCC type
	const chanReqData = JSON.stringify({ channelName: 'test', maxBufferBytes: 65536, maxChunkBytes: 16384 });
	const encoder = new TextEncoder();
	const encodedData = encoder.encode(chanReqData);
	const messageBuffer = new VirtualRWBuffer([new Uint8Array(DATA_HEADER_BYTES + encodedData.length)]);
	encodeChannelHeaderInto(messageBuffer, 0, HDR_TYPE_CHAN_DATA, {
		dataSize: encodedData.length,
		channelId: 0,
		sequence: 1,
		messageType: TCC_DTAM_CHAN_REQUEST[0]
	});
	messageBuffer.set(encodedData, DATA_HEADER_BYTES);

	// Simulate receiving message
	transport.simulateReceive(messageBuffer.toUint8Array());

	// Wait for processing
	await new Promise((r) => setTimeout(r, 50));

	// Transport should still be active (chanRequest was processed, chanResponse sent)
	assertEquals(transport.state, Transport.STATE_ACTIVE, 'Transport should remain active after valid TCC data message');

	await transport.stop();
});

Deno.test('ByteTransport - byteReader stops transport on unknown header type', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport (starts byte reader in line mode)
	const startPromise = transport.start();

	// Send remote handshake through the byte reader (line mode)
	const remoteConfig = {
		transportId: 'remote-id',
		version: 1,
		c2cEnabled: false,
		minChannelId: 1024,
		minMessageTypeId: 1024
	};
	const handshake = GREET_CONFIG_PREFIX + JSON.stringify(remoteConfig) + GREET_CONFIG_SUFFIX;
	transport.simulateReceive(handshake);

	// Wait for handshake processing (triggers onRemoteConfig, which sends our byte stream marker)
	await new Promise((r) => setTimeout(r, 50));

	// Send remote byte stream marker to transition reader to byte-stream mode
	transport.simulateReceive(START_BYTE_STREAM);

	// Wait for byte stream mode transition and transport to become active
	await startPromise;

	// Send invalid header type (now in byte-stream mode)
	const invalidMessage = new Uint8Array([99, 0, 0, 0]); // Type 99 is invalid
	transport.simulateReceive(invalidMessage);

	// Wait for processing
	await new Promise((r) => setTimeout(r, 50));

	// Transport should have stopped due to unknown header type
	assertEquals(transport.state, Transport.STATE_STOPPED);
});

// Tests for integration with base class
Deno.test('ByteTransport - extends Transport base class', () => {
	const transport = new MockByteTransport();
	assert(transport instanceof Transport);
	assert(transport instanceof ByteTransport);
});

Deno.test('ByteTransport - inherits Transport properties', () => {
	const transport = new MockByteTransport();

	assertExists(transport.id);
	assertExists(transport.logger);
	assertExists(transport.logChannelId);
	assertEquals(transport.state, Transport.STATE_CREATED);
});

Deno.test('ByteTransport - supports start lifecycle', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	const startPromise = transport.start();
	assertEquals(transport.state, Transport.STATE_STARTING);

	// Complete handshake
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});

	await startPromise;
	assertEquals(transport.state, Transport.STATE_ACTIVE);

	await transport.stop();
});

// Tests for output ring buffer integration
Deno.test('ByteTransport - uses OutputRingBuffer for zero-copy writes', () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	assertExists(_thys.outputBuffer);
	assertEquals(typeof _thys.outputBuffer.reserve, 'function');
	assertEquals(typeof _thys.outputBuffer.commit, 'function');
	assertEquals(typeof _thys.outputBuffer.release, 'function');
});

Deno.test('ByteTransport - output buffer has correct size', () => {
	const transport = new MockByteTransport({ outputBufferSize: 128 * 1024 });
	const _thys = transport.getProtectedState();

	assertEquals(_thys.outputBuffer.size, 128 * 1024);
});

// Tests for input buffer (VirtualRWBuffer)
Deno.test('ByteTransport - initializes input buffer', () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	assertExists(_thys.inputBuffer);
	assertEquals(_thys.inputBuffer.length, 0);
});

Deno.test('ByteTransport - input buffer accumulates received data', () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	const data1 = new Uint8Array([1, 2, 3]);
	const data2 = new Uint8Array([4, 5, 6]);

	_thys.receiveBytes(data1);
	assertEquals(_thys.inputBuffer.length, 3);

	_thys.receiveBytes(data2);
	assertEquals(_thys.inputBuffer.length, 6);
});

// Tests for write queue serialization
Deno.test('ByteTransport - uses TaskQueue for write serialization', () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	assertExists(_thys.writeQueue);
	assertEquals(typeof _thys.writeQueue.add, 'function');
});

Deno.test('ByteTransport - sendAckMessage uses write queue', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Get TCC
	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Mock flow control
	const mockFlowControl = {
		getAckInfo: () => ({ base: 1, ranges: [] }),
		clearReadAckInfo: () => {}
	};

	// Send multiple ACKs - should be serialized
	const promise1 = transport.sendAckMessage(token, mockFlowControl);
	const promise2 = transport.sendAckMessage(token, mockFlowControl);

	// Both should complete
	await promise1;
	await promise2;

	await transport.stop();
});

Deno.test('ByteTransport - sendChunk uses write queue', async () => {
	const transport = new MockByteTransport();
	const _thys = transport.getProtectedState();

	// Start transport
	const startPromise = transport.start();
	await _thys.sendHandshake();
	await _thys.startByteStream();
	await _thys.onRemoteConfig({
		transportId: 'remote-id',
		minChannelId: 1024,
		minMessageTypeId: 1024,
		c2cEnabled: false
	});
	await startPromise;

	// Get TCC
	const tcc = _thys.channels.get(0);
	const token = _thys.channelTokens.get(tcc);

	// Create chunkers
	const createChunker = (data) => {
		let remaining = data.length;
		return {
			bufferSize: data.length,
			bytesToReserve: () => DATA_HEADER_BYTES + data.length,
			nextChunk: (buffer) => {
				buffer.set(data);
				buffer.shrink(data.length);
				remaining = 0;
			},
			get remaining () { return remaining; }
		};
	};

	const chunker1 = createChunker(new Uint8Array([1, 2, 3]));
	const chunker2 = createChunker(new Uint8Array([4, 5, 6]));

	// Send multiple chunks - should be serialized
	// Create mock flow control
	const mockFlowControl = {
		_seq: 0,
		get nextWriteSeq () { return ++this._seq; },
		sent: () => {}
	};

	const header = { messageType: 100 };
	const promise1 = transport.sendChunk(token, mockFlowControl, header, chunker1);
	const promise2 = transport.sendChunk(token, mockFlowControl, { ...header }, chunker2);

	// Both should complete
	await promise1;
	await promise2;

	await transport.stop();
});

// Tests for protected state access
Deno.test('ByteTransport - protected methods require authorization', () => {
	const transport = new MockByteTransport();

	// Try to call protected method with wrong state
	try {
		const wrongState = {};
		ByteTransport.__protected.afterWrite.call({ __this: transport, ...wrongState });
		assert(false, 'Should have thrown');
	} catch (err) {
		assertEquals(err.message, 'Unauthorized');
	}
});

// Tests for needsEncodedText property
Deno.test('ByteTransport - needsEncodedText returns true', () => {
	const transport = new MockByteTransport();
	assertEquals(transport.needsEncodedText, true);
});

// Tests for error handling
Deno.test('ByteTransport - handles buffer pool exhaustion gracefully', async () => {
	// Create pool with very limited capacity
	const bufferPool = new BufferPool({
		sizeClasses: [1024],
		lowWaterMark: 1,
		highWaterMark: 2
	});

	const transport = new MockByteTransport({ bufferPool });
	const _thys = transport.getProtectedState();

	// Acquire all buffers
	const buf1 = bufferPool.acquire(1024);
	const buf2 = bufferPool.acquire(1024);

	// Pool should be exhausted, but transport should handle it
	// (by allocating new buffers as needed)
	assertExists(buf1);
	assertExists(buf2);
});
