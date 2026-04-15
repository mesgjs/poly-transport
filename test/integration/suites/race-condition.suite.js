/*
 * Race Condition Integration Test Suite
 *
 * Tests for race conditions involving simultaneous channel creation and
 * simultaneous message-type registration on both ends of the same channel.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assertEquals, assertExists
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Channel } from '../../../src/channel.esm.js';

/**
 * Register race condition integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB, cleanup?]
 *   cleanup is an optional async function called after each test to release additional resources.
 */
export function registerRaceConditionTests (makeTransportPair) {

	// ─── Test: Simultaneous bidirectional channel creation ────────────────────────

	Deno.test('simultaneous bidirectional channel creation succeeds', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'race-bidi-channel';

		// Both sides accept incoming requests for this channel
		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});
		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		// Both sides simultaneously request the same channel
		const [channelA, channelB] = await Promise.all([
			transportA.requestChannel(channelName),
			transportB.requestChannel(channelName),
		]);

		assertExists(channelA);
		assertExists(channelB);
		assertEquals(channelA.state, Channel.STATE_OPEN);
		assertEquals(channelB.state, Channel.STATE_OPEN);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Simultaneous bidirectional channel creation + message type registration ──

	Deno.test('simultaneous channel creation and message type registration', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'race-msgtype-channel';

		// Both sides accept incoming requests for this channel
		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});
		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		// Both sides simultaneously request the same channel
		const [channelA, channelB] = await Promise.all([
			transportA.requestChannel(channelName),
			transportB.requestChannel(channelName),
		]);

		assertExists(channelA);
		assertExists(channelB);

		// Both sides accept incoming message type requests
		channelA.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});
		channelB.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});

		// Both sides simultaneously register message types
		const [resultsA, resultsB] = await Promise.all([
			channelA.addMessageTypes(['controlType']),
			channelB.addMessageTypes(['controlType']),
		]);

		assertExists(resultsA);
		assertExists(resultsB);

		// Both registrations should be fulfilled
		assertEquals(resultsA.length, 1, 'A should have 1 result');
		assertEquals(resultsB.length, 1, 'B should have 1 result');
		assertEquals(resultsA[0].status, 'fulfilled', 'A controlType should be accepted');
		assertEquals(resultsB[0].status, 'fulfilled', 'B controlType should be accepted');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Simultaneous channel creation + message type registration + data exchange ──

	Deno.test('simultaneous channel creation, message type registration, and data exchange', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'race-data-channel';

		// Both sides accept incoming requests for this channel
		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});
		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		// Both sides simultaneously request the same channel
		const [channelA, channelB] = await Promise.all([
			transportA.requestChannel(channelName),
			transportB.requestChannel(channelName),
		]);

		assertExists(channelA);
		assertExists(channelB);

		// Both sides accept incoming message type requests
		channelA.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});
		channelB.addEventListener('newMessageType', (_event) => {
			// Accept by default
		});

		// Both sides simultaneously register message types
		const [resultsA, resultsB] = await Promise.all([
			channelA.addMessageTypes(['appData']),
			channelB.addMessageTypes(['appData']),
		]);

		assertEquals(resultsA[0].status, 'fulfilled', 'A appData should be accepted');
		assertEquals(resultsB[0].status, 'fulfilled', 'B appData should be accepted');

		// A sends a message to B
		await channelA.write('appData', 'hello from A', { eom: true });

		// B reads the message
		const readResult = await channelB.read({ decode: true });
		assertExists(readResult);
		assertEquals(readResult.text, 'hello from A');
		readResult.done();

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Multiple simultaneous channel creations + message type registrations ──

	Deno.test('multiple simultaneous channel creations with message type registration', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelNames = ['race-multi-1', 'race-multi-2', 'race-multi-3'];

		// Both sides accept incoming requests for all channels
		transportA.addEventListener('newChannel', (event) => {
			if (channelNames.includes(event.detail.channelName)) event.accept();
		});
		transportB.addEventListener('newChannel', (event) => {
			if (channelNames.includes(event.detail.channelName)) event.accept();
		});

		// All channels simultaneously requested from both sides
		const channelPairs = await Promise.all(
			channelNames.map((name) => Promise.all([
				transportA.requestChannel(name),
				transportB.requestChannel(name),
			]))
		);

		// Verify all channels are open
		for (const [chA, chB] of channelPairs) {
			assertExists(chA);
			assertExists(chB);
			assertEquals(chA.state, Channel.STATE_OPEN);
			assertEquals(chB.state, Channel.STATE_OPEN);
		}

		// Register message types on all channels simultaneously
		const registrationPromises = channelPairs.flatMap(([chA, chB]) => {
			chA.addEventListener('newMessageType', (_event) => { /* accept */ });
			chB.addEventListener('newMessageType', (_event) => { /* accept */ });
			return [
				chA.addMessageTypes(['myType']),
				chB.addMessageTypes(['myType']),
			];
		});

		const allResults = await Promise.all(registrationPromises);

		// All registrations should be fulfilled
		for (const results of allResults) {
			assertEquals(results.length, 1);
			assertEquals(results[0].status, 'fulfilled');
		}

		// Close all channels and transports
		await Promise.all(channelPairs.flatMap(([chA, chB]) => [chA.close(), chB.close()]));
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});
}
