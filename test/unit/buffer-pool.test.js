/*
 * buffer-pool.test.js - Tests for BufferPool class
 */

import { assertEquals, assertExists, assert, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { BufferPool } from '../../src/buffer-pool.esm.js';

const pause = async (count = 1) => {
	for (let i = 0; i < count; ++i) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
};

// Test: Constructor with defaults
Deno.test('BufferPool - constructor with defaults', () => {
	const pool = new BufferPool();

	assertEquals(pool.sizeClasses, [1024, 4096, 16384, 65536]);
	assertEquals(pool.isWorker, false);

	// Check that pools are pre-allocated to low water mark (default 2)
	const sizes = pool.getPoolSizes();
	assertEquals(sizes[1024], 2);
	assertEquals(sizes[4096], 2);
	assertEquals(sizes[16384], 2);
	assertEquals(sizes[65536], 2);
});

// Test: Constructor with custom size classes
Deno.test('BufferPool - constructor with custom size classes', () => {
	const pool = new BufferPool({
		sizeClasses: [512, 2048, 8192]
	});

	assertEquals(pool.sizeClasses, [512, 2048, 8192]);

	const sizes = pool.getPoolSizes();
	assertEquals(sizes[512], 2);
	assertEquals(sizes[2048], 2);
	assertEquals(sizes[8192], 2);
});

// Test: Constructor with custom water marks
Deno.test('BufferPool - constructor with custom water marks', () => {
	const pool = new BufferPool({
		lowWaterMark: 5,
		highWaterMark: 15
	});

	const sizes = pool.getPoolSizes();
	assertEquals(sizes[1024], 5);
	assertEquals(sizes[4096], 5);
	assertEquals(sizes[16384], 5);
	assertEquals(sizes[65536], 5);

	const marks = pool.getWaterMarks(1024);
	assertEquals(marks.low, 5);
	assertEquals(marks.high, 15);
});

// Test: Constructor with per-size-class water mark overrides
Deno.test('BufferPool - constructor with per-size-class water marks', () => {
	const pool = new BufferPool({
		lowWaterMark: 2,
		highWaterMark: 10,
		waterMarks: {
			1024: { low: 10, high: 30 },
			65536: { low: 1, high: 3 }
		}
	});

	// Check 1KB overrides
	const marks1k = pool.getWaterMarks(1024);
	assertEquals(marks1k.low, 10);
	assertEquals(marks1k.high, 30);
	assertEquals(pool.getPoolSizes()[1024], 10);

	// Check 4KB uses defaults
	const marks4k = pool.getWaterMarks(4096);
	assertEquals(marks4k.low, 2);
	assertEquals(marks4k.high, 10);
	assertEquals(pool.getPoolSizes()[4096], 2);

	// Check 64KB overrides
	const marks64k = pool.getWaterMarks(65536);
	assertEquals(marks64k.low, 1);
	assertEquals(marks64k.high, 3);
	assertEquals(pool.getPoolSizes()[65536], 1);
});

// Test: Acquire buffer from pool
Deno.test('BufferPool - acquire buffer from pool', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	const buffer = pool.acquire(1024);
	assertExists(buffer);
	assertEquals(buffer.byteLength, 1024);

	await pause();
	pool.stop();

	// Pool should have 2 buffers (started with 2, acquired 1, refilled to 2)
	assertEquals(pool.getPoolSizes()[1024], 2);

	// Stats should show 1 acquired
	const stats = pool.getStats();
	assertEquals(stats.pools[1024].acquired, 1);
});

// Test: Acquire buffer with size class selection
Deno.test('BufferPool - acquire selects appropriate size class', async () => {
	const pool = new BufferPool();

	// Request 500 bytes, should get 1KB buffer
	const buffer1 = pool.acquire(500);
	assertEquals(buffer1.byteLength, 1024);

	// Request 3000 bytes, should get 4KB buffer
	const buffer2 = pool.acquire(3000);
	assertEquals(buffer2.byteLength, 4096);

	// Request 10000 bytes, should get 16KB buffer
	const buffer3 = pool.acquire(10000);
	assertEquals(buffer3.byteLength, 16384);

	// Request 50000 bytes, should get 64KB buffer
	const buffer4 = pool.acquire(50000);
	assertEquals(buffer4.byteLength, 65536);

	await pause(4);
	pool.stop();
});

// Test: Acquire buffer too large
Deno.test('BufferPool - acquire buffer too large returns null', () => {
	const pool = new BufferPool();

	const buffer = pool.acquire(100000); // Larger than 64KB
	assertEquals(buffer, null);
});

// Test: Acquire allocates new buffer when pool empty
Deno.test('BufferPool - acquire allocates when pool empty', () => {
	const pool = new BufferPool({ lowWaterMark: 0, highWaterMark: 10 });

	// Pool starts empty
	assertEquals(pool.getPoolSizes()[1024], 0);

	const buffer = pool.acquire(1024);
	assertExists(buffer);
	assertEquals(buffer.byteLength, 1024);

	// Stats should show 1 allocated and 1 acquired
	const stats = pool.getStats();
	assertEquals(stats.pools[1024].allocated, 1);
	assertEquals(stats.pools[1024].acquired, 1);

	pool.stop();
});

// Test: Acquire maintains low water mark
Deno.test('BufferPool - acquire maintains low water mark', async () => {
	const pool = new BufferPool({ lowWaterMark: 3, highWaterMark: 10 });

	// Start with 3 buffers
	assertEquals(pool.getPoolSizes()[1024], 3);

	// Acquire one
	pool.acquire(1024);

	await pause();

	// Pool should be refilled to 3
	assertEquals(pool.getPoolSizes()[1024], 3);

	pool.stop();
});

// Test: Release buffer to pool
Deno.test('BufferPool - release buffer to pool', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	const buffer = pool.acquire(1024);
	await pause();
	assertEquals(pool.getPoolSizes()[1024], 2); // Refilled after acquire

	const released = pool.release(buffer);
	assertEquals(released, true);
	await pause();
	assertEquals(pool.getPoolSizes()[1024], 3); // Now has 3

	// Stats should show 1 released
	const stats = pool.getStats();
	assertEquals(stats.pools[1024].released, 1);

	pool.stop();
});

// Test: Release buffer with invalid size
Deno.test('BufferPool - release buffer with invalid size returns false', () => {
	const pool = new BufferPool();

	const buffer = new ArrayBuffer(512); // Not a recognized size class
	const released = pool.release(buffer);
	assertEquals(released, false);
});

// Test: Release zeros buffer
Deno.test('BufferPool - release zeros buffer', async () => {
	const pool = new BufferPool({ lowWaterMark: 0, highWaterMark: 10 });

	const buffer = pool.acquire(1024);
	const view = new Uint8Array(buffer);

	// Write some data
	view[0] = 42;
	view[100] = 99;
	view[1023] = 255;

	// Release buffer
	pool.release(buffer);

	await pause();
	// Look again (should be zeroed)
	assertEquals(view[0], 0);
	assertEquals(view[100], 0);
	assertEquals(view[1023], 0);

	pool.stop();
});

// Test: Release enforces high water mark
Deno.test('BufferPool - release enforces high water mark', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 5 });

	// Acquire and release 10 buffers
	const buffers = [];
	for (let i = 0; i < 10; i++) {
		buffers.push(pool.acquire(1024));
	}

	for (const buffer of buffers) {
		pool.release(buffer);
	}

	// Pool should be capped at high water mark (5)
	await pause();
	assertEquals(pool.getPoolSizes()[1024], 5);

	pool.stop();
});

// Test: Worker mode - receiveBuffers
Deno.test('BufferPool - worker mode receiveBuffers', () => {
	const pool = new BufferPool({
		isWorker: true,
		lowWaterMark: 0,
		highWaterMark: 10
	});

	assertEquals(pool.isWorker, true);
	assertEquals(pool.getPoolSizes()[1024], 0);

	// Simulate receiving buffers from main thread
	const buffers = [new ArrayBuffer(1024), new ArrayBuffer(1024)];
	pool.receiveBuffers(1024, buffers);

	assertEquals(pool.getPoolSizes()[1024], 2);

	// Stats should show 2 transferred
	const stats = pool.getStats();
	assertEquals(stats.pools[1024].transferred, 2);
});

// Test: Worker mode - receiveBuffers throws in non-worker context
Deno.test('BufferPool - receiveBuffers throws in non-worker context', () => {
	const pool = new BufferPool({ isWorker: false });

	assertThrows(
		() => pool.receiveBuffers(1024, [new ArrayBuffer(1024)]),
		Error,
		'receiveBuffers can only be called in worker context'
	);
});

// Test: Worker mode - receiveBuffers throws for invalid size
Deno.test('BufferPool - receiveBuffers throws for invalid size', () => {
	const pool = new BufferPool({ isWorker: true });

	assertThrows(
		() => pool.receiveBuffers(512, [new ArrayBuffer(512)]),
		Error,
		'Invalid size class: 512'
	);
});

// Test: Worker mode - request callback
Deno.test('BufferPool - worker mode request callback', async () => {
	let requestedSize = null;
	let requestedCount = null;

	const pool = new BufferPool({
		isWorker: true,
		lowWaterMark: 3,
		highWaterMark: 10,
		requestCallback: (size, count) => {
			requestedSize = size;
			requestedCount = count;
		}
	});

	// Constructor should have requested buffers
	assertEquals(requestedSize, 65536); // Last size class
	assertEquals(requestedCount, 3);

	// Reset
	requestedSize = null;
	requestedCount = null;

	// Acquire should trigger request when pool drops below low water mark
	pool.receiveBuffers(1024, [new ArrayBuffer(1024), new ArrayBuffer(1024), new ArrayBuffer(1024)]);
	pool.acquire(1024);
	pool.acquire(1024);

	// Should request more buffers
	await pause();
	assertEquals(requestedSize, 1024);
	assertEquals(requestedCount, 2);

	pool.stop();
});

// Test: Worker mode - return callback
Deno.test('BufferPool - worker mode return callback', async () => {
	let returnedSize = null;
	let returnedBuffers = null;
	let totalReturned = 0;

	const pool = new BufferPool({
		isWorker: true,
		lowWaterMark: 0,
		highWaterMark: 3,
		returnCallback: (size, buffers) => {
			returnedSize = size;
			returnedBuffers = buffers;
			totalReturned += buffers.length;
		}
	});

	// Acquire and release buffers to exceed high water mark
	const buffers = [];
	for (let i = 0; i < 5; i++) {
		buffers.push(pool.acquire(1024));
	}

	// Release all to trigger return callback
	// Note: Each release may trigger a return if pool exceeds high water mark
	for (const buffer of buffers) {
		pool.release(buffer);
	}

	// Should have returned excess (total released - high water mark)
	await pause();
	assertEquals(returnedSize, 1024);
	assertEquals(totalReturned, 2); // 5 - 3 = 2 excess
	assertEquals(pool.getPoolSizes()[1024], 3);

	pool.stop();
});

// Test: getStats
Deno.test('BufferPool - getStats', async () => {
	const pool = new BufferPool({
		lowWaterMark: 2,
		highWaterMark: 10,
		waterMarks: {
			1024: { low: 5, high: 15 }
		}
	});

	const buffer = pool.acquire(1024);
	await pause();
	pool.release(buffer);
	await pause();

	const stats = pool.getStats();

	assertEquals(stats.sizeClasses, [1024, 4096, 16384, 65536]);
	assertEquals(stats.isWorker, false);

	// Check 1KB stats
	assertEquals(stats.pools[1024].lowWaterMark, 5);
	assertEquals(stats.pools[1024].highWaterMark, 15);
	assertEquals(stats.pools[1024].available, 6); // 5 initial + 1 released
	assertEquals(stats.pools[1024].acquired, 1);
	assertEquals(stats.pools[1024].released, 1);
	assert(stats.pools[1024].allocated >= 5);

	// Check 4KB stats (defaults)
	assertEquals(stats.pools[4096].lowWaterMark, 2);
	assertEquals(stats.pools[4096].highWaterMark, 10);

	pool.stop();
});

// Test: getPoolSizes
Deno.test('BufferPool - getPoolSizes', () => {
	const pool = new BufferPool({ lowWaterMark: 3, highWaterMark: 10 });

	const sizes = pool.getPoolSizes();

	assertEquals(sizes[1024], 3);
	assertEquals(sizes[4096], 3);
	assertEquals(sizes[16384], 3);
	assertEquals(sizes[65536], 3);
});

// Test: getWaterMarks
Deno.test('BufferPool - getWaterMarks', () => {
	const pool = new BufferPool({
		lowWaterMark: 2,
		highWaterMark: 10,
		waterMarks: {
			1024: { low: 5, high: 15 }
		}
	});

	const marks1k = pool.getWaterMarks(1024);
	assertEquals(marks1k.low, 5);
	assertEquals(marks1k.high, 15);

	const marks4k = pool.getWaterMarks(4096);
	assertEquals(marks4k.low, 2);
	assertEquals(marks4k.high, 10);

	const marksInvalid = pool.getWaterMarks(512);
	assertEquals(marksInvalid, null);
});

// Test: clear
Deno.test('BufferPool - clear', () => {
	const pool = new BufferPool({ lowWaterMark: 3, highWaterMark: 10 });

	assertEquals(pool.getPoolSizes()[1024], 3);

	pool.clear();

	assertEquals(pool.getPoolSizes()[1024], 0);
	assertEquals(pool.getPoolSizes()[4096], 0);
	assertEquals(pool.getPoolSizes()[16384], 0);
	assertEquals(pool.getPoolSizes()[65536], 0);
});

// Test: Size classes are sorted
Deno.test('BufferPool - size classes are sorted', () => {
	const pool = new BufferPool({
		sizeClasses: [65536, 1024, 16384, 4096] // Unsorted
	});

	assertEquals(pool.sizeClasses, [1024, 4096, 16384, 65536]); // Should be sorted
});

// Test: Multiple acquire/release cycles
Deno.test('BufferPool - multiple acquire/release cycles', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	const buffers = [];

	// Acquire 5 buffers
	for (let i = 0; i < 5; i++) {
		buffers.push(pool.acquire(1024));
	}
	await pause();

	// Release 3 buffers
	for (let i = 0; i < 3; i++) {
		pool.release(buffers[i]);
		buffers[i] = null; // Clear reference
	}
	await pause();

	// Acquire 2 more
	buffers.push(pool.acquire(1024));
	buffers.push(pool.acquire(1024));
	await pause();

	// Release remaining (5 - 3 released + 2 new = 4 remaining)
	let releaseCount = 0;
	for (const buffer of buffers) {
		if (buffer) {
			pool.release(buffer);
			releaseCount++;
		}
	}
	await pause();

	const stats = pool.getStats();
	assertEquals(stats.pools[1024].acquired, 7); // 5 + 2
	assertEquals(stats.pools[1024].released, 3 + releaseCount); // 3 + 4 = 7

	pool.stop();
});
