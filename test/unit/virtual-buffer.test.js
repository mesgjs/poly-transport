import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { VirtualBuffer } from '../../src/virtual-buffer.esm.js';

Deno.test('VirtualBuffer - construction from Uint8Array', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data);

	assertEquals(vb.length, 5);
	assertEquals(vb.byteLength, 5);
	assertEquals(vb.segmentCount, 1);
});

Deno.test('VirtualBuffer - construction with offset and length', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data, 1, 3);

	assertEquals(vb.length, 3);
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [2, 3, 4]);
});

Deno.test('VirtualBuffer - construction from segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
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

Deno.test('VirtualBuffer - append with offset and length', () => {
	const vb = new VirtualBuffer();
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	vb.append(data, 1, 3);

	assertEquals(vb.length, 3);
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [2, 3, 4]);
});

Deno.test('VirtualBuffer - append segments', () => {
	const vb = new VirtualBuffer();
	const buf1 = new Uint8Array([1, 2, 3]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 2 },
		{ buffer: buf1, offset: 2, length: 1 }
	];
	vb.append(segments);

	assertEquals(vb.length, 3);
	assertEquals(vb.segmentCount, 2);
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
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
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

Deno.test('VirtualBuffer - toUint8Array single segment with offset', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(data, 1, 3);
	const result = vb.toUint8Array();

	assertEquals(Array.from(result), [2, 3, 4]);
	// Should always copy for security (not the same buffer)
	assertEquals(result.buffer !== data.buffer, true);
});

Deno.test('VirtualBuffer - toUint8Array multiple segments', () => {
	const buf1 = new Uint8Array([1, 2, 3]);
	const buf2 = new Uint8Array([4, 5, 6]);
	const segments = [
		{ buffer: buf1, offset: 0, length: 3 },
		{ buffer: buf2, offset: 0, length: 3 }
	];
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
	const segments = [
		{ buffer: part1, offset: 0, length: part1.length },
		{ buffer: part2, offset: 0, length: part2.length }
	];
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

	const segments = [
		{ buffer: part1, offset: 0, length: part1.length },
		{ buffer: part2, offset: 0, length: part2.length }
	];
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

Deno.test('VirtualBuffer - pin and unpin', () => {
	const vb = new VirtualBuffer(new Uint8Array([1, 2, 3]));

	let released = false;
	const pinHandle = {
		release: () => { released = true; }
	};

	vb.pin(pinHandle);
	assertEquals(released, false);

	vb.unpin(pinHandle);
	assertEquals(released, true);
});

Deno.test('VirtualBuffer - unpin all', () => {
	const vb = new VirtualBuffer(new Uint8Array([1, 2, 3]));

	let released1 = false;
	let released2 = false;
	const pinHandle1 = {
		release: () => { released1 = true; }
	};
	const pinHandle2 = {
		release: () => { released2 = true; }
	};

	vb.pin(pinHandle1);
	vb.pin(pinHandle2);

	vb.unpin();

	assertEquals(released1, true);
	assertEquals(released2, true);
});

Deno.test('VirtualBuffer - migrate segments', () => {
	const oldBuf1 = new Uint8Array([1, 2, 3, 4, 5]);
	const oldBuf2 = new Uint8Array([6, 7, 8, 9, 10]);
	
	const segments = [
		{ buffer: oldBuf1, offset: 1, length: 3 },  // [2, 3, 4]
		{ buffer: oldBuf2, offset: 0, length: 2 }   // [6, 7]
	];
	const vb = new VirtualBuffer(segments);
	
	// Simulate migration: oldBuf1[1:4] moved to newBuf1[0:3]
	const newBuf1 = new Uint8Array([2, 3, 4]);
	const migrations = [
		{ oldBuffer: oldBuf1, newBuffer: newBuf1, oldOffset: 1, newOffset: 0 }
	];
	
	vb.migrate(migrations);
	
	// Check that data is still correct
	const result = vb.toUint8Array();
	assertEquals(Array.from(result), [2, 3, 4, 6, 7]);
});

Deno.test('VirtualBuffer - invalid source type', () => {
	assertThrows(
		() => new VirtualBuffer('invalid'),
		TypeError,
		'Source must be Uint8Array, VirtualBuffer, or array of segments'
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
