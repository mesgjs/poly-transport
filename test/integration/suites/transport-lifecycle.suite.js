/*
 * Transport Lifecycle Integration Test Suite
 *
 * Shared test suite for transport lifecycle and channel request scenarios.
 * Tests are registered by calling registerTransportLifecycleTests(makeTransportPair).
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assert, assertEquals, assertExists, assertRejects
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Transport } from '../../../src/transport/base.esm.js';
import { Channel } from '../../../src/channel.esm.js';

/**
 * Register transport lifecycle integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB, cleanup?]
 *   cleanup is an optional async function called after each test to release additional resources.
 */
export function registerTransportLifecycleTests (makeTransportPair) {
	Deno.test('create and start transports', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		assertEquals(transportA.state, Transport.STATE_ACTIVE);
		assertEquals(transportB.state, Transport.STATE_ACTIVE);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	Deno.test('stop transports', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		await Promise.all([transportA.stop(), transportB.stop()]);

		assertEquals(transportA.state, Transport.STATE_STOPPED);
		assertEquals(transportB.state, Transport.STATE_STOPPED);
		await cleanup?.();
	});

	Deno.test('unidirectional channel request accepted', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'accepted-channel';

		const channelBPromise = new Promise((resolve) => {
			transportB.addEventListener('newChannel', (event) => {
				if (event.detail.channelName !== channelName) return;
				event.accept();
				setTimeout(() => resolve(transportB.getChannel(channelName)), 0);
			});
		});

		const channelA = await transportA.requestChannel(channelName);
		const channelB = await channelBPromise;

		assertExists(channelA);
		assertExists(channelB);
		assertEquals(channelA.state, Channel.STATE_OPEN);
		assertEquals(channelB.state, Channel.STATE_OPEN);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	Deno.test('channel is accessible by name after acceptance', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'lookup-channel';

		const channelBPromise = new Promise((resolve) => {
			transportB.addEventListener('newChannel', (event) => {
				if (event.detail.channelName !== channelName) return;
				event.accept();
				setTimeout(() => resolve(transportB.getChannel(channelName)), 0);
			});
		});

		const channelA = await transportA.requestChannel(channelName);
		const channelB = await channelBPromise;

		assertEquals(transportA.getChannel(channelName), channelA);
		assertEquals(transportB.getChannel(channelName), channelB);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	Deno.test('unidirectional channel request rejected', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'rejected-channel';

		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName !== channelName) return;
			event.reject();
		});

		await assertRejects(
			async () => transportA.requestChannel(channelName),
			Error,
			'Channel request rejected by remote'
		);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	Deno.test('no channel registered after rejection', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'rejected-lookup-channel';

		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName !== channelName) return;
			event.reject();
		});

		await assertRejects(() => transportA.requestChannel(channelName));

		assertEquals(transportA.getChannel(channelName), undefined);
		assertEquals(transportB.getChannel(channelName), undefined);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	Deno.test('bidirectional simultaneous channel request, mutual accept', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'bidirectional-channel';

		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

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

	Deno.test('bidirectional channel has two IDs', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'bidirectional-two-ids';

		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		transportB.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === channelName) event.accept();
		});

		const [channelA, channelB] = await Promise.all([
			transportA.requestChannel(channelName),
			transportB.requestChannel(channelName),
		]);

		// Allow time for all round-trips to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		//console.log('ids', channelA.ids, channelB.ids);
		assert(channelA.ids.length === 2 || channelB.ids.length === 2);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});
}
