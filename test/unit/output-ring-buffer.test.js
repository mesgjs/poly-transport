/*
 * Unit tests for OutputRingBuffer
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { OutputRingBuffer } from '../../src/output-ring-buffer.esm.js';

Deno.test('OutputRingBuffer - constructor with default size', () => {
	const ring = new OutputRingBuffer();
	assertEquals(ring.size, 256 * 1024);
	assertEquals(ring.available, 0);
	assertEquals(ring.space, 256 * 1024);
});

Deno.test('OutputRingBuffer - constructor with custom size', () => {
	const ring = new OutputRingBuffer(8192);
	assertEquals(ring.size, 8192);
	assertEquals(ring.space, 8192);
});

Deno.test('OutputRingBuffer - constructor rejects size < 1024', () => {
	assertThrows(
		() => new OutputRingBuffer(512),
		RangeError,
		'Ring buffer size must be at least 1024 bytes'
	);
});

Deno.test('OutputRingBuffer - reserve returns null when insufficient space', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation1 = ring.reserve(1024);
	assertEquals(reservation1 !== null, true);
	ring.commit();
	
	// Now buffer is full
	const reservation2 = ring.reserve(1);
	assertEquals(reservation2, null);
});

Deno.test('OutputRingBuffer - reserve throws on invalid length', () => {
	const ring = new OutputRingBuffer(1024);
	assertThrows(
		() => ring.reserve(0),
		RangeError,
		'Reservation length must be at least 1 byte'
	);
	assertThrows(
		() => ring.reserve(-1),
		RangeError,
		'Reservation length must be at least 1 byte'
	);
});

Deno.test('OutputRingBuffer - reserve throws when length exceeds capacity', () => {
	const ring = new OutputRingBuffer(1024);
	assertThrows(
		() => ring.reserve(1025),
		RangeError,
		'exceeds ring buffer capacity'
	);
});

Deno.test('OutputRingBuffer - reserve and commit simple case', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	assertEquals(reservation !== null, true);
	assertEquals(reservation.length, 100);
	assertEquals(ring.space, 1024 - 100);
	
	ring.commit();
	assertEquals(ring.available, 100);
	assertEquals(ring.space, 1024 - 100);
});

Deno.test('OutputRingBuffer - write data to reservation', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(10);
	
	// Write some data
	const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	reservation.set(data);
	
	ring.commit();
	
	// Get buffers and verify data
	const buffers = ring.getBuffers(10);
	assertEquals(buffers.length, 1);
	assertEquals(Array.from(buffers[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

Deno.test('OutputRingBuffer - getBuffers throws on invalid length', () => {
	const ring = new OutputRingBuffer(1024);
	assertThrows(
		() => ring.getBuffers(0),
		RangeError,
		'Buffer length must be at least 1 byte'
	);
});

Deno.test('OutputRingBuffer - getBuffers throws when exceeding available', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(10);
	ring.commit();
	
	assertThrows(
		() => ring.getBuffers(20),
		RangeError,
		'only 10 available'
	);
});

Deno.test('OutputRingBuffer - consume zeros data', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(10);
	const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	reservation.set(data);
	ring.commit();
	
	// Get buffers before consuming
	const buffersBefore = ring.getBuffers(10);
	assertEquals(Array.from(buffersBefore[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	
	// Consume the data
	ring.consume(10);
	assertEquals(ring.available, 0);
	assertEquals(ring.space, 1024);
	
	// Reserve again and verify it's zeroed
	const reservation2 = ring.reserve(10);
	ring.commit();
	const buffersAfter = ring.getBuffers(10);
	assertEquals(Array.from(buffersAfter[0]), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

Deno.test('OutputRingBuffer - consume throws on invalid length', () => {
	const ring = new OutputRingBuffer(1024);
	assertThrows(
		() => ring.consume(0),
		RangeError,
		'Consume length must be at least 1 byte'
	);
});

Deno.test('OutputRingBuffer - consume throws when exceeding available', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(10);
	ring.commit();
	
	assertThrows(
		() => ring.consume(20),
		RangeError,
		'only 10 available'
	);
});

Deno.test('OutputRingBuffer - wrap-around reservation', () => {
	const ring = new OutputRingBuffer(1024);
	
	// Fill most of the buffer
	const reservation1 = ring.reserve(1000);
	ring.commit();
	ring.consume(1000);
	
	// Now writeHead is at 1000, readHead is at 1000
	// Reserve 50 bytes - should wrap around
	const reservation2 = ring.reserve(50);
	assertEquals(reservation2 !== null, true);
	assertEquals(reservation2.length, 50);
	
	// Verify stats show wrap occurred
	const stats = ring.getStats();
	assertEquals(stats.wraps, 1);
});

Deno.test('OutputRingBuffer - wrap-around getBuffers returns 2 arrays', () => {
	const ring = new OutputRingBuffer(1024);
	
	// Fill most of the buffer
	const reservation1 = ring.reserve(1000);
	const data1 = new Uint8Array(1000).fill(1);
	reservation1.set(data1);
	ring.commit();
	
	// Consume 900 bytes
	ring.consume(900);
	
	// Reserve 50 more bytes (wraps around: 24 at end + 26 at start)
	const reservation2 = ring.reserve(50);
	const data2 = new Uint8Array(50).fill(2);
	reservation2.set(data2);
	ring.commit();
	
	// Now we have: 100 bytes of old data (900-999) + 24 bytes of new data (1000-1023) + 26 bytes of new data (0-25)
	// Total: 124 bytes from readHead to end + 26 bytes from start
	const buffers = ring.getBuffers(150);
	assertEquals(buffers.length, 2);
	assertEquals(buffers[0].length, 124); // From readHead (900) to end (1023)
	assertEquals(buffers[1].length, 26); // From start (0) to writeHead-1 (25)
	
	// Verify data: first 100 bytes are 1s, next 50 bytes are 2s
	const allData = new Uint8Array(150);
	allData.set(buffers[0], 0);
	allData.set(buffers[1], buffers[0].length);
	
	assertEquals(Array.from(allData.subarray(0, 100)).every(b => b === 1), true);
	assertEquals(Array.from(allData.subarray(100, 150)).every(b => b === 2), true);
});

Deno.test('OutputRingBuffer - wrap-around consume zeros both regions', () => {
	const ring = new OutputRingBuffer(1024);
	
	// Fill most of the buffer
	const reservation1 = ring.reserve(1000);
	const data1 = new Uint8Array(1000).fill(1);
	reservation1.set(data1);
	ring.commit();
	
	// Consume 900 bytes
	ring.consume(900);
	
	// Reserve 50 more bytes (wraps around)
	const reservation2 = ring.reserve(50);
	const data2 = new Uint8Array(50).fill(2);
	reservation2.set(data2);
	ring.commit();
	
	// Consume all 150 bytes (wraps around)
	ring.consume(150);
	
	// Verify both regions are zeroed
	const reservation3 = ring.reserve(150);
	ring.commit();
	const buffers = ring.getBuffers(150);
	
	// All bytes should be zero
	for (const buffer of buffers) {
		assertEquals(Array.from(buffer).every(b => b === 0), true);
	}
});

Deno.test('OutputRingBuffer - commit throws when no reservation active', () => {
	const ring = new OutputRingBuffer(1024);
	
	assertThrows(
		() => ring.commit(),
		Error,
		'Reservation not active'
	);
});

Deno.test('OutputRingBuffer - only one pending reservation allowed', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation1 = ring.reserve(10);
	
	// Try to make another reservation before committing the first
	assertThrows(
		() => ring.reserve(10),
		Error,
		'Reservation already pending'
	);
	
	// Commit the first reservation
	ring.commit();
	
	// Now we can make another reservation
	const reservation2 = ring.reserve(10);
	assertEquals(reservation2 !== null, true);
});

Deno.test('OutputRingBuffer - multiple reserve/commit/consume cycles', () => {
	const ring = new OutputRingBuffer(1024);
	
	for (let i = 0; i < 10; i++) {
		const reservation = ring.reserve(50);
		const data = new Uint8Array(50).fill(i);
		reservation.set(data);
		ring.commit();
		
		const buffers = ring.getBuffers(50);
		assertEquals(Array.from(buffers[0]).every(b => b === i), true);
		
		ring.consume(50);
	}
	
	// Verify stats
	const stats = ring.getStats();
	assertEquals(stats.reservations, 10);
	assertEquals(stats.commits, 10);
	assertEquals(stats.bufferGets, 10);
	assertEquals(stats.consumes, 10);
	assertEquals(stats.bytesReserved, 500);
	assertEquals(stats.bytesCommitted, 500);
	assertEquals(stats.bytesProvided, 500);
	assertEquals(stats.bytesConsumed, 500);
});

Deno.test('OutputRingBuffer - getStats returns correct values', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	ring.commit();
	
	const stats = ring.getStats();
	assertEquals(stats.size, 1024);
	assertEquals(stats.available, 100);
	assertEquals(stats.space, 1024 - 100);
	assertEquals(stats.writeHead, 100);
	assertEquals(stats.readHead, 0);
	assertEquals(stats.count, 100);
	assertEquals(stats.reserved, 0);
	assertEquals(stats.reservations, 1);
	assertEquals(stats.commits, 1);
	assertEquals(stats.bytesReserved, 100);
	assertEquals(stats.bytesCommitted, 100);
});

Deno.test('OutputRingBuffer - full buffer scenario', () => {
	const ring = new OutputRingBuffer(1024);
	
	// Fill the buffer completely (full 1024 bytes)
	const reservation = ring.reserve(1024);
	assertEquals(reservation !== null, true);
	ring.commit();
	
	// Try to reserve more - should return null
	const reservation2 = ring.reserve(1);
	assertEquals(reservation2, null);
	
	// Consume some space
	ring.consume(100);
	
	// Now we can reserve again
	const reservation3 = ring.reserve(50);
	assertEquals(reservation3 !== null, true);
});

Deno.test('OutputRingBuffer - VirtualRWBuffer integration', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(20);
	
	// Use VirtualRWBuffer methods
	reservation.setUint8(0, 0x12);
	reservation.setUint16(1, 0x3456, false);
	reservation.setUint32(3, 0x789ABCDE, false);
	
	ring.commit();
	
	const buffers = ring.getBuffers(20);
	assertEquals(buffers[0][0], 0x12);
	assertEquals(buffers[0][1], 0x34);
	assertEquals(buffers[0][2], 0x56);
	assertEquals(buffers[0][3], 0x78);
	assertEquals(buffers[0][4], 0x9A);
	assertEquals(buffers[0][5], 0xBC);
	assertEquals(buffers[0][6], 0xDE);
});

Deno.test('OutputRingBuffer - string encoding via VirtualRWBuffer', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// Encode a string
	const { read, written } = reservation.encodeFrom('Hello, World!');
	assertEquals(read, 13);
	assertEquals(written, 13);
	
	// Shrink to actual size
	reservation.shrink(written);
	ring.commit();
	
	const buffers = ring.getBuffers(written);
	const decoder = new TextDecoder();
	const text = decoder.decode(buffers[0]);
	assertEquals(text, 'Hello, World!');
});

Deno.test('OutputRingBuffer - wrap-around with VirtualRWBuffer', () => {
	const ring = new OutputRingBuffer(1024);
	
	// Fill most of the buffer
	const reservation1 = ring.reserve(1000);
	ring.commit();
	ring.consume(1000);
	
	// Reserve across wrap-around
	const reservation2 = ring.reserve(50);
	
	// Write data using VirtualRWBuffer methods
	for (let i = 0; i < 50; i++) {
		reservation2.setUint8(i, i);
	}
	
	ring.commit();
	
	const buffers = ring.getBuffers(50);
	
	// Verify data across both buffers
	let offset = 0;
	for (const buffer of buffers) {
		for (let i = 0; i < buffer.length; i++) {
			assertEquals(buffer[i], offset);
			offset++;
		}
	}
});

Deno.test('OutputRingBuffer - shrink reservation via VirtualRWBuffer', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// Write less data than reserved
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	reservation.set(data);
	
	// Shrink to actual size via VirtualRWBuffer
	reservation.shrink(5);
	ring.commit();
	
	// Verify only 5 bytes are available
	assertEquals(ring.available, 5);
	assertEquals(ring.space, 1024 - 5);
	
	const buffers = ring.getBuffers(5);
	assertEquals(Array.from(buffers[0]), [1, 2, 3, 4, 5]);
});

Deno.test('OutputRingBuffer - shrink(0) cancels reservation via VirtualRWBuffer', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// Cancel the reservation via VirtualRWBuffer
	reservation.shrink(0);
	
	// Verify space is restored
	assertEquals(ring.space, 1024);
	assertEquals(ring.available, 0);
	
	// Can make a new reservation
	const reservation2 = ring.reserve(50);
	assertEquals(reservation2 !== null, true);
});

Deno.test('OutputRingBuffer - shrink directly', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// Write less data than reserved
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	reservation.set(data);
	
	// Shrink directly via OutputRingBuffer
	ring.shrink(5);
	ring.commit();
	
	// Verify only 5 bytes are available
	assertEquals(ring.available, 5);
	assertEquals(ring.space, 1024 - 5);
	
	const buffers = ring.getBuffers(5);
	assertEquals(Array.from(buffers[0]), [1, 2, 3, 4, 5]);
});

Deno.test('OutputRingBuffer - shrink(0) cancels reservation directly', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// Cancel the reservation directly via OutputRingBuffer
	ring.shrink(0);
	
	// Verify space is restored
	assertEquals(ring.space, 1024);
	assertEquals(ring.available, 0);
	
	// Can make a new reservation
	const reservation2 = ring.reserve(50);
	assertEquals(reservation2 !== null, true);
});

Deno.test('OutputRingBuffer - shrink throws on negative length (via VirtualRWBuffer)', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// VirtualRWBuffer validates first: newLength < 0 || newLength > state.length
	assertThrows(
		() => reservation.shrink(-1),
		RangeError,
		'out of range'
	);
});

Deno.test('OutputRingBuffer - shrink throws on negative length (direct)', () => {
	const ring = new OutputRingBuffer(1024);
	ring.reserve(100);
	
	// OutputRingBuffer validation
	assertThrows(
		() => ring.shrink(-1),
		RangeError,
		'New length must be non-negative'
	);
});

Deno.test('OutputRingBuffer - shrink throws when growing (via VirtualRWBuffer)', () => {
	const ring = new OutputRingBuffer(1024);
	const reservation = ring.reserve(100);
	
	// VirtualRWBuffer validates first: newLength < 0 || newLength > state.length
	assertThrows(
		() => reservation.shrink(150),
		RangeError,
		'out of range'
	);
});

Deno.test('OutputRingBuffer - shrink throws when growing (direct)', () => {
	const ring = new OutputRingBuffer(1024);
	ring.reserve(100);
	
	// OutputRingBuffer validation
	assertThrows(
		() => ring.shrink(150),
		RangeError,
		'Cannot grow a reservation, only shrink'
	);
});
