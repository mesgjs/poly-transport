/*
 * Signal Integration Test Suite
 *
 * Shared test suite for signal scenarios across all transport types.
 * Tests are registered by calling registerSignalTests(makeTransportPair).
 */

import {
	assert, assertEquals, assertExists, assertRejects
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { makeConnectedChannel } from '../helpers.js';
import { StateError } from '../../../src/transport/base.esm.js';

/**
 * Register signal integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB, cleanup?]
 */
export function registerSignalTests (makeTransportPair) {

	// --- Test: Transport-level signal: A sends, B receives -------------------

	Deno.test('signal: transport-level signal A sends, B receives', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		let receivedDetail = 'NOT_SET';
		transportB.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await transportA.signal('ping');

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		assertEquals(receivedDetail, 'ping');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Transport-level signal: B sends, A receives -------------------

	Deno.test('signal: transport-level signal B sends, A receives', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		let receivedDetail = 'NOT_SET';
		transportA.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await transportB.signal('pong');

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		assertEquals(receivedDetail, 'pong');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Transport-level signal with undefined text --------------------

	Deno.test('signal: transport-level signal with undefined text', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		let receivedDetail = 'NOT_SET';
		transportB.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await transportA.signal(undefined);

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		// undefined text → null detail (dispatchEvent default)
		assertEquals(receivedDetail, null);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Channel-level signal: A sends, B receives --------------------

	Deno.test('signal: channel-level signal A sends, B receives', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let receivedDetail = 'NOT_SET';
		channelB.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await channelA.signal('hello');

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		assertEquals(receivedDetail, 'hello');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Channel-level signal: B sends, A receives --------------------

	Deno.test('signal: channel-level signal B sends, A receives', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let receivedDetail = 'NOT_SET';
		channelA.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await channelB.signal('world');

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		assertEquals(receivedDetail, 'world');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Channel-level signal with undefined text ----------------------

	Deno.test('signal: channel-level signal with undefined text', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let receivedDetail = 'NOT_SET';
		channelB.addEventListener('signal', (event) => {
			receivedDetail = event.detail;
		});

		await channelA.signal(undefined);

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		// undefined text → null detail (dispatchEvent default)
		assertEquals(receivedDetail, null);

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Multiple signals in sequence ----------------------------------

	Deno.test('signal: multiple transport-level signals in sequence', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		const received = [];
		transportB.addEventListener('signal', (event) => {
			received.push(event.detail);
		});

		await transportA.signal('first');
		await transportA.signal('second');
		await transportA.signal('third');

		// Allow time for all signals to be delivered
		await new Promise(resolve => setTimeout(resolve, 100));

		assertEquals(received.length, 3);
		assertEquals(received[0], 'first');
		assertEquals(received[1], 'second');
		assertEquals(received[2], 'third');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Signal does not interfere with data messages ------------------

	Deno.test('signal: signal does not interfere with data messages', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let signalReceived = false;
		channelB.addEventListener('signal', (_event) => {
			signalReceived = true;
		});

		// Send a signal and a data message concurrently
		const signalPromise = channelA.signal('signal-payload');
		const dataPromise = channelA.write(0, 'data-payload', { eom: true });

		await Promise.all([signalPromise, dataPromise]);

		// Read the data message
		const readResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'data-payload');
		readResult.done();

		// Allow time for signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		assert(signalReceived, 'Signal should have been received');

		await Promise.all([channelA.close(), channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: Signal on closing channel throws StateError ------------------

	Deno.test('signal: signal on closing channel throws StateError', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Begin closing channelA
		const closePromise = channelA.close();

		// Attempt to signal on closing channel
		await assertRejects(
			() => channelA.signal('x'),
			StateError
		);

		// Complete close
		await Promise.all([closePromise, channelB.close()]);
		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// --- Test: No signal event when no listener ------------------------------

	Deno.test('signal: no error when signal received with no listener', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		// No signal listener on transportB - should not throw
		await transportA.signal('no-listener');

		// Allow time for the signal to be delivered
		await new Promise(resolve => setTimeout(resolve, 50));

		// Transport should still be functional
		assertEquals(transportB.stateString, 'active');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});
}
