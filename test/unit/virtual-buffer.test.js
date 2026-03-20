import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { VirtualBuffer } from '../../src/virtual-buffer.esm.js';

Deno.test('VirtualBuffer - construction from Uint8Array', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);

	assertEquals(vb.length, 5);
	assertEquals(vb.byteLength, 5);
	assertEquals(vb.segmentCount, 1);
});

Deno.test('VirtualBuffer - construction from segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);

	assertEquals(vb.length, 6);
	assertEquals(vb.segmentCount, 2);
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [1, 2, 3, 4, 5, 6]);
});

Deno.test('VirtualBuffer - empty construction', () => {
	const vb = new VirtualBuffer();

	assertEquals(vb.length, 0);
	assertEquals(vb.segmentCount, 0);
});

Deno.test('VirtualBuffer - append Uint8Array', () => {
	const vb = new VirtualBuffer();
	vb.append(new Uint8Array([1, 2, 3]));
	vb.append(new Uint8Array([4, 5]));

	assertEquals(vb.length, 5);
	assertEquals(vb.segmentCount, 2);
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [1, 2, 3, 4, 5]);
});

Deno.test('VirtualBuffer - append segments', () => {
	const vb = new VirtualBuffer();
	const buf1 = new Uint8Array([1, 2, 3]);
	const segments = [
		buf1.subarray(0, 2),
		buf1.subarray(2, 3)
	];
	vb.append(segments);

	assertEquals(vb.length, 3);
	assertEquals(vb.segmentCount, 2);
});

Deno.test('VirtualBuffer - append VirtualBuffer', () => {
	const vb1 = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	const vb2 = new VirtualBuffer(new Uint8Array([4, 5, 6]));

	vb1.append(vb2);

	assertEquals(vb1.length, 6);
	assertEquals(vb1.segmentCount, 2);
	const result = vb1.toUint8Array();
	assertEquals(Array.from(result), [1, 2, 3, 4, 5, 6]);
});

Deno.test('VirtualBuffer - append zero-length segment', () => {
	const vb = new VirtualBuffer();
	const segments = [
		new Uint8Array(0), // Zero length
		new Uint8Array([4, 5, 6])
	];
	vb.append(segments);

	assertEquals(vb.length, 3);
	assertEquals(vb.segmentCount, 1); // Zero-length segment should be skipped
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [4, 5, 6]);
});

Deno.test('VirtualBuffer - append zero-length Uint8Array', () => {
	const vb = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	vb.append(new Uint8Array(0)); // Zero length

	assertEquals(vb.length, 3); // Should not change
	assertEquals(vb.segmentCount, 1);
});

Deno.test('VirtualBuffer - slice basic', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const slice = vb.slice(1, 4);

	assertEquals(slice.length, 3);
	const result = slice.toUint8Array();
	assertEquals(Array.from(result), [2, 3, 4]);
});

Deno.test('VirtualBuffer - slice with negative indices', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const slice = vb.slice(-3, -1);

	assertEquals(slice.length, 2);
	const result = slice.toUint8Array();
	assertEquals(Array.from(result), [3, 4]);
});

Deno.test('VirtualBuffer - slice with defaults', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const slice = vb.slice();

	assertEquals(slice.length, 5);
	const result = slice.toUint8Array();
	assertEquals(Array.from(result), [1, 2, 3, 4, 5]);
});

Deno.test('VirtualBuffer - slice empty range', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const slice = vb.slice(2, 2);

	assertEquals(slice.length, 0);
});

Deno.test('VirtualBuffer - slice across segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	const slice = vb.slice(1, 5);

	assertEquals(slice.length, 4);
	assertEquals(slice.segmentCount, 2);
	const result = slice.toUint8Array();
	assertEquals(Array.from(result), [2, 3, 4, 5]);
});

Deno.test('VirtualBuffer - toUint8Array single segment always copies', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const result = vb.toUint8Array();

	// Should always copy for security (not the same buffer)
	assertEquals(Array.from(result), [1, 2, 3, 4, 5]);
	assertEquals(result.buffer !== data.buffer, true);
});

Deno.test('VirtualBuffer - toUint8Array multiple segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	const result = vb.toUint8Array();

	assertEquals(Array.from(result), [1, 2, 3, 4, 5, 6]);
	// Should be a new buffer (copy required)
	assertEquals(result.buffer !== buf1.buffer && result.buffer !== buf2.buffer, true);
});

Deno.test('VirtualBuffer - concat', () => {
	const vb1 = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	const vb2 = new VirtualBuffer(new Uint8Array([4, 5, 6]));
	const result = vb1.concat(vb2);

	assertEquals(result.length, 6);
	assertEquals(result.segmentCount, 2);
	const data = result.toUint8Array();
	assertEquals(Array.from(data), [1, 2, 3, 4, 5, 6]);
});

Deno.test('VirtualBuffer - concat with multi-segment buffers', () => {
	const vb1 = new VirtualBuffer();
	vb1.append(new Uint8Array([1, 2]));
	vb1.append(new Uint8Array([3]));

	const vb2 = new VirtualBuffer();
	vb2.append(new Uint8Array([4, 5]));
	vb2.append(new Uint8Array([6]));

	const result = vb1.concat(vb2);

	assertEquals(result.length, 6);
	assertEquals(result.segmentCount, 4);
	const data = result.toUint8Array();
	assertEquals(Array.from(data), [1, 2, 3, 4, 5, 6]);
});

Deno.test('VirtualBuffer - concat does not share segment references', () => {
	const vb1 = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	const vb2 = new VirtualBuffer(new Uint8Array([4, 5, 6]));
	const result = vb1.concat(vb2);

	// Modifying original should not affect concat result
	vb1.append(new Uint8Array([7, 8]));

	assertEquals(result.length, 6);
	assertEquals(vb1.length, 5);
});

Deno.test('VirtualBuffer - decode UTF-8 single segment', () => {
	const encoder = new TextEncoder();
	const data = encoder.encode('Hello, World!');
	const vb = new VirtualBuffer(data);
	const result = vb.decode();

	assertEquals(result, 'Hello, World!');
});

Deno.test('VirtualBuffer - decode UTF-8 with range', () => {
	const encoder = new TextEncoder();
	const data = encoder.encode('Hello, World!');
	const vb = new VirtualBuffer(data);
	const result = vb.decode({ start: 7, end: 12 });

	assertEquals(result, 'World');
});

Deno.test('VirtualBuffer - decode UTF-8 multi-segment', () => {
	const encoder = new TextEncoder();
	const part1 = encoder.encode('Hello, ');
	const part2 = encoder.encode('World!');
	const segments = [part1, part2];
	const vb = new VirtualBuffer(segments);
	const result = vb.decode();

	assertEquals(result, 'Hello, World!');
});

Deno.test('VirtualBuffer - decode UTF-8 multi-byte characters', () => {
	const encoder = new TextEncoder();
	const data = encoder.encode('Hello 世界 🌍');
	const vb = new VirtualBuffer(data);
	const result = vb.decode();

	assertEquals(result, 'Hello 世界 🌍');
});

Deno.test('VirtualBuffer - decode UTF-8 multi-byte split across segments', () => {
	const encoder = new TextEncoder();
	const fullText = 'Hello 世界';
	const fullData = encoder.encode(fullText);

	// Split in the middle of a multi-byte character
	// '世' is 3 bytes in UTF-8: E4 B8 96
	const splitPoint = 8; // After "Hello " and first 2 bytes of '世'

	const part1 = fullData.slice(0, splitPoint);
	const part2 = fullData.slice(splitPoint);

	const segments = [part1, part2];
	const vb = new VirtualBuffer(segments);
	const result = vb.decode();

	assertEquals(result, fullText);
});

Deno.test('VirtualBuffer - decode empty buffer', () => {
	const vb = new VirtualBuffer();
	const result = vb.decode();

	assertEquals(result, '');
});

Deno.test('VirtualBuffer - decode with negative range', () => {
	const encoder = new TextEncoder();
	const data = encoder.encode('Hello, World!');
	const vb = new VirtualBuffer(data);
	const result = vb.decode({ start: -6, end: -1 });

	assertEquals(result, 'World');
});

Deno.test('VirtualBuffer - invalid source type', () => {
	assertThrows(
		() => new VirtualBuffer('invalid'),
		TypeError,
		'Source must be Uint8Array, VirtualBuffer, or array of Uint8Array'
	);
});

Deno.test('VirtualBuffer - concat with non-VirtualBuffer', () => {
	const vb = new VirtualBuffer(new Uint8Array([1, 2, 3]));

	assertThrows(
		() => vb.concat(new Uint8Array([4, 5, 6])),
		TypeError,
		'Can only concat with another VirtualBuffer'
	);
});

Deno.test('VirtualBuffer - toUint8Array with provided buffer', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const destBuffer = new Uint8Array(10); // Larger than needed

	const result = vb.toUint8Array(destBuffer);

	// Should return the same buffer
	assertEquals(result, destBuffer);
	// Should copy data into buffer
	assertEquals(Array.from(result.slice(0, 5)), [1, 2, 3, 4, 5]);
	// Rest should be zeros
	assertEquals(Array.from(result.slice(5)), [0, 0, 0, 0, 0]);
});

Deno.test('VirtualBuffer - toUint8Array with exact-size buffer', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const destBuffer = new Uint8Array(5);

	const result = vb.toUint8Array(destBuffer);

	assertEquals(result, destBuffer);
	assertEquals(Array.from(result), [1, 2, 3, 4, 5]);
});

Deno.test('VirtualBuffer - toUint8Array with multi-segment and provided buffer', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	const destBuffer = new Uint8Array(6);

	const result = vb.toUint8Array(destBuffer);

	assertEquals(result, destBuffer);
	assertEquals(Array.from(result), [1, 2, 3, 4, 5, 6]);
});

Deno.test('VirtualBuffer - toUint8Array with empty buffer and provided buffer', () => {
	const vb = new VirtualBuffer();
	const destBuffer = new Uint8Array(10);

	const result = vb.toUint8Array(destBuffer);

	// Should return the provided buffer even for empty VirtualBuffer
	assertEquals(result, destBuffer);
});

Deno.test('VirtualBuffer - toUint8Array with buffer too small', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);
	const destBuffer = new Uint8Array(3); // Too small

	assertThrows(
		() => vb.toUint8Array(destBuffer),
		RangeError,
		'Buffer too small: need 5 bytes, got 3'
	);
});

Deno.test('VirtualBuffer - toUint8Array with invalid buffer type', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);

	assertThrows(
		() => vb.toUint8Array([1, 2, 3, 4, 5]),
		TypeError,
		'Buffer must be a Uint8Array'
	);
});

Deno.test('VirtualBuffer - toPool with BufferPool', async () => {
	// Import BufferPool
	const { BufferPool } = await import('../../src/buffer-pool.esm.js');

	const pool = new BufferPool({ sizeClasses: [1024, 4096] });
	const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	const vb = new VirtualBuffer(data);

	const segments = vb.toPool(pool);
	pool.stop();

	// Should return array of Uint8Array segments
	assertEquals(Array.isArray(segments), true);
	assertEquals(segments.length > 0, true);

	// Verify data was copied correctly
	let totalLength = 0;
	const result = new Uint8Array(10);
	for (const seg of segments) {
		// seg is a Uint8Array
		result.set(seg, totalLength);
		totalLength += seg.length;
	}
	assertEquals(totalLength, 10);
	assertEquals(Array.from(result), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

Deno.test('VirtualBuffer - toPool with invalid pool', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);

	assertThrows(
		() => vb.toPool({}),
		TypeError,
		'Pool does not support acquireSet'
	);
});
