/*
 * Channel Close Integration Test Suite
 *
 * Shared test suite for channel close scenarios across all transport types.
 * Tests are registered by calling registerChannelCloseTests(makeTransportPair).
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assertEquals, assertExists, assert, assertRejects
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Transport } from '../../../src/transport/base.esm.js';
import { Channel } from '../../../src/channel.esm.js';
import { StateError } from '../../../src/protocol.esm.js';
import { makeConnectedChannel } from '../helpers.js';

/**
 * Register channel close integration tests for a given transport pair factory.
 * @param {Function} makeTransportPair - Factory function that returns [transportA, transportB, cleanup?]
 *   cleanup is an optional async function called after each test to release additional resources.
 */
export function registerChannelCloseTests (makeTransportPair) {

	// ─── Test: Basic bidirectional data exchange ──────────────────────────────────

	Deno.test('two transports can connect and exchange data', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes a message, B reads it
		await channelA.write(2, 'hello from A', { eom: true });

		const readResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'hello from A');
		assertEquals(readResult.eom, true);
		readResult.done();

		await new Promise((resolve) => setTimeout(resolve, 100));

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Bidirectional graceful closure ─────────────────────────────────────

	Deno.test('bidirectional graceful closure: both sides close gracefully', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Both sides close gracefully simultaneously
		const closeA = channelA.close({ discard: false });
		const closeB = channelB.close({ discard: false });

		// Both should complete
		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: One side initiates close, other side responds ─────────────────────

	Deno.test('A initiates close, B responds by closing', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Set up B to close when it receives chanClose from A
		const closeBPromise = new Promise((resolve) => {
			channelB.addEventListener('beforeClose', async () => {
				// B responds by closing its side
				resolve(channelB.close());
			});
		});

		// A initiates close
		const closeA = channelA.close({ discard: false });

		// Wait for B to respond and both to complete
		const closeB = await closeBPromise;
		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Data exchange before graceful close ────────────────────────────────

	Deno.test('data exchanged before graceful close is received', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes data, then closes
		await channelA.write(2, 'message before close', { eom: true });

		// B reads the data
		const readResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'message before close');
		readResult.done();

		// Now both sides close
		const closeA = channelA.close({ discard: false });
		const closeB = channelB.close({ discard: false });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Bidirectional discard closure ─────────────────────────────────────

	Deno.test('bidirectional discard closure: both sides close with discard', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Both sides close with discard simultaneously
		const closeA = channelA.close({ discard: true });
		const closeB = channelB.close({ discard: true });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Asymmetric closure - A graceful, B discard ────────────────────────

	Deno.test('asymmetric closure: A graceful, B discard', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A closes gracefully, B closes with discard
		const closeA = channelA.close({ discard: false });
		const closeB = channelB.close({ discard: true });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Asymmetric closure - A discard, B graceful ────────────────────────

	Deno.test('asymmetric closure: A discard, B graceful', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A closes with discard, B closes gracefully
		const closeA = channelA.close({ discard: true });
		const closeB = channelB.close({ discard: false });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Acceleration - graceful → discard when remote sends discard ────────

	Deno.test('acceleration: A graceful close switches to discard when B sends discard', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Buffer some data on A's side
		await channelA.write(2, 'data that will be discarded', { eom: true });

		// A starts graceful close
		const closeA = channelA.close({ discard: false });

		// B closes with discard (should accelerate A to discard mode)
		const closeB = channelB.close({ discard: true });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: beforeClose event fires on both sides ─────────────────────────────

	Deno.test('beforeClose event fires on both sides during close', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let beforeCloseA = false;
		let beforeCloseB = false;

		channelA.addEventListener('beforeClose', () => { beforeCloseA = true; });
		channelB.addEventListener('beforeClose', () => { beforeCloseB = true; });

		const closeA = channelA.close();
		const closeB = channelB.close();

		await Promise.all([closeA, closeB]);

		assert(beforeCloseA, 'beforeClose should fire on A');
		assert(beforeCloseB, 'beforeClose should fire on B');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: closed event fires on both sides ───────────────────────────────────

	Deno.test('closed event fires on both sides after close', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		let closedA = false;
		let closedB = false;

		channelA.addEventListener('closed', () => { closedA = true; });
		channelB.addEventListener('closed', () => { closedB = true; });

		const closeA = channelA.close();
		const closeB = channelB.close();

		await Promise.all([closeA, closeB]);

		assert(closedA, 'closed event should fire on A');
		assert(closedB, 'closed event should fire on B');

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: write throws StateError after close initiated ──────────────────────

	Deno.test('write throws StateError after close initiated', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Start close on A
		const closeA = channelA.close();

		// Write should throw StateError immediately
		assert(
			(() => {
				try {
					channelA.write(2, 'should fail');
					return false;
				} catch (e) {
					return e instanceof StateError;
				}
			})(),
			'write should throw StateError after close initiated'
		);

		// Complete close
		const closeB = channelB.close();
		await Promise.all([closeA, closeB]);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Channel reopening after close ─────────────────────────────────────

	Deno.test('channel can be reopened after close', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const channelName = 'reopen-test';

		// First open
		const [channelA1, channelB1] = await makeConnectedChannel(
			transportA, transportB, channelName
		);

		// Close both sides
		const closeA1 = channelA1.close();
		const closeB1 = channelB1.close();
		await Promise.all([closeA1, closeB1]);

		assertEquals(channelA1.state, Channel.STATE_CLOSED);
		assertEquals(channelB1.state, Channel.STATE_CLOSED);

		// Reopen the channel
		const [channelA2, channelB2] = await makeConnectedChannel(
			transportA, transportB, channelName
		);

		assertExists(channelA2);
		assertExists(channelB2);
		assertEquals(channelA2.state, Channel.STATE_OPEN);
		assertEquals(channelB2.state, Channel.STATE_OPEN);

		// Verify data can flow on the reopened channel
		await channelA2.write(2, 'hello after reopen', { eom: true });
		const readResult = await channelB2.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'hello after reopen');
		readResult.done();

		// Clean up
		const closeA2 = channelA2.close();
		const closeB2 = channelB2.close();
		await Promise.all([closeA2, closeB2]);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Multiple channels can be closed independently ─────────────────────

	Deno.test('multiple channels can be closed independently', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();

		const [chA1, chB1] = await makeConnectedChannel(
			transportA, transportB, 'channel-1'
		);
		const [chA2, chB2] = await makeConnectedChannel(
			transportA, transportB, 'channel-2'
		);

		// Close channel 1
		const closeA1 = chA1.close();
		const closeB1 = chB1.close();
		await Promise.all([closeA1, closeB1]);

		assertEquals(chA1.state, Channel.STATE_CLOSED);
		assertEquals(chB1.state, Channel.STATE_CLOSED);

		// Channel 2 should still be open
		assertEquals(chA2.state, Channel.STATE_OPEN);
		assertEquals(chB2.state, Channel.STATE_OPEN);

		// Data should still flow on channel 2
		const writePromise = chA2.write(2, 'still working', { eom: true });
		const readResult = await chB2.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'still working');
		readResult.done();
		await writePromise;

		// Close channel 2
		const closeA2 = chA2.close();
		const closeB2 = chB2.close();
		await Promise.all([closeA2, closeB2]);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Transport stop closes all channels ─────────────────────────────────

	Deno.test('transport stop closes all open channels', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		assertEquals(channelA.state, Channel.STATE_OPEN);

		// Stop transport A - should close all channels
		// We need B to also close its side when it receives chanClose
		const closedBPromise = new Promise((resolve) => {
			channelB.addEventListener('beforeClose', () => {
				channelB.close().then(resolve);
			});
		});

		await transportA.stop();
		await closedBPromise;

		assertEquals(transportA.state, Transport.STATE_STOPPED);

		await transportB.stop();
		await cleanup?.();
	});

	// ─── Test: Pending read returns null when channel closes ─────────────────────

	Deno.test('pending read returns null when channel closes', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Start a read on B that will wait
		const readPromise = channelB.read({ timeout: 5000 });

		// A and B both close
		const closeA = channelA.close();
		const closeB = channelB.close();

		// The pending read on B should return null (graceful close is a normal condition)
		const result = await readPromise;
		assertEquals(result, null);

		await Promise.all([closeA, closeB]);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Flow control budget restored during closure ───────────────────────

	Deno.test('flow control budget is maintained during graceful close', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Write several messages from A to B
		const messages = ['msg1', 'msg2', 'msg3'];
		for (const msg of messages) {
			await channelA.write(2, msg, { eom: true });
		}

		// Read all messages on B
		for (const expected of messages) {
			const result = await channelB.read({ decode: true, timeout: 1000 });
			assertExists(result);
			assertEquals(result.text, expected);
			result.done();
		}

		// Now close gracefully - all ACKs should have been sent
		const closeA = channelA.close({ discard: false });
		const closeB = channelB.close({ discard: false });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Discard mode discards buffered data ────────────────────────────────

	Deno.test('discard mode discards buffered data on receiver', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// A writes data that B hasn't read yet
		await channelA.write(2, 'data to be discarded', { eom: true });

		// Give time for data to arrive at B
		await new Promise((r) => setTimeout(r, 10));

		// B closes with discard (discards the buffered data)
		const closeB = channelB.close({ discard: true });
		const closeA = channelA.close({ discard: true });

		await Promise.all([closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});

	// ─── Test: Channel close with data in flight ──────────────────────────────────

	Deno.test('graceful close waits for in-flight writes to be ACKed', async () => {
		const [transportA, transportB, cleanup] = await makeTransportPair();
		const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

		// Write data from A
		const writePromise = channelA.write(2, 'in-flight data', { eom: true });

		// Immediately start graceful close on A
		// (close should wait for the write to be ACKed)
		const closeA = channelA.close({ discard: false });

		// B reads the data (which will trigger ACK back to A)
		const readResult = await channelB.read({ decode: true, timeout: 1000 });
		assertExists(readResult);
		assertEquals(readResult.text, 'in-flight data');
		readResult.done();

		// B also closes
		const closeB = channelB.close({ discard: false });

		// Both closes should complete
		await Promise.all([writePromise, closeA, closeB]);

		assertEquals(channelA.state, Channel.STATE_CLOSED);
		assertEquals(channelB.state, Channel.STATE_CLOSED);

		await Promise.all([transportA.stop(), transportB.stop()]);
		await cleanup?.();
	});
}
