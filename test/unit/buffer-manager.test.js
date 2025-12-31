// Buffer management tests for PolyTransport

import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
	VirtualBuffer,
	VirtualRWBuffer,
	BufferPool,
	BufferManager,
	RingBuffer
} from '../../src/buffer-manager.esm.js';

// ============================================================================
// VirtualBuffer Tests
// ============================================================================

Deno.test('VirtualBuffer: constructor creates empty buffer', () => {
	const vb = new VirtualBuffer();
	assertEquals(vb.length, 0);
});

Deno.test('VirtualBuffer: append single range', () => {
	const vb = new VirtualBuffer();
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	vb.append(data);
	assertEquals(vb.length, 5);
});

Deno.test('VirtualBuffer: append with offset and length', () => {
	const vb = new VirtualBuffer();
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	vb.append(data, 1, 3); // [2, 3, 4]
	assertEquals(vb.length, 3);
});

Deno.test('VirtualBuffer: append multiple ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.append(new Uint8Array([4, 5]));
	vb.append(new Uint8Array([6, 7, 8, 9]));
	assertEquals(vb.length, 9);
});

Deno.test('VirtualBuffer: append rejects non-Uint8Array', () => {
	const vb = new VirtualBuffer();
	assertThrows(() => vb.append([1, 2, 3]), TypeError);
	assertThrows(() => vb.append('hello'), TypeError);
});

Deno.test('VirtualBuffer: append rejects invalid offset', () => {
	const vb = new VirtualBuffer();
	const data = new Uint8Array([1, 2, 3]);
	assertThrows(() => vb.append(data, -1), RangeError);
	assertThrows(() => vb.append(data, 10), RangeError);
});

Deno.test('VirtualBuffer: append rejects invalid length', () => {
	const vb = new VirtualBuffer();
	const data = new Uint8Array([1, 2, 3]);
	assertThrows(() => vb.append(data, 0, -1), RangeError);
	assertThrows(() => vb.append(data, 0, 10), RangeError);
	assertThrows(() => vb.append(data, 2, 5), RangeError);
});

Deno.test('VirtualBuffer: append ignores zero-length ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]), 0, 0);
	assertEquals(vb.length, 0);
});

Deno.test('VirtualBuffer: get reads single byte', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([10, 20, 30]));
	assertEquals(vb.get(0), 10);
	assertEquals(vb.get(1), 20);
	assertEquals(vb.get(2), 30);
});

Deno.test('VirtualBuffer: get reads across ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2]));
	vb.append(new Uint8Array([3, 4]));
	vb.append(new Uint8Array([5, 6]));
	assertEquals(vb.get(0), 1);
	assertEquals(vb.get(1), 2);
	assertEquals(vb.get(2), 3);
	assertEquals(vb.get(3), 4);
	assertEquals(vb.get(4), 5);
	assertEquals(vb.get(5), 6);
});

Deno.test('VirtualBuffer: get rejects out of bounds', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	assertThrows(() => vb.get(-1), RangeError);
	assertThrows(() => vb.get(3), RangeError);
	assertThrows(() => vb.get(10), RangeError);
});

Deno.test('VirtualBuffer: copyTo copies single range', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(5);
	const copied = vb.copyTo(target);
	assertEquals(copied, 5);
	assertEquals(target, new Uint8Array([1, 2, 3, 4, 5]));
});

Deno.test('VirtualBuffer: copyTo copies multiple ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2]));
	vb.append(new Uint8Array([3, 4]));
	vb.append(new Uint8Array([5, 6]));
	const target = new Uint8Array(6);
	const copied = vb.copyTo(target);
	assertEquals(copied, 6);
	assertEquals(target, new Uint8Array([1, 2, 3, 4, 5, 6]));
});

Deno.test('VirtualBuffer: copyTo with target offset', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	const target = new Uint8Array(5);
	const copied = vb.copyTo(target, 2);
	assertEquals(copied, 3);
	assertEquals(target, new Uint8Array([0, 0, 1, 2, 3]));
});

Deno.test('VirtualBuffer: copyTo with virtual offset', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(3);
	const copied = vb.copyTo(target, 0, 2);
	assertEquals(copied, 3);
	assertEquals(target, new Uint8Array([3, 4, 5]));
});

Deno.test('VirtualBuffer: copyTo with length limit', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(10);
	const copied = vb.copyTo(target, 0, 1, 3);
	assertEquals(copied, 3);
	assertEquals(target.subarray(0, 3), new Uint8Array([2, 3, 4]));
});

Deno.test('VirtualBuffer: copyTo clamps to available data', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	const target = new Uint8Array(10);
	const copied = vb.copyTo(target, 0, 0, 100);
	assertEquals(copied, 3);
});

Deno.test('VirtualBuffer: copyTo clamps to target space', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(3);
	const copied = vb.copyTo(target);
	assertEquals(copied, 3);
	assertEquals(target, new Uint8Array([1, 2, 3]));
});

Deno.test('VirtualBuffer: copyTo across range boundaries', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2]));
	vb.append(new Uint8Array([3, 4]));
	vb.append(new Uint8Array([5, 6]));
	const target = new Uint8Array(4);
	const copied = vb.copyTo(target, 0, 1, 4);
	assertEquals(copied, 4);
	assertEquals(target, new Uint8Array([2, 3, 4, 5]));
});

Deno.test('VirtualBuffer: toUint8Array creates copy', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2]));
	vb.append(new Uint8Array([3, 4]));
	vb.append(new Uint8Array([5, 6]));
	const result = vb.toUint8Array();
	assertEquals(result, new Uint8Array([1, 2, 3, 4, 5, 6]));
});

Deno.test('VirtualBuffer: consume removes bytes from start', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3, 4, 5]));
	vb.consume(2);
	assertEquals(vb.length, 3);
	assertEquals(vb.get(0), 3);
	assertEquals(vb.get(1), 4);
	assertEquals(vb.get(2), 5);
});

Deno.test('VirtualBuffer: consume removes entire ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2]));
	vb.append(new Uint8Array([3, 4]));
	vb.append(new Uint8Array([5, 6]));
	vb.consume(2);
	assertEquals(vb.length, 4);
	assertEquals(vb.get(0), 3);
});

Deno.test('VirtualBuffer: consume removes partial ranges', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.append(new Uint8Array([4, 5, 6]));
	vb.consume(4);
	assertEquals(vb.length, 2);
	assertEquals(vb.get(0), 5);
	assertEquals(vb.get(1), 6);
});

Deno.test('VirtualBuffer: consume all bytes', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.consume(3);
	assertEquals(vb.length, 0);
});

Deno.test('VirtualBuffer: consume zero bytes is no-op', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.consume(0);
	assertEquals(vb.length, 3);
});

Deno.test('VirtualBuffer: consume rejects negative count', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	assertThrows(() => vb.consume(-1), RangeError);
});

Deno.test('VirtualBuffer: consume rejects too many bytes', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	assertThrows(() => vb.consume(10), RangeError);
});

Deno.test('VirtualBuffer: clear removes all data', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.clear();
	assertEquals(vb.length, 0);
});

// ============================================================================
// VirtualRWBuffer Tests
// ============================================================================

Deno.test('VirtualRWBuffer: set writes across ranges', () => {
	const vb = new VirtualRWBuffer();
	const a = new Uint8Array([1, 2]);
	const b = new Uint8Array([3, 4]);
	vb.append(a);
	vb.append(b);
	assertEquals(vb.length, 4);

	vb.set(0, 10);
	vb.set(3, 40);
	assertEquals(a, new Uint8Array([10, 2]));
	assertEquals(b, new Uint8Array([3, 40]));
});

Deno.test('VirtualRWBuffer: copyFrom writes multiple ranges', () => {
	const vb = new VirtualRWBuffer();
	const a = new Uint8Array(2);
	const b = new Uint8Array(2);
	vb.append(a);
	vb.append(b);

	const written = vb.copyFrom(new Uint8Array([1, 2, 3, 4]));
	assertEquals(written, 4);
	assertEquals(a, new Uint8Array([1, 2]));
	assertEquals(b, new Uint8Array([3, 4]));
});

// ============================================================================
// BufferPool Tests
// ============================================================================

Deno.test('BufferPool: constructor with defaults', () => {
	const pool = new BufferPool();
	assertEquals(pool.minSize, 1024);
	assertEquals(pool.maxSize, 1024 * 1024);
	assertEquals(pool.maxPoolSize, 100);
});

Deno.test('BufferPool: constructor with custom options', () => {
	const pool = new BufferPool({
		minSize: 512,
		maxSize: 64 * 1024,
		maxPoolSize: 50
	});
	assertEquals(pool.minSize, 512);
	assertEquals(pool.maxSize, 64 * 1024);
	assertEquals(pool.maxPoolSize, 50);
});

Deno.test('BufferPool: getSizeClass rounds to power of 2', () => {
	const pool = new BufferPool({ minSize: 1024, maxSize: 1024 * 1024 });
	assertEquals(pool.getSizeClass(100), 1024);
	assertEquals(pool.getSizeClass(1024), 1024);
	assertEquals(pool.getSizeClass(1025), 2048);
	assertEquals(pool.getSizeClass(2048), 2048);
	assertEquals(pool.getSizeClass(3000), 4096);
	assertEquals(pool.getSizeClass(8192), 8192);
});

Deno.test('BufferPool: getSizeClass clamps to min/max', () => {
	const pool = new BufferPool({ minSize: 1024, maxSize: 64 * 1024 });
	assertEquals(pool.getSizeClass(100), 1024);
	assertEquals(pool.getSizeClass(1000000), 64 * 1024);
});

Deno.test('BufferPool: allocate creates new buffer', () => {
	const pool = new BufferPool();
	const buffer = pool.allocate(2048);
	assertEquals(buffer instanceof Uint8Array, true);
	assertEquals(buffer.length >= 2048, true);
});

Deno.test('BufferPool: allocate returns pooled buffer', () => {
	const pool = new BufferPool();
	const buffer1 = pool.allocate(2048);
	pool.release(buffer1);
	const buffer2 = pool.allocate(2048);
	assertEquals(buffer1, buffer2); // Same buffer instance
});

Deno.test('BufferPool: release adds buffer to pool', () => {
	const pool = new BufferPool();
	const buffer = pool.allocate(2048);
	pool.release(buffer);
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 1);
});

Deno.test('BufferPool: release ignores non-Uint8Array', () => {
	const pool = new BufferPool();
	pool.release([1, 2, 3]);
	pool.release('hello');
	pool.release(null);
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 0);
});

Deno.test('BufferPool: release ignores odd-sized buffers', () => {
	const pool = new BufferPool({ minSize: 1024 });
	const buffer = new Uint8Array(1500); // Not a power of 2
	pool.release(buffer);
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 0);
});

Deno.test('BufferPool: respects maxPoolSize', () => {
	const pool = new BufferPool({ maxPoolSize: 2 });
	const buffers = [];
	for (let i = 0; i < 5; i++) {
		buffers.push(pool.allocate(2048));
	}
	for (const buffer of buffers) {
		pool.release(buffer);
	}
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 2);
});

Deno.test('BufferPool: clear removes all buffers', () => {
	const pool = new BufferPool();
	pool.release(pool.allocate(2048));
	pool.release(pool.allocate(4096));
	pool.clear();
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 0);
});

Deno.test('BufferPool: getStats returns accurate info', () => {
	const pool = new BufferPool({ minSize: 1024 });
	const buf1 = pool.allocate(1024);
	const buf2 = pool.allocate(1024);
	const buf3 = pool.allocate(2048);
	pool.release(buf1);
	pool.release(buf2);
	pool.release(buf3);
	const stats = pool.getStats();
	assertEquals(stats.totalBuffers, 3);
	assertEquals(stats.sizeClasses.length, 2);
});

// ============================================================================
// BufferManager Tests
// ============================================================================

Deno.test('BufferManager: constructor with default pool', () => {
	const manager = new BufferManager();
	assertEquals(manager.pool instanceof BufferPool, true);
});

Deno.test('BufferManager: constructor with custom pool', () => {
	const pool = new BufferPool({ minSize: 512 });
	const manager = new BufferManager(pool);
	assertEquals(manager.pool, pool);
});

Deno.test('BufferManager: allocate creates managed buffer', () => {
	const manager = new BufferManager();
	const buffer = manager.allocate(2048);
	assertEquals(buffer instanceof Uint8Array, true);
	assertEquals(manager.getRefCount(buffer), 1);
});

Deno.test('BufferManager: addRef increments count', () => {
	const manager = new BufferManager();
	const buffer = manager.allocate(2048);
	manager.addRef(buffer);
	assertEquals(manager.getRefCount(buffer), 2);
});

Deno.test('BufferManager: addRef returns false for unmanaged buffer', () => {
	const manager = new BufferManager();
	const buffer = new Uint8Array(100);
	assertEquals(manager.addRef(buffer), false);
});

Deno.test('BufferManager: release decrements count', () => {
	const manager = new BufferManager();
	const buffer = manager.allocate(2048);
	manager.addRef(buffer);
	manager.release(buffer);
	assertEquals(manager.getRefCount(buffer), 1);
});

Deno.test('BufferManager: release returns buffer to pool at zero', () => {
	const manager = new BufferManager();
	const buffer = manager.allocate(2048);
	const released = manager.release(buffer);
	assertEquals(released, true);
	assertEquals(manager.getRefCount(buffer), 0);
});

Deno.test('BufferManager: release returns false for unmanaged buffer', () => {
	const manager = new BufferManager();
	const buffer = new Uint8Array(100);
	assertEquals(manager.release(buffer), false);
});

Deno.test('BufferManager: getRefCount returns 0 for unmanaged', () => {
	const manager = new BufferManager();
	const buffer = new Uint8Array(100);
	assertEquals(manager.getRefCount(buffer), 0);
});

Deno.test('BufferManager: getStats returns accurate info', () => {
	const manager = new BufferManager();
	const buffer1 = manager.allocate(2048);
	const buffer2 = manager.allocate(4096);
	manager.addRef(buffer1);
	const stats = manager.getStats();
	assertEquals(stats.managedBuffers, 2);
	assertEquals(stats.totalRefs, 3); // buffer1 has 2, buffer2 has 1
});

Deno.test('BufferManager: released buffer can be reused', () => {
	const manager = new BufferManager();
	const buffer1 = manager.allocate(2048);
	manager.release(buffer1);
	const buffer2 = manager.allocate(2048);
	assertEquals(buffer1, buffer2); // Same buffer from pool
});

// ============================================================================
// RingBuffer Tests
// ============================================================================

Deno.test('RingBuffer: constructor creates buffer', () => {
	const ring = new RingBuffer(100);
	assertEquals(ring.size, 100);
	assertEquals(ring.available, 0);
	assertEquals(ring.space, 100);
});

Deno.test('RingBuffer: constructor rejects invalid size', () => {
	assertThrows(() => new RingBuffer(0), TypeError);
	assertThrows(() => new RingBuffer(-1), TypeError);
	assertThrows(() => new RingBuffer(1.5), TypeError);
});

Deno.test('RingBuffer: write adds data', () => {
	const ring = new RingBuffer(100);
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const written = ring.write(data);
	assertEquals(written, 5);
	assertEquals(ring.available, 5);
	assertEquals(ring.space, 95);
});

Deno.test('RingBuffer: write with offset and length', () => {
	const ring = new RingBuffer(100);
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const written = ring.write(data, 1, 3);
	assertEquals(written, 3);
	assertEquals(ring.available, 3);
});

Deno.test('RingBuffer: write wraps around', () => {
	const ring = new RingBuffer(10);
	ring.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	ring.read(new Uint8Array(5)); // Read 5, freeing space
	const written = ring.write(new Uint8Array([9, 10, 11, 12, 13]));
	assertEquals(written, 5);
	assertEquals(ring.available, 8);
});

Deno.test('RingBuffer: write clamps to available space', () => {
	const ring = new RingBuffer(10);
	const data = new Uint8Array(20);
	const written = ring.write(data);
	assertEquals(written, 10);
	assertEquals(ring.space, 0);
});

Deno.test('RingBuffer: write rejects non-Uint8Array', () => {
	const ring = new RingBuffer(100);
	assertThrows(() => ring.write([1, 2, 3]), TypeError);
});

Deno.test('RingBuffer: read extracts data', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(5);
	const read = ring.read(target);
	assertEquals(read, 5);
	assertEquals(target, new Uint8Array([1, 2, 3, 4, 5]));
	assertEquals(ring.available, 0);
});

Deno.test('RingBuffer: read with target offset and length', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(10);
	const read = ring.read(target, 2, 3);
	assertEquals(read, 3);
	assertEquals(target.subarray(2, 5), new Uint8Array([1, 2, 3]));
	assertEquals(ring.available, 2);
});

Deno.test('RingBuffer: read wraps around', () => {
	const ring = new RingBuffer(10);
	ring.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	ring.read(new Uint8Array(5)); // Read 5
	ring.write(new Uint8Array([9, 10, 11, 12, 13])); // Write 5 (wraps)
	const target = new Uint8Array(8);
	const read = ring.read(target);
	assertEquals(read, 8);
	assertEquals(target, new Uint8Array([6, 7, 8, 9, 10, 11, 12, 13]));
});

Deno.test('RingBuffer: read clamps to available data', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3]));
	const target = new Uint8Array(10);
	const read = ring.read(target);
	assertEquals(read, 3);
});

Deno.test('RingBuffer: read rejects non-Uint8Array', () => {
	const ring = new RingBuffer(100);
	assertThrows(() => ring.read([1, 2, 3]), TypeError);
});

Deno.test('RingBuffer: peek reads without consuming', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	const target = new Uint8Array(3);
	const peeked = ring.peek(target);
	assertEquals(peeked, 3);
	assertEquals(target, new Uint8Array([1, 2, 3]));
	assertEquals(ring.available, 5); // Still 5
});

Deno.test('RingBuffer: peek wraps around', () => {
	const ring = new RingBuffer(10);
	ring.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	ring.read(new Uint8Array(5));
	ring.write(new Uint8Array([9, 10, 11, 12, 13]));
	const target = new Uint8Array(8);
	const peeked = ring.peek(target);
	assertEquals(peeked, 8);
	assertEquals(target, new Uint8Array([6, 7, 8, 9, 10, 11, 12, 13]));
	assertEquals(ring.available, 8); // Unchanged
});

Deno.test('RingBuffer: skip consumes without reading', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	const skipped = ring.skip(3);
	assertEquals(skipped, 3);
	assertEquals(ring.available, 2);
	const target = new Uint8Array(2);
	ring.read(target);
	assertEquals(target, new Uint8Array([4, 5]));
});

Deno.test('RingBuffer: skip clamps to available', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3]));
	const skipped = ring.skip(10);
	assertEquals(skipped, 3);
	assertEquals(ring.available, 0);
});

Deno.test('RingBuffer: clear resets buffer', () => {
	const ring = new RingBuffer(100);
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	ring.clear();
	assertEquals(ring.available, 0);
	assertEquals(ring.space, 100);
});

Deno.test('RingBuffer: full write-read cycle', () => {
	const ring = new RingBuffer(10);
	
	// Write some data
	ring.write(new Uint8Array([1, 2, 3, 4, 5]));
	assertEquals(ring.available, 5);
	
	// Read part of it
	const target1 = new Uint8Array(3);
	ring.read(target1);
	assertEquals(target1, new Uint8Array([1, 2, 3]));
	assertEquals(ring.available, 2);
	
	// Write more (will wrap) - only 8 bytes fit
	const written = ring.write(new Uint8Array([6, 7, 8, 9, 10, 11, 12, 13]));
	assertEquals(written, 8); // Only 8 bytes written (10 capacity - 2 used)
	assertEquals(ring.available, 10);
	
	// Read all
	const target2 = new Uint8Array(10);
	ring.read(target2);
	assertEquals(target2, new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
	assertEquals(ring.available, 0);
});

Deno.test('RingBuffer: pinned virtual buffer migrates before overwrite', async () => {
	const manager = new BufferManager();
	const ring = new RingBuffer(10);

	// Fill the ring.
	ring.write(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
	assertEquals(ring.available, 10);
	assertEquals(ring.space, 0);

	// Create a pinned view of the first 5 bytes.
	const view = ring.peekPinnedVirtualBuffer(5, { bufferManager: manager });
	assertEquals(view.toUint8Array(), new Uint8Array([0, 1, 2, 3, 4]));
	assertEquals(ring.pinnedCount, 1);

	// Consume those bytes, making physical space that would overwrite the pinned region.
	ring.skip(5);
	assertEquals(ring.available, 5);
	assertEquals(ring.space, 5);

	// This write would reuse indices [0..4], so it must trigger migration.
	await ring.writeWithReclaim(new Uint8Array([10, 11, 12, 13, 14]));
	assertEquals(ring.pinnedCount, 0);

	// The pinned view should still see the original bytes (now pool-backed).
	assertEquals(view.toUint8Array(), new Uint8Array([0, 1, 2, 3, 4]));

	// And the ring should contain the remaining 5 old bytes + the new 5 bytes.
	const out = new Uint8Array(10);
	ring.read(out);
	assertEquals(out, new Uint8Array([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
});
