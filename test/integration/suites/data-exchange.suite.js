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
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB]
 */
export function registerDataExchangeTests (makeTransportPair) {

	// ─── Test: Send/receive chunk (eom=false) with message type 0 ─────────────────

	// Some of these tests have issues (including some running non-stop)
	// ALL are currently disabled pending further investigation
	// so that otherwise-complete test runs are possible
	Deno.test('send/receive chunk (eom=false) with message type 0', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Send/receive complete message (eom=true) with message type 0 ───────

	Deno.test('send/receive complete message (eom=true) with message type 0', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Multiple messages in sequence ──────────────────────────────────────

	Deno.test('multiple messages in sequence', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Bidirectional data exchange ────────────────────────────────────────

	Deno.test('bidirectional data exchange', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Send/receive message with accepted registered string type ──────────

	Deno.test('send/receive message with accepted registered string type', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Read filtered by registered string type ────────────────────────────

	Deno.test('read filtered by registered string type', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});

	// ─── Test: Multi-chunk message reassembled correctly ─────────────────────────

	Deno.test('multi-chunk message reassembled correctly', async () => {
		// Use small maxChunkBytes to force multi-chunk messages
		const [transportA, transportB] = await makeTransportPair({
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
	});

	// ─── Test: Send/receive binary data (Uint8Array) ──────────────────────────────

	Deno.test('send/receive binary data (Uint8Array)', async () => {
		const [transportA, transportB] = await makeTransportPair();
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
	});
}
