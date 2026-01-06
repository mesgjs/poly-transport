// Test suite for Channel implementation

import { assertEquals, assertRejects, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Channel, UnsupportedOperationError, ChannelClosedError } from '../../src/channel.esm.js';
import { TimeoutError } from '../../src/flow-control.esm.js';
import { VirtualBuffer } from '../../src/buffer-manager.esm.js';

// Helper to create a read channel
function createReadChannel (options = {}) {
	return new Channel({
		direction: 'read',
		localChannelId: 1,
		maxBufferSize: 1024,
		lowBufferSize: 512,
		maxChunkSize: 256,
		...options
	});
}

// Helper to create a write channel
function createWriteChannel (options = {}) {
	return new Channel({
		direction: 'write',
		localChannelId: 1,
		remoteChannelId: 2,
		remoteMaxBufferSize: 1024,
		remoteMaxChunkSize: 256,
		...options
	});
}

// Helper to create test data
function createTestData (size) {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		data[i] = i % 256;
	}
	return data;
}

// ============================================================================
// Constructor Tests
// ============================================================================

Deno.test('Channel: constructor requires valid direction', () => {
	assertThrows(
		() => new Channel({ direction: 'invalid', localChannelId: 1 }),
		RangeError,
		"direction must be 'read' or 'write'"
	);
});

Deno.test('Channel: constructor requires valid localChannelId', () => {
	assertThrows(
		() => new Channel({ direction: 'read', localChannelId: -1 }),
		RangeError,
		'localChannelId must be a non-negative integer'
	);
});

Deno.test('Channel: write channel requires remoteChannelId', () => {
	assertThrows(
		() => new Channel({ direction: 'write', localChannelId: 1 }),
		RangeError,
		'remoteChannelId must be a non-negative integer for write channels'
	);
});

Deno.test('Channel: constructor creates read channel', () => {
	const ch = createReadChannel();
	assertEquals(ch.direction, 'read');
	assertEquals(ch.state, 'open');
	assertEquals(ch.localChannelId, 1);
});

Deno.test('Channel: constructor creates write channel', () => {
	const ch = createWriteChannel();
	assertEquals(ch.direction, 'write');
	assertEquals(ch.state, 'open');
	assertEquals(ch.localChannelId, 1);
	assertEquals(ch.remoteChannelId, 2);
});

// ============================================================================
// Read Tests - Synchronous
// ============================================================================

Deno.test('Channel: readSync returns null when no data', () => {
	const ch = createReadChannel();
	const result = ch.readSync();
	assertEquals(result, null);
});

Deno.test('Channel: readSync returns chunk when available', async () => {
	const ch = createReadChannel();
	const testData = createTestData(10);

	// Simulate receiving a chunk
	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: testData
	});

	const result = ch.readSync();
	assertEquals(result.sequence, 1);
	assertEquals(result.type, 0);
	assertEquals(result.eom, true);
	assertEquals(result.data.length, 10);
});

Deno.test('Channel: readSync with filter matches type', async () => {
	const ch = createReadChannel();

	// Add chunks of different types
	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 1,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 2,
		messageType: 2,
		eom: true,
		data: createTestData(10)
	});

	// Read only type 2
	const result = ch.readSync({ only: 2 });
	assertEquals(result.sequence, 2);
	assertEquals(result.type, 2);
});

Deno.test('Channel: readSync supports out-of-order consumption', async () => {
	const ch = createReadChannel();

	// Add chunks in order
	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 1,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 2,
		messageType: 2,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 3,
		messageType: 1,
		eom: true,
		data: createTestData(10)
	});

	// Read type 2 first (out of order)
	const result1 = ch.readSync({ only: 2 });
	assertEquals(result1.sequence, 2);

	// Read type 1 chunks
	const result2 = ch.readSync({ only: 1 });
	assertEquals(result2.sequence, 1);

	const result3 = ch.readSync({ only: 1 });
	assertEquals(result3.sequence, 3);
});

Deno.test('Channel: readSync throws on write channel', () => {
	const ch = createWriteChannel();
	assertThrows(
		() => ch.readSync(),
		UnsupportedOperationError,
		'readSync is only valid on read channels'
	);
});

Deno.test('Channel: readSync returns null when closed', async () => {
	const ch = createReadChannel();
	await ch.close();
	const result = ch.readSync();
	assertEquals(result, null);
});

// ============================================================================
// Read Tests - Asynchronous
// ============================================================================

Deno.test('Channel: read returns immediately when data available', async () => {
	const ch = createReadChannel();
	const testData = createTestData(10);

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: testData
	});

	const result = await ch.read();
	assertEquals(result.sequence, 1);
	assertEquals(result.type, 0);
	assertEquals(result.eom, true);
});

Deno.test('Channel: read waits for data to arrive', async () => {
	const ch = createReadChannel();
	const testData = createTestData(10);

	// Start read before data arrives
	const readPromise = ch.read();

	// Simulate data arriving after a delay
	setTimeout(async () => {
		await ch._onReceiveChunk({
			sequence: 1,
			messageType: 0,
			eom: true,
			data: testData
		});
	}, 10);

	const result = await readPromise;
	assertEquals(result.sequence, 1);
});

Deno.test('Channel: read times out when no data arrives', async () => {
	const ch = createReadChannel();

	await assertRejects(
		() => ch.read({ timeout: 50 }),
		TimeoutError,
		'Timed out waiting for chunk'
	);
});

Deno.test('Channel: read with filter waits for matching type', async () => {
	const ch = createReadChannel();

	// Start read waiting for type 2
	const readPromise = ch.read({ only: 2 });

	// Send type 1 first (should not satisfy the read)
	setTimeout(async () => {
		await ch._onReceiveChunk({
			sequence: 1,
			messageType: 1,
			eom: true,
			data: createTestData(10)
		});
	}, 10);

	// Send type 2 later (should satisfy the read)
	setTimeout(async () => {
		await ch._onReceiveChunk({
			sequence: 2,
			messageType: 2,
			eom: true,
			data: createTestData(10)
		});
	}, 20);

	const result = await readPromise;
	assertEquals(result.sequence, 2);
	assertEquals(result.type, 2);
});

Deno.test('Channel: concurrent filtered reads do not interfere', async () => {
	const ch = createReadChannel();

	// Start two concurrent reads with different filters
	const read1Promise = ch.read({ only: 1 });
	const read2Promise = ch.read({ only: 2 });

	// Send chunks in reverse order
	setTimeout(async () => {
		await ch._onReceiveChunk({
			sequence: 1,
			messageType: 2,
			eom: true,
			data: createTestData(10)
		});
		await ch._onReceiveChunk({
			sequence: 2,
			messageType: 1,
			eom: true,
			data: createTestData(10)
		});
	}, 10);

	const [result1, result2] = await Promise.all([read1Promise, read2Promise]);
	assertEquals(result1.type, 1);
	assertEquals(result2.type, 2);
});

Deno.test('Channel: read returns null when channel closes', async () => {
	const ch = createReadChannel();

	// Start read before close
	const readPromise = ch.read();

	// Close channel after a delay
	setTimeout(async () => {
		await ch.close();
	}, 10);

	const result = await readPromise;
	assertEquals(result, null);
});

Deno.test('Channel: read throws on write channel', async () => {
	const ch = createWriteChannel();
	await assertRejects(
		() => ch.read(),
		UnsupportedOperationError,
		'read is only valid on read channels'
	);
});

// ============================================================================
// Write Tests - Single Chunk
// ============================================================================

Deno.test('Channel: write sends single chunk', async () => {
	let sentData = null;
	const ch = createWriteChannel({
		sendData: async (data) => {
			sentData = data;
		}
	});

	const testData = createTestData(100);
	await ch.write(0, testData, { eom: true });

	assertEquals(sentData.kind, 'data');
	assertEquals(sentData.channelId, 2);
	assertEquals(sentData.messageTypeId, 0);
	assertEquals(sentData.eom, true);
	assertEquals(sentData.data.length, 100);
});

Deno.test('Channel: write with eom=false', async () => {
	let sentData = null;
	const ch = createWriteChannel({
		sendData: async (data) => {
			sentData = data;
		}
	});

	const testData = createTestData(100);
	await ch.write(0, testData, { eom: false });

	assertEquals(sentData.eom, false);
});

Deno.test('Channel: write accepts VirtualBuffer', async () => {
	let sentData = null;
	const ch = createWriteChannel({
		sendData: async (data) => {
			sentData = data;
		}
	});

	const vb = new VirtualBuffer();
	vb.append(createTestData(100));
	await ch.write(0, vb, { eom: true });

	assertEquals(sentData.data.length, 100);
});

Deno.test('Channel: write throws on read channel', async () => {
	const ch = createReadChannel();
	await assertRejects(
		() => ch.write(0, createTestData(10)),
		UnsupportedOperationError,
		'write is only valid on write channels'
	);
});

Deno.test('Channel: write throws when closed', async () => {
	const ch = createWriteChannel({
		sendData: async () => {}
	});
	await ch.close();

	await assertRejects(
		() => ch.write(0, createTestData(10)),
		ChannelClosedError,
		'Channel is not open'
	);
});

// ============================================================================
// Write Tests - Auto-Chunking
// ============================================================================

Deno.test('Channel: write auto-chunks large data', async () => {
	const sentChunks = [];
	const ch = createWriteChannel({
		remoteMaxChunkSize: 100,
		sendData: async (data) => {
			sentChunks.push(data);
		}
	});

	// Send 250 bytes (should split into 3 chunks: 100, 100, 50)
	const testData = createTestData(250);
	await ch.write(0, testData, { eom: true });

	assertEquals(sentChunks.length, 3);
	assertEquals(sentChunks[0].data.length, 100);
	assertEquals(sentChunks[0].eom, false);
	assertEquals(sentChunks[1].data.length, 100);
	assertEquals(sentChunks[1].eom, false);
	assertEquals(sentChunks[2].data.length, 50);
	assertEquals(sentChunks[2].eom, true);
});

Deno.test('Channel: write auto-chunks preserves message type', async () => {
	const sentChunks = [];
	const ch = createWriteChannel({
		remoteMaxChunkSize: 100,
		sendData: async (data) => {
			sentChunks.push(data);
		}
	});

	const testData = createTestData(250);
	await ch.write(5, testData, { eom: true });

	assertEquals(sentChunks[0].messageTypeId, 5);
	assertEquals(sentChunks[1].messageTypeId, 5);
	assertEquals(sentChunks[2].messageTypeId, 5);
});

Deno.test('Channel: write auto-chunks with eom=false', async () => {
	const sentChunks = [];
	const ch = createWriteChannel({
		remoteMaxChunkSize: 100,
		sendData: async (data) => {
			sentChunks.push(data);
		}
	});

	const testData = createTestData(250);
	await ch.write(0, testData, { eom: false });

	// All chunks should have eom=false
	assertEquals(sentChunks[0].eom, false);
	assertEquals(sentChunks[1].eom, false);
	assertEquals(sentChunks[2].eom, false);
});

Deno.test('Channel: write no chunking when remoteMaxChunkSize is 0', async () => {
	const sentChunks = [];
	const ch = createWriteChannel({
		remoteMaxChunkSize: 0, // Unlimited
		sendData: async (data) => {
			sentChunks.push(data);
		}
	});

	const testData = createTestData(1000);
	await ch.write(0, testData, { eom: true });

	// Should send as single chunk
	assertEquals(sentChunks.length, 1);
	assertEquals(sentChunks[0].data.length, 1000);
	assertEquals(sentChunks[0].eom, true);
});

// ============================================================================
// Clear Tests
// ============================================================================

Deno.test('Channel: clear removes all chunks', async () => {
	const ch = createReadChannel();

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 2,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});

	ch.clear();

	const result = ch.readSync();
	assertEquals(result, null);
});

Deno.test('Channel: clear with filter removes only matching chunks', async () => {
	const ch = createReadChannel();

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 1,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 2,
		messageType: 2,
		eom: true,
		data: createTestData(10)
	});

	ch.clear({ only: 1 });

	// Type 1 should be gone
	const result1 = ch.readSync({ only: 1 });
	assertEquals(result1, null);

	// Type 2 should remain
	const result2 = ch.readSync({ only: 2 });
	assertEquals(result2.sequence, 2);
});

Deno.test('Channel: clear with chunk removes specific chunk', async () => {
	const ch = createReadChannel();

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});
	await ch._onReceiveChunk({
		sequence: 2,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});

	ch.clear({ chunk: 1 });

	// Chunk 1 should be gone
	const result = ch.readSync();
	assertEquals(result.sequence, 2);
});

Deno.test('Channel: clear throws on write channel', () => {
	const ch = createWriteChannel();
	assertThrows(
		() => ch.clear(),
		UnsupportedOperationError,
		'clear is only valid on read channels'
	);
});

// ============================================================================
// Close Tests
// ============================================================================

Deno.test('Channel: close transitions state', async () => {
	const ch = createReadChannel();
	assertEquals(ch.state, 'open');

	await ch.close();
	assertEquals(ch.state, 'closed');
});

Deno.test('Channel: close dispatches events', async () => {
	const ch = createReadChannel();
	const events = [];

	ch.addEventListener('beforeClosing', (e) => {
		events.push('beforeClosing');
	});
	ch.addEventListener('closed', (e) => {
		events.push('closed');
	});

	await ch.close();

	assertEquals(events, ['beforeClosing', 'closed']);
});

Deno.test('Channel: close with discard clears read queue', async () => {
	const ch = createReadChannel();

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});

	await ch.close({ discard: true });

	// Queue should be empty (but channel is closed so readSync returns null anyway)
	assertEquals(ch.state, 'closed');
});

Deno.test('Channel: close wakes waiting readers with null', async () => {
	const ch = createReadChannel();

	// Start read before close
	const readPromise = ch.read();

	// Close after delay
	setTimeout(async () => {
		await ch.close();
	}, 10);

	const result = await readPromise;
	assertEquals(result, null);
});

Deno.test('Channel: close is idempotent', async () => {
	const ch = createReadChannel();

	await ch.close();
	await ch.close(); // Should not throw

	assertEquals(ch.state, 'closed');
});

// ============================================================================
// Event Tests
// ============================================================================

Deno.test('Channel: addEventListener adds handler', async () => {
	const ch = createReadChannel();
	let called = false;

	ch.addEventListener('newChunk', () => {
		called = true;
	});

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});

	assertEquals(called, true);
});

Deno.test('Channel: removeEventListener removes handler', async () => {
	const ch = createReadChannel();
	let called = false;

	const handler = () => {
		called = true;
	};

	ch.addEventListener('newChunk', handler);
	ch.removeEventListener('newChunk', handler);

	await ch._onReceiveChunk({
		sequence: 1,
		messageType: 0,
		eom: true,
		data: createTestData(10)
	});

	assertEquals(called, false);
});

// ============================================================================
// Message Type Registration Tests
// ============================================================================

Deno.test('Channel: addMessageType registers type', async () => {
	const ch = createWriteChannel({
		sendControl: async (msg) => {
			// Simulate transport response
			setTimeout(() => {
				ch._onMessageTypeRegistered('test-type', 42);
			}, 10);
		}
	});

	const typeId = await ch.addMessageType('test-type');
	assertEquals(typeId, 42);
});

Deno.test('Channel: addMessageType returns cached type', async () => {
	const ch = createWriteChannel({
		sendControl: async (msg) => {
			setTimeout(() => {
				ch._onMessageTypeRegistered('test-type', 42);
			}, 10);
		}
	});

	const typeId1 = await ch.addMessageType('test-type');
	const typeId2 = await ch.addMessageType('test-type'); // Should return cached

	assertEquals(typeId1, 42);
	assertEquals(typeId2, 42);
});

Deno.test('Channel: addMessageType throws on read channel', async () => {
	const ch = createReadChannel();
	await assertRejects(
		() => ch.addMessageType('test-type'),
		UnsupportedOperationError,
		'addMessageType is only valid on write channels'
	);
});

Deno.test('Channel: write with string type uses registered type', async () => {
	let sentData = null;
	const ch = createWriteChannel({
		sendControl: async (msg) => {
			setTimeout(() => {
				ch._onMessageTypeRegistered('test-type', 42);
			}, 10);
		},
		sendData: async (data) => {
			sentData = data;
		}
	});

	await ch.addMessageType('test-type');
	await ch.write('test-type', createTestData(10));

	assertEquals(sentData.messageTypeId, 42);
	assertEquals(sentData.messageTypeName, 'test-type');
});

Deno.test('Channel: write with unregistered string type throws', async () => {
	const ch = createWriteChannel({
		sendData: async () => {}
	});

	await assertRejects(
		() => ch.write('unknown-type', createTestData(10)),
		Error,
		"Message type 'unknown-type' is not registered for outbound use"
	);
});
