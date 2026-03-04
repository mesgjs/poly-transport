import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';

Deno.test('VirtualRWBuffer - construction', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(data);
	
	assertEquals(vb.length, 5);
	assertEquals(Array.from(vb.toUint8Array()), [1, 2, 3, 4, 5]);
});

Deno.test('VirtualRWBuffer - set with Uint8Array', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	const source = new Uint8Array([10, 20, 30]);
	const written = vb.set(source, 1);
	
	assertEquals(written, 3);
	assertEquals(Array.from(buffer), [0, 10, 20, 30, 0]);
});

Deno.test('VirtualRWBuffer - set at start', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	const source = new Uint8Array([10, 20]);
	const written = vb.set(source);
	
	assertEquals(written, 2);
	assertEquals(Array.from(buffer), [10, 20, 0, 0, 0]);
});

Deno.test('VirtualRWBuffer - set truncates if source too large', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	const source = new Uint8Array([10, 20, 30, 40, 50]);
	const written = vb.set(source);
	
	assertEquals(written, 3);
	assertEquals(Array.from(buffer), [10, 20, 30]);
});

Deno.test('VirtualRWBuffer - set across segments', () => {
	const buf1 = new Uint8Array([0, 0, 0]);
	const buf2 = new Uint8Array([0, 0, 0]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	const source = new Uint8Array([10, 20, 30, 40, 50]);
	const written = vb.set(source, 1);
	
	assertEquals(written, 5);
	assertEquals(Array.from(buf1), [0, 10, 20]);
	assertEquals(Array.from(buf2), [30, 40, 50]);
});

Deno.test('VirtualRWBuffer - set with VirtualBuffer source', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	const source = new VirtualRWBuffer(new Uint8Array([10, 20, 30]));
	const written = vb.set(source, 1);
	
	assertEquals(written, 3);
	assertEquals(Array.from(buffer), [0, 10, 20, 30, 0]);
});

Deno.test('VirtualRWBuffer - set with invalid offset', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.set(new Uint8Array([1, 2]), 3),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - set with invalid source type', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.set('invalid'),
		TypeError,
		'Source must be Uint8Array or VirtualBuffer'
	);
});

Deno.test('VirtualRWBuffer - fill entire buffer', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.fill(42);
	
	assertEquals(Array.from(buffer), [42, 42, 42, 42, 42]);
});

Deno.test('VirtualRWBuffer - fill with range', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.fill(42, 1, 4);
	
	assertEquals(Array.from(buffer), [0, 42, 42, 42, 0]);
});

Deno.test('VirtualRWBuffer - fill with negative indices', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.fill(42, -3, -1);
	
	assertEquals(Array.from(buffer), [0, 0, 42, 42, 0]);
});

Deno.test('VirtualRWBuffer - fill across segments', () => {
	const buf1 = new Uint8Array([0, 0, 0]);
	const buf2 = new Uint8Array([0, 0, 0]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	vb.fill(42, 1, 5);
	
	assertEquals(Array.from(buf1), [0, 42, 42]);
	assertEquals(Array.from(buf2), [42, 42, 0]);
});

Deno.test('VirtualRWBuffer - fill returns this for chaining', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	const result = vb.fill(42);
	
	assertEquals(result, vb);
});

Deno.test('VirtualRWBuffer - encodeFrom simple string', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	const result = vb.encodeFrom('Hello');
	
	assertEquals(result.read, 5);
	assertEquals(result.written, 5);
	assertEquals(Array.from(buffer.slice(0, 5)), [72, 101, 108, 108, 111]); // 'Hello'
});

Deno.test('VirtualRWBuffer - encodeFrom with offset', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	const result = vb.encodeFrom('Hello', 5);
	
	assertEquals(result.read, 5);
	assertEquals(result.written, 5);
	assertEquals(Array.from(buffer.slice(5, 10)), [72, 101, 108, 108, 111]);
	assertEquals(Array.from(buffer.slice(0, 5)), [0, 0, 0, 0, 0]);
});

Deno.test('VirtualRWBuffer - encodeFrom multi-byte characters', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	const result = vb.encodeFrom('世界');
	
	assertEquals(result.read, 2); // 2 UTF-16 code units
	assertEquals(result.written, 6); // 6 UTF-8 bytes (3 bytes per character)
	
	// Verify the encoded bytes
	const decoder = new TextDecoder();
	assertEquals(decoder.decode(buffer.slice(0, 6)), '世界');
});

Deno.test('VirtualRWBuffer - encodeFrom truncates if buffer too small', () => {
	const buffer = new Uint8Array(3);
	const vb = new VirtualRWBuffer(buffer);
	
	const result = vb.encodeFrom('Hello');
	
	assertEquals(result.read, 3); // Only 3 characters fit
	assertEquals(result.written, 3);
	assertEquals(Array.from(buffer), [72, 101, 108]); // 'Hel'
});

Deno.test('VirtualRWBuffer - encodeFrom across segments', () => {
	const buf1 = new Uint8Array(3);
	const buf2 = new Uint8Array(3);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	const result = vb.encodeFrom('Hello!');
	
	assertEquals(result.read, 6);
	assertEquals(result.written, 6);
	assertEquals(Array.from(buf1), [72, 101, 108]); // 'Hel'
	assertEquals(Array.from(buf2), [108, 111, 33]); // 'lo!'
});

Deno.test('VirtualRWBuffer - encodeFrom with invalid offset', () => {
	const buffer = new Uint8Array(10);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.encodeFrom('Hello', 10),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - encodeFrom with unsupported encoding', () => {
	const buffer = new Uint8Array(10);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.encodeFrom('Hello', 0, 'utf-16'),
		Error,
		'Only utf-8 encoding is currently supported'
	);
});

Deno.test('VirtualRWBuffer - shrink to smaller size', () => {
	const buffer = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.shrink(3);
	
	assertEquals(vb.length, 3);
	assertEquals(Array.from(vb.toUint8Array()), [1, 2, 3]);
});

Deno.test('VirtualRWBuffer - shrink to zero', () => {
	const buffer = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.shrink(0);
	
	assertEquals(vb.length, 0);
	assertEquals(Array.from(vb.toUint8Array()), []);
});

Deno.test('VirtualRWBuffer - shrink to same size is no-op', () => {
	const buffer = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.shrink(5);
	
	assertEquals(vb.length, 5);
	assertEquals(Array.from(vb.toUint8Array()), [1, 2, 3, 4, 5]);
});

Deno.test('VirtualRWBuffer - shrink across segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	vb.shrink(4);
	
	assertEquals(vb.length, 4);
	assertEquals(vb.segmentCount, 2);
	assertEquals(Array.from(vb.toUint8Array()), [1, 2, 3, 4]);
});

Deno.test('VirtualRWBuffer - shrink partial segment', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	vb.shrink(2);
	
	assertEquals(vb.length, 2);
	assertEquals(vb.segmentCount, 1);
	assertEquals(Array.from(vb.toUint8Array()), [1, 2]);
});

Deno.test('VirtualRWBuffer - shrink with invalid size', () => {
	const buffer = new Uint8Array([1, 2, 3]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.shrink(5),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.shrink(-1),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - release partial segment', () => {
	const buffer = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(buffer);
	
	const success = vb.release(2);
	
	assertEquals(success, true);
	assertEquals(vb.length, 3);
	assertEquals(Array.from(vb.toUint8Array()), [3, 4, 5]);
});

Deno.test('VirtualRWBuffer - release full segment', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	const success = vb.release(3);
	
	assertEquals(success, true);
	assertEquals(vb.length, 3);
	assertEquals(vb.segmentCount, 1);
	assertEquals(Array.from(vb.toUint8Array()), [4, 5, 6]);
});

Deno.test('VirtualRWBuffer - release across segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	const success = vb.release(4);
	
	assertEquals(success, true);
	assertEquals(vb.length, 2);
	assertEquals(vb.segmentCount, 1);
	assertEquals(Array.from(vb.toUint8Array()), [5, 6]);
});

Deno.test('VirtualRWBuffer - release more than available', () => {
	const buffer = new Uint8Array([1, 2, 3]);
	const vb = new VirtualRWBuffer(buffer);
	
	const success = vb.release(5);
	
	assertEquals(success, false);
	assertEquals(vb.length, 3); // Should not change
});

Deno.test('VirtualRWBuffer - release with pool', () => {
	// Mock buffer pool
	const releasedBuffers = [];
	const mockPool = {
		release: (buffer) => {
			releasedBuffers.push(buffer);
		}
	};
	
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
	const vb = new VirtualRWBuffer(segments);
	
	vb.release(3, mockPool);
	
	assertEquals(releasedBuffers.length, 1);
	assertEquals(releasedBuffers[0], buf1.buffer);
});

Deno.test('VirtualRWBuffer - combined operations', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	// Fill with zeros
	vb.fill(0);
	
	// Write some data
	vb.set(new Uint8Array([1, 2, 3]), 0);
	
	// Encode a string
	const result = vb.encodeFrom('Hi', 5);
	
	// Fill a range
	vb.fill(99, 10, 15);
	
	assertEquals(Array.from(buffer.slice(0, 3)), [1, 2, 3]);
	assertEquals(Array.from(buffer.slice(5, 7)), [72, 105]); // 'Hi'
	assertEquals(Array.from(buffer.slice(10, 15)), [99, 99, 99, 99, 99]);
});

Deno.test('VirtualRWBuffer - inherits VirtualBuffer methods', () => {
	const buffer = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualRWBuffer(buffer);
	
	// Test slice
	const slice = vb.slice(1, 4);
	assertEquals(Array.from(slice.toUint8Array()), [2, 3, 4]);
	
	// Test concat
	const other = new VirtualRWBuffer(new Uint8Array([6, 7]));
	const combined = vb.concat(other);
	assertEquals(combined.length, 7);
	assertEquals(Array.from(combined.toUint8Array()), [1, 2, 3, 4, 5, 6, 7]);
});
