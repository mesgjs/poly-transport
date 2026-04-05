import {
	assertEquals, assertExists, assert, assertRejects
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { PostMessageTransport } from '../../src/transport/post-message.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import { Channel } from '../../src/channel.esm.js';
import { StateError } from '../../src/protocol.esm.js';

// ─── Paired Gateway ───────────────────────────────────────────────────────────

/**
 * A pair of gateways that are connected to each other.
 * Messages sent via postMessage on one are delivered as 'message' events on the other.
 */
class PairedGateway {
	listeners = new Map();
	peer = null;

	setPeer (peer) {
		this.peer = peer;
	}

	addEventListener (type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}

	removeEventListener (type, handler) {
		const handlers = this.listeners.get(type);
		if (handlers) {
			const idx = handlers.indexOf(handler);
			if (idx >= 0) handlers.splice(idx, 1);
		}
	}

	postMessage (data, _transfer) {
		// Deliver to peer's message listeners
		queueMicrotask(() => {
			if (this.peer) {
				const handlers = this.peer.listeners.get('message') || [];
				const event = { data };
				for (const handler of handlers) handler(event);
			}
		});
	}
}

/**
 * Create a pair of connected gateways
 */
function makePairedGateways () {
	const a = new PairedGateway();
	const b = new PairedGateway();
	a.setPeer(b);
	b.setPeer(a);
	return [a, b];
}

// ─── Transport Pair Helper ────────────────────────────────────────────────────

/**
 * Create two connected PostMessageTransport instances and start them.
 * Returns [transportA, transportB] both in ACTIVE state.
 */
async function makeConnectedTransports (optionsA = {}, optionsB = {}) {
	const [gatewayA, gatewayB] = makePairedGateways();
	const bufferPool = new BufferPool();

	const transportA = new PostMessageTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsA,
		gateway: gatewayA,
	});

	const transportB = new PostMessageTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsB,
		gateway: gatewayB,
	});

	// Start both transports simultaneously (they exchange handshakes)
	await Promise.all([transportA.start(), transportB.start()]);

	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);

	return [transportA, transportB];
}

/**
 * Request a channel from A and accept it on B.
 * Returns [channelA, channelB].
 */
async function makeConnectedChannel (transportA, transportB, name = 'test-channel') {
	// Set up B to accept the channel request
	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			// Get the channel after it's created
			setTimeout(() => resolve(transportB.getChannel(name)), 0);
		});
	});

	// Request channel from A
	const channelA = await transportA.requestChannel(name);
	const channelB = await channelBPromise;

	assertExists(channelA);
	assertExists(channelB);
	assertEquals(channelA.state, Channel.STATE_OPEN);
	assertEquals(channelB.state, Channel.STATE_OPEN);

	return [channelA, channelB];
}

// ─── Test: Basic bidirectional data exchange ──────────────────────────────────

Deno.test('Integration - two transports can connect and exchange data', async () => {
	const [transportA, transportB] = await makeConnectedTransports();

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
});

// ─── Test: Bidirectional graceful closure ─────────────────────────────────────

Deno.test('Integration - bidirectional graceful closure: both sides close gracefully', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	// Both sides close gracefully simultaneously
	const closeA = channelA.close({ discard: false });
	const closeB = channelB.close({ discard: false });

	// Both should complete
	await Promise.all([closeA, closeB]);

	assertEquals(channelA.state, Channel.STATE_CLOSED);
	assertEquals(channelB.state, Channel.STATE_CLOSED);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: One side initiates close, other side responds ─────────────────────

Deno.test('Integration - A initiates close, B responds by closing', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: Data exchange before graceful close ────────────────────────────────

Deno.test('Integration - data exchanged before graceful close is received', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: Bidirectional discard closure ─────────────────────────────────────

Deno.test('Integration - bidirectional discard closure: both sides close with discard', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	// Both sides close with discard simultaneously
	const closeA = channelA.close({ discard: true });
	const closeB = channelB.close({ discard: true });

	await Promise.all([closeA, closeB]);

	assertEquals(channelA.state, Channel.STATE_CLOSED);
	assertEquals(channelB.state, Channel.STATE_CLOSED);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: Asymmetric closure - A graceful, B discard ────────────────────────

Deno.test('Integration - asymmetric closure: A graceful, B discard', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	// A closes gracefully, B closes with discard
	const closeA = channelA.close({ discard: false });
	const closeB = channelB.close({ discard: true });

	await Promise.all([closeA, closeB]);

	assertEquals(channelA.state, Channel.STATE_CLOSED);
	assertEquals(channelB.state, Channel.STATE_CLOSED);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: Asymmetric closure - A discard, B graceful ────────────────────────

Deno.test('Integration - asymmetric closure: A discard, B graceful', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	// A closes with discard, B closes gracefully
	const closeA = channelA.close({ discard: true });
	const closeB = channelB.close({ discard: false });

	await Promise.all([closeA, closeB]);

	assertEquals(channelA.state, Channel.STATE_CLOSED);
	assertEquals(channelB.state, Channel.STATE_CLOSED);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: Acceleration - graceful → discard when remote sends discard ────────

Deno.test('Integration - acceleration: A graceful close switches to discard when B sends discard', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: beforeClose event fires on both sides ─────────────────────────────

Deno.test('Integration - beforeClose event fires on both sides during close', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: closed event fires on both sides ───────────────────────────────────

Deno.test('Integration - closed event fires on both sides after close', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: write throws StateError after close initiated ──────────────────────

Deno.test('Integration - write throws StateError after close initiated', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: Channel reopening after close ─────────────────────────────────────

Deno.test('Integration - channel can be reopened after close', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: Multiple channels can be closed independently ─────────────────────

Deno.test('Integration - multiple channels can be closed independently', async () => {
	const [transportA, transportB] = await makeConnectedTransports();

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
});

// ─── Test: Transport stop closes all channels ─────────────────────────────────

Deno.test('Integration - transport stop closes all open channels', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: Pending read rejected when channel closes ─────────────────────────

Deno.test('Integration - pending read is rejected when channel closes', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	// Start a read on B that will wait
	const readPromise = channelB.read({ timeout: 5000 });

	// A and B both close
	const closeA = channelA.close();
	const closeB = channelB.close();

	// The pending read on B should be rejected
	await assertRejects(() => readPromise);

	await Promise.all([closeA, closeB]);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: Flow control budget restored during closure ───────────────────────

Deno.test('Integration - flow control budget is maintained during graceful close', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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

	// FAILS during closing
	await Promise.all([closeA, closeB]);

	assertEquals(channelA.state, Channel.STATE_CLOSED);
	assertEquals(channelB.state, Channel.STATE_CLOSED);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Test: Discard mode discards buffered data ────────────────────────────────

Deno.test('Integration - discard mode discards buffered data on receiver', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});

// ─── Test: TCC/C2C channels are not closed by transport.stop ─────────────────

Deno.test('Integration - TCC channel is not closed by transport stop', async () => {
	const [transportA, transportB] = await makeConnectedTransports();

	// Stop transport A - should not attempt to close TCC
	// (If it did, it would log a warning per architecture doc)
	// We verify by checking that stop completes without error
	await transportA.stop();
	assertEquals(transportA.state, Transport.STATE_STOPPED);

	await transportB.stop();
});

// ─── Test: Channel close with data in flight ──────────────────────────────────

Deno.test('Integration - graceful close waits for in-flight writes to be ACKed', async () => {
	const [transportA, transportB] = await makeConnectedTransports();
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
});
