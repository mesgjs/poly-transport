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

// Test: Acquire from dirty pool when clean pool is empty
Deno.test('BufferPool - acquire from dirty pool when clean pool empty', async () => {
	const pool = new BufferPool({ lowWaterMark: 0, highWaterMark: 10 });

	// Acquire and release to populate dirty pool
	const buffer1 = pool.acquire(1024);
	const view1 = new Uint8Array(buffer1);
	view1[0] = 42; // Mark buffer
	pool.release(buffer1);

	// Do not pause (dirty buffer will get scrubbed)
	// Clear clean pool (dirty pool should have 1 buffer)
	const stats1 = pool.getStats();
	assertEquals(stats1.pools[1024].dirty, 1);
	assertEquals(stats1.pools[1024].clean, 0);

	// Acquire should get buffer from dirty pool and zero it
	const buffer2 = pool.acquire(1024);
	assertEquals(buffer2, buffer1);
	assertEquals(view1[0], 0); // Should be zeroed

	pool.stop();
});

// Test: Dirty pool scrubbing to reach high water mark
Deno.test('BufferPool - dirty pool scrubbing to high water mark', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 5 });

	// Acquire and release 8 buffers to populate dirty pool
	const buffers = [];
	for (let i = 0; i < 8; i++) {
		buffers.push(pool.acquire(1024));
	}
	for (const buffer of buffers) {
		pool.release(buffer);
	}

	// Wait for async management to scrub dirty buffers
	await pause(2);

	const stats = pool.getStats();
	// Should have high water mark (5) clean buffers
	assertEquals(stats.pools[1024].clean, 5);
	// Excess should be released (8 - 5 = 3 released)
	assertEquals(stats.pools[1024].available, 5);

	pool.stop();
});

// Test: Exact size class boundary
Deno.test('BufferPool - acquire exact size class boundary', () => {
	const pool = new BufferPool();

	// Request exactly 1024 bytes
	const buffer1 = pool.acquire(1024);
	assertEquals(buffer1.byteLength, 1024);

	// Request exactly 4096 bytes
	const buffer2 = pool.acquire(4096);
	assertEquals(buffer2.byteLength, 4096);

	// Request exactly 16384 bytes
	const buffer3 = pool.acquire(16384);
	assertEquals(buffer3.byteLength, 16384);

	// Request exactly 65536 bytes
	const buffer4 = pool.acquire(65536);
	assertEquals(buffer4.byteLength, 65536);

	pool.stop();
});

// Test: Acquire one byte less than size class
Deno.test('BufferPool - acquire one byte less than size class', () => {
	const pool = new BufferPool();

	// Request 1023 bytes, should get 1KB buffer
	const buffer1 = pool.acquire(1023);
	assertEquals(buffer1.byteLength, 1024);

	// Request 4095 bytes, should get 4KB buffer
	const buffer2 = pool.acquire(4095);
	assertEquals(buffer2.byteLength, 4096);

	pool.stop();
});

// Test: Acquire one byte more than size class
Deno.test('BufferPool - acquire one byte more than size class', () => {
	const pool = new BufferPool();

	// Request 1025 bytes, should get 4KB buffer (next size class)
	const buffer1 = pool.acquire(1025);
	assertEquals(buffer1.byteLength, 4096);

	// Request 4097 bytes, should get 16KB buffer
	const buffer2 = pool.acquire(4097);
	assertEquals(buffer2.byteLength, 16384);

	pool.stop();
});

// Test: Stop prevents async management
Deno.test('BufferPool - stop prevents async management', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 5 });

	// Acquire buffers
	const buffers = [];
	for (let i = 0; i < 3; i++) {
		buffers.push(pool.acquire(1024));
	}

	// Stop pool immediately
	pool.stop();

	// Release buffers (should not trigger async management)
	for (const buffer of buffers) {
		pool.release(buffer);
	}

	// Wait to ensure no async management runs
	await pause(2);

	// Pool should have released buffers but no management occurred
	const stats = pool.getStats();
	// Dirty pool should have the released buffers (not cleaned)
	assertEquals(stats.pools[1024].dirty, 3);
});

// Test: Multiple size classes needing management simultaneously
Deno.test('BufferPool - multiple size classes async management', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 5 });

	// Acquire and release buffers from multiple size classes
	const buffers1k = [];
	const buffers4k = [];
	const buffers16k = [];

	for (let i = 0; i < 6; i++) {
		buffers1k.push(pool.acquire(1024));
		buffers4k.push(pool.acquire(4096));
		buffers16k.push(pool.acquire(16384));
	}

	for (const buffer of buffers1k) pool.release(buffer);
	for (const buffer of buffers4k) pool.release(buffer);
	for (const buffer of buffers16k) pool.release(buffer);

	// Wait for async management
	await pause(3);

	const stats = pool.getStats();
	// All size classes should be at high water mark
	assertEquals(stats.pools[1024].available, 5);
	assertEquals(stats.pools[4096].available, 5);
	assertEquals(stats.pools[16384].available, 5);

	pool.stop();
});

// Test: Rapid acquire/release cycles
Deno.test('BufferPool - rapid acquire/release cycles', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	// Perform 20 rapid acquire/release cycles
	for (let i = 0; i < 20; i++) {
		const buffer = pool.acquire(1024);
		pool.release(buffer);
	}

	// Wait for async management to settle
	await pause(2);

	const stats = pool.getStats();
	assertEquals(stats.pools[1024].acquired, 20);
	assertEquals(stats.pools[1024].released, 20);
	// Pool should be at or below high water mark
	assert(stats.pools[1024].available <= 10);

	pool.stop();
});

// Test: Clean and dirty buffer counts in stats
Deno.test('BufferPool - stats show clean and dirty counts', async () => {
	const pool = new BufferPool({ lowWaterMark: 0, highWaterMark: 10 });

	// Acquire and release 3 buffers (should go to dirty pool)
	const buffers = [];
	for (let i = 0; i < 3; i++) {
		buffers.push(pool.acquire(1024));
	}
	for (const buffer of buffers) {
		pool.release(buffer);
	}

	// Before async management, should have dirty buffers
	const stats1 = pool.getStats();
	assertEquals(stats1.pools[1024].dirty, 3);
	assertEquals(stats1.pools[1024].clean, 0);
	assertEquals(stats1.pools[1024].available, 3);

	// After async management, dirty buffers should be cleaned
	await pause(2);
	const stats2 = pool.getStats();
	assertEquals(stats2.pools[1024].clean, 3);
	assertEquals(stats2.pools[1024].dirty, 0);
	assertEquals(stats2.pools[1024].available, 3);

	pool.stop();
});


// Test: Acquire zero bytes
Deno.test('BufferPool - acquire zero bytes', () => {
	const pool = new BufferPool();

	// Request 0 bytes, should get smallest size class (1KB)
	const buffer = pool.acquire(0);
	assertEquals(buffer.byteLength, 1024);

	pool.stop();
});

// Test: Acquire negative size
Deno.test('BufferPool - acquire negative size', () => {
	const pool = new BufferPool();

	// Request negative bytes, should get smallest size class (1KB)
	const buffer = pool.acquire(-100);
	assertEquals(buffer.byteLength, 1024);

	pool.stop();
});

// Test: Release during active async management
Deno.test('BufferPool - release during active async management', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 5 });

	// Acquire and release to trigger management
	const buffers1 = [];
	for (let i = 0; i < 6; i++) {
		buffers1.push(pool.acquire(1024));
	}
	for (const buffer of buffers1) {
		pool.release(buffer);
	}

	// Immediately acquire and release more (during management)
	const buffers2 = [];
	for (let i = 0; i < 3; i++) {
		buffers2.push(pool.acquire(1024));
	}
	for (const buffer of buffers2) {
		pool.release(buffer);
	}

	// Wait for all management to complete
	await pause(3);

	const stats = pool.getStats();
	// Should still enforce high water mark
	assertEquals(stats.pools[1024].available, 5);
	assertEquals(stats.pools[1024].acquired, 9); // 6 + 3
	assertEquals(stats.pools[1024].released, 9);

	pool.stop();
});

// Test: Custom size classes with gaps
Deno.test('BufferPool - custom size classes with gaps', () => {
	const pool = new BufferPool({
		sizeClasses: [1024, 8192, 65536] // Gaps: no 4KB, 16KB, 32KB
	});

	// Request 2KB, should get 8KB (next available)
	const buffer1 = pool.acquire(2048);
	assertEquals(buffer1.byteLength, 8192);

	// Request 10KB, should get 64KB (next available)
	const buffer2 = pool.acquire(10240);
	assertEquals(buffer2.byteLength, 65536);

	// Request 70KB, should return null (exceeds largest)
	const buffer3 = pool.acquire(71680);
	assertEquals(buffer3, null);

	pool.stop();
});

// Test: Single size class pool
Deno.test('BufferPool - single size class pool', async () => {
	const pool = new BufferPool({
		sizeClasses: [4096],
		lowWaterMark: 3,
		highWaterMark: 8
	});

	assertEquals(pool.sizeClasses, [4096]);

	// Any request should use the single size class
	const buffer1 = pool.acquire(100);
	assertEquals(buffer1.byteLength, 4096);

	const buffer2 = pool.acquire(4096);
	assertEquals(buffer2.byteLength, 4096);

	// Request larger than size class should return null
	const buffer3 = pool.acquire(5000);
	assertEquals(buffer3, null);

	await pause();
	pool.stop();
});

// Test: Water marks with low > high (invalid configuration)
Deno.test('BufferPool - water marks low > high still works', async () => {
	// Note: Implementation doesn't validate low <= high, so test actual behavior
	const pool = new BufferPool({
		lowWaterMark: 10,
		highWaterMark: 5 // Invalid: high < low
	});

	// Pool should still function (pre-allocate to low water mark)
	const sizes = pool.getPoolSizes();
	assertEquals(sizes[1024], 10); // Pre-allocated to low water mark

	// Acquire and release
	const buffer = pool.acquire(1024);
	await pause();
	pool.release(buffer);
	await pause();

	// Pool behavior with inverted marks is implementation-defined
	// Just verify it doesn't crash
	const stats = pool.getStats();
	assertExists(stats.pools[1024]);

	pool.stop();
});

// Test: Zero water marks
Deno.test('BufferPool - zero water marks', async () => {
	const pool = new BufferPool({
		lowWaterMark: 0,
		highWaterMark: 0
	});

	// Pool starts empty
	assertEquals(pool.getPoolSizes()[1024], 0);

	// Acquire should allocate new buffer
	const buffer = pool.acquire(1024);
	assertExists(buffer);

	await pause();
	pool.release(buffer);
	await pause();

	// With high water mark 0, released buffer should be dropped
	assertEquals(pool.getPoolSizes()[1024], 0);

	pool.stop();
});

// Test: Very large water marks
Deno.test('BufferPool - very large water marks', () => {
	const pool = new BufferPool({
		lowWaterMark: 100,
		highWaterMark: 1000
	});

	// Pool should pre-allocate to low water mark
	const sizes = pool.getPoolSizes();
	assertEquals(sizes[1024], 100);
	assertEquals(sizes[4096], 100);

	const stats = pool.getStats();
	assertEquals(stats.pools[1024].allocated, 100);

	pool.stop();
});

// Test: Acquire and release different size classes interleaved
Deno.test('BufferPool - interleaved acquire/release different sizes', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	const buffer1k = pool.acquire(1024);
	const buffer4k = pool.acquire(4096);
	const buffer16k = pool.acquire(16384);

	pool.release(buffer4k);
	pool.release(buffer1k);
	pool.release(buffer16k);

	await pause(3);
	pool.stop();

	const stats = pool.getStats();
	assertEquals(stats.pools[1024].acquired, 1);
	assertEquals(stats.pools[1024].released, 1);
	assertEquals(stats.pools[4096].acquired, 1);
	assertEquals(stats.pools[4096].released, 1);
	assertEquals(stats.pools[16384].acquired, 1);
	assertEquals(stats.pools[16384].released, 1);

});

// Test: getWaterMarks returns copy (not reference)
Deno.test('BufferPool - getWaterMarks returns copy', () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	const marks1 = pool.getWaterMarks(1024);
	marks1.low = 999; // Modify returned object

	const marks2 = pool.getWaterMarks(1024);
	assertEquals(marks2.low, 2); // Should still be original value

	pool.stop();
});

// Test: sizeClasses getter returns copy (not reference)
Deno.test('BufferPool - sizeClasses getter returns copy', () => {
	const pool = new BufferPool();

	const classes1 = pool.sizeClasses;
	classes1.push(999999); // Modify returned array

	const classes2 = pool.sizeClasses;
	assertEquals(classes2, [1024, 4096, 16384, 65536]); // Should be unchanged

	pool.stop();
});

// Test: Clear during active operations
Deno.test('BufferPool - clear during active operations', async () => {
	const pool = new BufferPool({ lowWaterMark: 2, highWaterMark: 10 });

	// Acquire buffers
	const buffers = [];
	for (let i = 0; i < 5; i++) {
		buffers.push(pool.acquire(1024));
	}

	// Clear pool (doesn't affect acquired buffers)
	pool.clear();
	assertEquals(pool.getPoolSizes()[1024], 0);

	// Release buffers back
	for (const buffer of buffers) {
		pool.release(buffer);
	}

	await pause(2);

	// Pool should have released buffers
	const stats = pool.getStats();
	assertEquals(stats.pools[1024].released, 5);
	assert(stats.pools[1024].available > 0);

	pool.stop();
});

// Test: Multiple stop calls
Deno.test('BufferPool - multiple stop calls', () => {
	const pool = new BufferPool();

	pool.stop();
	pool.stop(); // Should not throw
	pool.stop(); // Should not throw

	// Pool should remain stopped
	const buffer = pool.acquire(1024);
	assertExists(buffer); // Acquire still works, just no async management
});
