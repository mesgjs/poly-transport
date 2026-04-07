/*
 * Message Types Integration Test Suite
 *
 * Shared test suite for message type registration scenarios across all transport types.
 * Tests are registered by calling registerMessageTypeTests(makeTransportPair).
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assert, assertEquals, assertExists, assertRejects
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { makeConnectedChannel } from '../helpers.js';

/**
 * Register message type integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB]
 */
export function registerMessageTypeTests (makeTransportPair) {

	// ─── Test: Request message type - accepted ────────────────────────────────────

	Deno.test('request message type - accepted', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B accepts all message type requests (default: no preventDefault)
		channelB.addEventListener('newMessageType', (_event) => {
			// Do nothing - default behavior is to accept
		});

		const results = await channelA.addMessageTypes(['myType']);

		assertExists(results);
		assertEquals(results.length, 1);
		assertEquals(results[0].status, 'fulfilled');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
	});

	// ─── Test: Accepted type has a numeric ID ─────────────────────────────────────

	Deno.test('accepted type has a numeric ID', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		channelB.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});

		await channelA.addMessageTypes(['myType']);

		const typeInfo = channelA.getMessageType('myType');
		assertExists(typeInfo);
		assertExists(typeInfo.ids);
		assert(typeInfo.ids.length > 0, 'Type should have at least one ID');
		assert(typeof typeInfo.ids[0] === 'number', 'Type ID should be a number');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
	});

	// ─── Test: Request message type - rejected ────────────────────────────────────

	Deno.test('request message type - rejected', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B rejects all message type requests
		channelB.addEventListener('newMessageType', (event) => {
			event.preventDefault();
		});

		const results = await channelA.addMessageTypes(['myType']);

		assertExists(results);
		assertEquals(results.length, 1);
		assertEquals(results[0].status, 'rejected');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
	});

	// ─── Test: Request multiple types - one accepted, one rejected ────────────────

	Deno.test('request multiple types - one accepted, one rejected', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B accepts 'typeA' but rejects 'typeB'
		channelB.addEventListener('newMessageType', (event) => {
			if (event.detail.name === 'typeB') {
				event.preventDefault();
			}
		});

		const results = await channelA.addMessageTypes(['typeA', 'typeB']);

		assertExists(results);
		assertEquals(results.length, 2);

		// Find results by checking which is fulfilled and which is rejected
		const typeAResult = results[0]; // typeA was first
		const typeBResult = results[1]; // typeB was second

		assertEquals(typeAResult.status, 'fulfilled', 'typeA should be accepted');
		assertEquals(typeBResult.status, 'rejected', 'typeB should be rejected');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
	});

	// ─── Test: Accepted type can be used in write ─────────────────────────────────

	Deno.test('accepted type can be used in write', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		console.log('transports started, channel created, adding (unnecessary) message-type listener');
		channelB.addEventListener('newMessageType', (_event) => {
			console.log('default-accepting new message type', _event.detail);
			// Accept by default
		});

		await channelA.addMessageTypes(['myType']);
		console.log('back from message type request, writing with new type');

		// Should not throw
		await channelA.write('myType', 'hello', { eom: true });

		// B reads the message
		const readResult = await channelB.read({ decode: true });
		assertExists(readResult);
		assertEquals(readResult.text, 'hello');
		readResult.done();

		console.log('messaging done, closing channels');
		await Promise.all([channelA.close(), channelB.close()]);
		console.log('channels closed, stopping transports');
		await Promise.all([transportA.stop(), transportB.stop()]);
		console.log('transports stopped');
	});

	// ─── Test: Rejected type cannot be used in write ──────────────────────────────

	Deno.test('rejected type cannot be used in write', async () => {
		const [transportA, transportB] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// B rejects all message type requests
		channelB.addEventListener('newMessageType', (event) => {
			event.preventDefault();
		});

		await channelA.addMessageTypes(['myType']);

		// Writing with a rejected type should reject with RangeError
		await assertRejects(
			() => channelA.write('myType', 'hello', { eom: true }),
			RangeError
		);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
	});
}
