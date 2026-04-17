/*
 * Data Exchange Integration Test Suite
 *
 * Shared test suite for data exchange scenarios across all transport types.
 * Tests are registered by calling registerDataExchangeTests(makeTransportPair).
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assert, assertEquals, assertExists
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { makeConnectedChannel } from '../helpers.js';

/**
 * Register data exchange integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB, cleanup?]
 *   cleanup is an optional async function called after each test to release additional resources.
 */
export function registerDataExchangeTests (makeTransportPair) {

	// ─── Test: Send/receive chunk (eom=false) with message type 0 ─────────────────

	Deno.test('send/receive chunk (eom=false) with message type 0', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes a chunk with eom=false
		await channelA.write(0, 'partial chunk', { eom: false });

		// B reads with dechunk=false to get the chunk without waiting for EOM
		const readResult = await channelB.read({ dechunk: false, decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'partial chunk');
		assertEquals(readResult.eom, false);
		readResult.done();

		// Clean up: send EOM to allow graceful close
		await channelA.write(0, null, { eom: true });
		const eomResult = await channelB.read({ dechunk: false, timeout: 1000 });
		assertExists(eomResult);
		eomResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Send/receive complete message (eom=true) with message type 0 ───────

	Deno.test('send/receive complete message (eom=true) with message type 0', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes a complete message with eom=true
		await channelA.write(0, 'complete message', { eom: true });

		// B reads with dechunk=true (default) to get the complete message
		const readResult = await channelB.read({ dechunk: true, decode: true });
		assertExists(readResult);
		assertEquals(readResult.text, 'complete message');
		assertEquals(readResult.eom, true);
		readResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Multiple messages in sequence ──────────────────────────────────────

	Deno.test('multiple messages in sequence', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		const messages = ['first message', 'second message', 'third message'];

		// A writes 3 messages
		for (const msg of messages) {
			await channelA.write(0, msg, { eom: true });
		}

		// B reads them in order
		for (const expected of messages) {
			const readResult = await channelB.read({ decode: true, timeout: 1000 });
			assertExists(readResult);
			assertEquals(readResult.text, expected);
			assertEquals(readResult.eom, true);
			readResult.done();
		}

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Bidirectional data exchange ────────────────────────────────────────

	Deno.test('bidirectional data exchange', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes to B and B writes to A simultaneously
		const writeAPromise = channelA.write(0, 'from A to B', { eom: true });
		const writeBPromise = channelB.write(0, 'from B to A', { eom: true });

		// Both sides read
		const readByB = channelB.read({ decode: true, timeout: 1000 });
		const readByA = channelA.read({ decode: true, timeout: 1000 });

		const [resultB, resultA] = await Promise.all([readByB, readByA]);

		assertExists(resultB);
		assertEquals(resultB.text, 'from A to B');
		resultB.done();

		assertExists(resultA);
		assertEquals(resultA.text, 'from B to A');
		resultA.done();

		await Promise.all([writeAPromise, writeBPromise]);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Send/receive message with accepted registered string type ──────────

	Deno.test('send/receive message with accepted registered string type', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B accepts the message type registration
		channelB.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});

		// A registers 'myType' on the channel
		await channelA.addMessageTypes(['myType']);

		// A writes with the registered string type
		await channelA.write('myType', 'typed message', { eom: true });

		// B reads and should get the message with the type name
		const readResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'typed message');
		assertEquals(readResult.messageType, 'myType');
		readResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Read filtered by registered string type ────────────────────────────

	Deno.test('read filtered by registered string type', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B accepts the message type registration
		channelB.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});

		// A registers 'myType' on the channel
		await channelA.addMessageTypes(['myType']);

		// A writes a message with type 0 first, then with 'myType'
		await channelA.write(0, 'untyped message', { eom: true });
		await channelA.write('myType', 'typed message', { eom: true });

		// B reads filtering for 'myType' only - should skip the type-0 message
		const readResult = await channelB.read({ only: 'myType', decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'typed message');
		assertEquals(readResult.messageType, 'myType');
		readResult.done();

		// Read the untyped message that was skipped
		const untypedResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(untypedResult);
		assertEquals(untypedResult.text, 'untyped message');
		untypedResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Multi-chunk message reassembled correctly ─────────────────────────

	Deno.test('multi-chunk message reassembled correctly', async () => {
		// Use small maxChunkBytes to force multi-chunk messages
		const [transportA, transportB, cleanup] = await makeTransportPair({
			maxChunkBytes: 1024 + 18, // 18 bytes header + 1024 bytes data
		}, {
			maxChunkBytes: 1024 + 18,
		});
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Create a string larger than maxChunkBytes to force multiple chunks
		const largeText = 'A'.repeat(4096); // 4KB string, will need multiple chunks

		// A writes the large string
		await channelA.write(0, largeText, { eom: true });

		// B reads with dechunk=true (default) - should get the full reassembled message
		const readResult = await channelB.read({ decode: true, timeout: 5000 });
		assertExists(readResult);
		assertEquals(readResult.text, largeText);
		assertEquals(readResult.eom, true);
		readResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Send/receive binary data (Uint8Array) ──────────────────────────────

	Deno.test('send/receive binary data (Uint8Array)', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Create binary data
		const binaryData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0xFF, 0xFE, 0x00]);

		// A writes binary data
		await channelA.write(0, binaryData, { eom: true });

		// B reads the binary data (without decode to get raw bytes)
		const readResult = await channelB.read({ decode: false, timeout: 1000 });
		assertExists(readResult);
		assertExists(readResult.data);

		// Convert VirtualBuffer to Uint8Array for comparison
		const receivedBytes = readResult.data.toUint8Array();
		assertEquals(receivedBytes.length, binaryData.length);
		for (let i = 0; i < binaryData.length; i++) {
			assertEquals(receivedBytes[i], binaryData[i], `Byte ${i} mismatch`);
		}
		readResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Interleaved writes on multiple channels with mixed text/binary ─────

	Deno.test('interleaved writes on multiple channels with mixed text and binary data', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		// Create 3 channels
		const [channelA1, channelB1] = await makeConnectedChannel(transportA, transportB, 'multi-ch-1');
		const [channelA2, channelB2] = await makeConnectedChannel(transportA, transportB, 'multi-ch-2');
		const [channelA3, channelB3] = await makeConnectedChannel(transportA, transportB, 'multi-ch-3');

		// Prepare test data with different message type IDs
		const textData1 = 'Message on channel 1';
		const textData2 = 'Message on channel 2';
		const binaryData3 = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
		const textData1b = 'Second message on channel 1';
		const binaryData2 = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
		const textData3 = 'Text message on channel 3';

		// Interleave writes across all 3 channels (text and binary mixed)
		// Use different message type IDs to allow concurrent filtered reads
		// Pattern: ch1(type1) → ch2(type2) → ch3(type3) → ch1(type4) → ch2(type5) → ch3(type6)
		const writePromises = [
			channelA1.write(1, textData1),
			channelA2.write(2, textData2),
			channelA3.write(3, binaryData3),
			channelA1.write(4, textData1b),
			channelA2.write(5, binaryData2),
			channelA3.write(6, textData3),
		];

		// Read from all channels concurrently using 'only' filter for each message type
		const readPromises = [
			// Channel 1: expect 2 text messages (types 1 and 4)
			channelB1.read({ only: 1, decode: true, timeout: 2000 }),
			channelB1.read({ only: 4, decode: true, timeout: 2000 }),
			// Channel 2: expect 1 text (type 2), 1 binary (type 5)
			channelB2.read({ only: 2, decode: true, timeout: 2000 }),
			channelB2.read({ only: 5, decode: false, timeout: 2000 }),
			// Channel 3: expect 1 binary (type 3), 1 text (type 6)
			channelB3.read({ only: 3, decode: false, timeout: 2000 }),
			channelB3.read({ only: 6, decode: true, timeout: 2000 }),
		];

		// Wait for all writes and reads to complete
		await Promise.all(writePromises);
		const [
			result1a, result1b,
			result2a, result2b,
			result3a, result3b
		] = await Promise.all(readPromises);

		// Verify channel 1 received both text messages
		assertExists(result1a);
		assertEquals(result1a.text, textData1);
		assertEquals(result1a.messageType, 1);
		result1a.done();

		assertExists(result1b);
		assertEquals(result1b.text, textData1b);
		assertEquals(result1b.messageType, 4);
		result1b.done();

		// Verify channel 2 received text and binary
		assertExists(result2a);
		assertEquals(result2a.text, textData2);
		assertEquals(result2a.messageType, 2);
		result2a.done();

		assertExists(result2b);
		assertExists(result2b.data);
		assertEquals(result2b.messageType, 5);
		const receivedBinary2 = result2b.data.toUint8Array();
		assertEquals(receivedBinary2.length, binaryData2.length);
		for (let i = 0; i < binaryData2.length; i++) {
			assertEquals(receivedBinary2[i], binaryData2[i], `Channel 2 binary byte ${i} mismatch`);
		}
		result2b.done();

		// Verify channel 3 received binary and text
		assertExists(result3a);
		assertExists(result3a.data);
		assertEquals(result3a.messageType, 3);
		const receivedBinary3 = result3a.data.toUint8Array();
		assertEquals(receivedBinary3.length, binaryData3.length);
		for (let i = 0; i < binaryData3.length; i++) {
			assertEquals(receivedBinary3[i], binaryData3[i], `Channel 3 binary byte ${i} mismatch`);
		}
		result3a.done();

		assertExists(result3b);
		assertEquals(result3b.text, textData3);
		assertEquals(result3b.messageType, 6);
		result3b.done();

		// Clean up all channels
		await Promise.all([
			channelA1.close(), channelB1.close(),
			channelA2.close(), channelB2.close(),
			channelA3.close(), channelB3.close(),
		]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});
}
