import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { VirtualBuffer, VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';

// VirtualBuffer DataView read methods

Deno.test('VirtualBuffer - getUint8 single segment', () => {
	const data = new Uint8Array([10, 20, 30, 40, 50]);
	const vb = new VirtualBuffer(data);
	
	assertEquals(vb.getUint8(0), 10);
	assertEquals(vb.getUint8(2), 30);
	assertEquals(vb.getUint8(4), 50);
});

Deno.test('VirtualBuffer - getUint8 across segments', () => {
	const buf1 = new Uint8Array([10, 20, 30]);
	const buf2 = new Uint8Array([40, 50, 60]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	
	assertEquals(vb.getUint8(0), 10);
	assertEquals(vb.getUint8(2), 30);
	assertEquals(vb.getUint8(3), 40);
	assertEquals(vb.getUint8(5), 60);
});

Deno.test('VirtualBuffer - getUint8 with segment caching', () => {
	const data = new Uint8Array([10, 20, 30, 40, 50]);
	const vb = new VirtualBuffer(data);
	
	// Sequential reads should benefit from caching
	assertEquals(vb.getUint8(0), 10);
	assertEquals(vb.getUint8(1), 20);
	assertEquals(vb.getUint8(2), 30);
	assertEquals(vb.getUint8(3), 40);
	assertEquals(vb.getUint8(4), 50);
});

Deno.test('VirtualBuffer - getUint8 out of range', () => {
	const data = new Uint8Array([10, 20, 30]);
	const vb = new VirtualBuffer(data);
	
	assertThrows(
		() => vb.getUint8(3),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.getUint8(-1),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualBuffer - getUint16 single segment', () => {
	const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
	const vb = new VirtualBuffer(data);
	
	assertEquals(vb.getUint16(0), 0x1234);
	assertEquals(vb.getUint16(2), 0x5678);
});

Deno.test('VirtualBuffer - getUint16 across segments', () => {
	const buf1 = new Uint8Array([0x12, 0x34]);
	const buf2 = new Uint8Array([0x56, 0x78]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	
	// Spans segment boundary
	assertEquals(vb.getUint16(1), 0x3456);
});

Deno.test('VirtualBuffer - getUint16 out of range', () => {
	const data = new Uint8Array([0x12, 0x34]);
	const vb = new VirtualBuffer(data);
	
	assertThrows(
		() => vb.getUint16(1),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualBuffer - getUint32 single segment', () => {
	const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]);
	const vb = new VirtualBuffer(data);
	
	assertEquals(vb.getUint32(0), 0x12345678);
	assertEquals(vb.getUint32(2), 0x56789ABC);
});

Deno.test('VirtualBuffer - getUint32 across segments', () => {
	const buf1 = new Uint8Array([0x12, 0x34]);
	const buf2 = new Uint8Array([0x56, 0x78]);
	const segments = [buf1, buf2];
	const vb = new VirtualBuffer(segments);
	
	// Spans segment boundary
	assertEquals(vb.getUint32(0), 0x12345678);
});

Deno.test('VirtualBuffer - getUint32 out of range', () => {
	const data = new Uint8Array([0x12, 0x34, 0x56]);
	const vb = new VirtualBuffer(data);
	
	assertThrows(
		() => vb.getUint32(0),
		RangeError,
		'out of range'
	);
});

// VirtualRWBuffer DataView write methods

Deno.test('VirtualRWBuffer - setUint8 single segment', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.setUint8(0, 10);
	vb.setUint8(2, 30);
	vb.setUint8(4, 50);
	
	assertEquals(Array.from(buffer), [10, 0, 30, 0, 50]);
});

Deno.test('VirtualRWBuffer - setUint8 across segments', () => {
	const buf1 = new Uint8Array([0, 0, 0]);
	const buf2 = new Uint8Array([0, 0, 0]);
	const segments = [buf1, buf2];
	const vb = new VirtualRWBuffer(segments);
	
	vb.setUint8(0, 10);
	vb.setUint8(2, 30);
	vb.setUint8(3, 40);
	vb.setUint8(5, 60);
	
	assertEquals(Array.from(buf1), [10, 0, 30]);
	assertEquals(Array.from(buf2), [40, 0, 60]);
});

Deno.test('VirtualRWBuffer - setUint8 with segment caching', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	// Sequential writes should benefit from caching
	vb.setUint8(0, 10);
	vb.setUint8(1, 20);
	vb.setUint8(2, 30);
	vb.setUint8(3, 40);
	vb.setUint8(4, 50);
	
	assertEquals(Array.from(buffer), [10, 20, 30, 40, 50]);
});

Deno.test('VirtualRWBuffer - setUint8 out of range', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint8(3, 10),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.setUint8(-1, 10),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - setUint8 value out of range', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint8(0, 256),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.setUint8(0, -1),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - setUint16 single segment', () => {
	const buffer = new Uint8Array([0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.setUint16(0, 0x1234);
	vb.setUint16(2, 0x5678);
	
	assertEquals(Array.from(buffer), [0x12, 0x34, 0x56, 0x78]);
});

Deno.test('VirtualRWBuffer - setUint16 across segments', () => {
	const buf1 = new Uint8Array([0, 0]);
	const buf2 = new Uint8Array([0, 0]);
	const segments = [buf1, buf2];
	const vb = new VirtualRWBuffer(segments);
	
	// Spans segment boundary
	vb.setUint16(1, 0x3456);
	
	assertEquals(Array.from(buf1), [0, 0x34]);
	assertEquals(Array.from(buf2), [0x56, 0]);
});

Deno.test('VirtualRWBuffer - setUint16 out of range', () => {
	const buffer = new Uint8Array([0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint16(1, 0x1234),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - setUint16 value out of range', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint16(0, 0x10000),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.setUint16(0, -1),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - setUint32 single segment', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.setUint32(0, 0x12345678);
	vb.setUint32(2, 0x9ABCDEF0);
	
	assertEquals(Array.from(buffer), [0x12, 0x34, 0x9A, 0xBC, 0xDE, 0xF0]);
});

Deno.test('VirtualRWBuffer - setUint32 across segments', () => {
	const buf1 = new Uint8Array([0, 0]);
	const buf2 = new Uint8Array([0, 0]);
	const segments = [buf1, buf2];
	const vb = new VirtualRWBuffer(segments);
	
	// Spans segment boundary
	vb.setUint32(0, 0x12345678);
	
	assertEquals(Array.from(buf1), [0x12, 0x34]);
	assertEquals(Array.from(buf2), [0x56, 0x78]);
});

Deno.test('VirtualRWBuffer - setUint32 out of range', () => {
	const buffer = new Uint8Array([0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint32(0, 0x12345678),
		RangeError,
		'out of range'
	);
});

Deno.test('VirtualRWBuffer - setUint32 value out of range', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	assertThrows(
		() => vb.setUint32(0, 0x100000000),
		RangeError,
		'out of range'
	);
	
	assertThrows(
		() => vb.setUint32(0, -1),
		RangeError,
		'out of range'
	);
});

// Combined read/write tests

Deno.test('VirtualRWBuffer - round-trip Uint16', () => {
	const buffer = new Uint8Array([0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.setUint16(0, 0x1234);
	vb.setUint16(2, 0xABCD);
	
	assertEquals(vb.getUint16(0), 0x1234);
	assertEquals(vb.getUint16(2), 0xABCD);
});

Deno.test('VirtualRWBuffer - round-trip Uint32', () => {
	const buffer = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
	const vb = new VirtualRWBuffer(buffer);
	
	vb.setUint32(0, 0x12345678);
	vb.setUint32(4, 0x9ABCDEF0);
	
	assertEquals(vb.getUint32(0), 0x12345678);
	assertEquals(vb.getUint32(4), 0x9ABCDEF0);
});

// Security tests

Deno.test('Security - VirtualBuffer.toUint8Array always copies', () => {
	const original = new Uint8Array([1, 2, 3, 4, 5]);
	const vb = new VirtualBuffer(original);
	const copy = vb.toUint8Array();
	
	// Modify the copy
	copy[0] = 99;
	
	// Original should be unchanged
	assertEquals(original[0], 1);
	assertEquals(copy[0], 99);
});

Deno.test('Security - VirtualRWBuffer.set accepts VirtualBuffer', () => {
	const rwBuf = new VirtualRWBuffer(new Uint8Array([0, 0, 0]));
	const roBuf = new VirtualBuffer(new Uint8Array([1, 2, 3]));
	
	// This should work - set now accepts any VirtualBuffer
	const written = rwBuf.set(roBuf);
	
	assertEquals(written, 3);
	assertEquals(Array.from(rwBuf.toUint8Array()), [1, 2, 3]);
});

Deno.test('Security - VirtualRWBuffer.set accepts VirtualRWBuffer', () => {
	const rwBuf1 = new VirtualRWBuffer(new Uint8Array([0, 0, 0]));
	const rwBuf2 = new VirtualRWBuffer(new Uint8Array([1, 2, 3]));
	
	// This should work
	const written = rwBuf1.set(rwBuf2);
	
	assertEquals(written, 3);
	assertEquals(Array.from(rwBuf1.toUint8Array()), [1, 2, 3]);
});
