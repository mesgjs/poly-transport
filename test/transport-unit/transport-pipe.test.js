import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { PipeTransport } from '../../src/transport/pipe.esm.js';
import { ByteTransport } from '../../src/transport/byte.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	TCC_DTAM_TRAN_STOPPED, CHANNEL_TCC,
	HDR_TYPE_CHAN_DATA, DATA_HEADER_BYTES,
} from '../../src/protocol.esm.js';
import { makeMemoryPipePair, makePipeTransportPair } from '../transport-pipe-helpers.js';

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('PipeTransport - constructor requires readable', () => {
	const { TransformStream } = globalThis;
	const { writable } = new TransformStream();
	try {
		new PipeTransport({ writable });
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof TypeError);
		assert(err.message.includes('readable'));
	}
});

Deno.test('PipeTransport - constructor requires writable', () => {
	const { TransformStream } = globalThis;
	const { readable } = new TransformStream();
	try {
		new PipeTransport({ readable });
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof TypeError);
		assert(err.message.includes('writable'));
	}
});

Deno.test('PipeTransport - constructor creates transport in STATE_CREATED', () => {
	const { TransformStream } = globalThis;
	const { readable, writable } = new TransformStream();
	const transport = new PipeTransport({ readable, writable });
	assertEquals(transport.state, Transport.STATE_CREATED);
});

Deno.test('PipeTransport - extends ByteTransport and Transport', () => {
	const { TransformStream } = globalThis;
	const { readable, writable } = new TransformStream();
	const transport = new PipeTransport({ readable, writable });
	assert(transport instanceof PipeTransport);
	assert(transport instanceof ByteTransport);
	assert(transport instanceof Transport);
});

Deno.test('PipeTransport - needsEncodedText returns true', () => {
	const { TransformStream } = globalThis;
	const { readable, writable } = new TransformStream();
	const transport = new PipeTransport({ readable, writable });
	assertEquals(transport.needsEncodedText, true);
});

Deno.test('PipeTransport - has transport id and logger', () => {
	const { TransformStream } = globalThis;
	const { readable, writable } = new TransformStream();
	const transport = new PipeTransport({ readable, writable });
	assertExists(transport.id);
	assertExists(transport.logger);
});

// ─── Lifecycle Tests ──────────────────────────────────────────────────────────

Deno.test('PipeTransport - start and stop (paired)', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(transportA.state, Transport.STATE_STOPPED);
	assertEquals(transportB.state, Transport.STATE_STOPPED);
});

Deno.test('PipeTransport - start resolves when both sides complete handshake', async () => {
	const [transportA, transportB] = await makePipeTransportPair();
	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);
	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('PipeTransport - stop resolves cleanly', async () => {
	const [transportA, transportB] = await makePipeTransportPair();
	const stopPromise = Promise.all([transportA.stop(), transportB.stop()]);
	await stopPromise;
	assertEquals(transportA.state, Transport.STATE_STOPPED);
	assertEquals(transportB.state, Transport.STATE_STOPPED);
});

Deno.test('PipeTransport - beforeStopping event fires before stopped', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const events = [];
	transportA.addEventListener('beforeStopping', () => events.push('beforeStopping'));
	transportA.addEventListener('stopped', () => events.push('stopped'));

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(events[0], 'beforeStopping');
	assertEquals(events[1], 'stopped');
});

Deno.test('PipeTransport - stopped event fires after stop', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	let stoppedFired = false;
	transportA.addEventListener('stopped', () => { stoppedFired = true; });

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(stoppedFired, true);
});

// ─── Channel Tests ────────────────────────────────────────────────────────────

Deno.test('PipeTransport - requestChannel creates channel on both sides', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('test');
	const channelB = await channelBPromise;

	assertExists(channelA);
	assertExists(channelB);
	assertEquals(channelA.name, 'test');
	assertEquals(channelB.name, 'test');

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('PipeTransport - requestChannel rejected by remote', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	transportB.addEventListener('newChannel', (event) => {
		event.reject();
	});

	await assertRejects(
		() => transportA.requestChannel('test'),
		Error,
		'rejected'
	);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Data Exchange Tests ──────────────────────────────────────────────────────

Deno.test('PipeTransport - write and read a message', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('data-test');
	const channelB = await channelBPromise;

	// Write from A
	await channelA.write(0, 'Hello, Pipe!');

	// Read on B
	const message = await channelB.read({ decode: true });
	assertExists(message);
	assertEquals(message.text, 'Hello, Pipe!');
	message.done();

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('PipeTransport - write and read binary data', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('binary-test');
	const channelB = await channelBPromise;

	const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	await channelA.write(0, testData);

	const message = await channelB.read();
	assertExists(message);
	assertExists(message.data);
	const received = message.data.toUint8Array();
	assertEquals(received.length, testData.length);
	for (let i = 0; i < testData.length; i++) {
		assertEquals(received[i], testData[i]);
	}
	message.done();

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('PipeTransport - bidirectional data exchange', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('bidi-test');
	const channelB = await channelBPromise;

	// A → B
	await channelA.write(0, 'From A');
	const msgOnB = await channelB.read({ decode: true });
	assertEquals(msgOnB.text, 'From A');
	msgOnB.done();

	// B → A
	await channelB.write(0, 'From B');
	const msgOnA = await channelA.read({ decode: true });
	assertEquals(msgOnA.text, 'From B');
	msgOnA.done();

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('PipeTransport - multiple messages in sequence', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('multi-test');
	const channelB = await channelBPromise;

	const messages = ['first', 'second', 'third'];
	for (const msg of messages) {
		await channelA.write(0, msg);
	}

	for (const expected of messages) {
		const message = await channelB.read({ decode: true });
		assertEquals(message.text, expected);
		message.done();
	}

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Channel Close Tests ──────────────────────────────────────────────────────

Deno.test('PipeTransport - channel close completes gracefully', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			resolve(event.accept());
		});
	});

	const channelA = await transportA.requestChannel('close-test');
	const channelB = await channelBPromise;

	// Close both sides
	await Promise.all([channelA.close(), channelB.close()]);

	assertEquals(channelA.state, 'closed');
	assertEquals(channelB.state, 'closed');

	await Promise.all([transportA.stop(), transportB.stop()]);
});

// ─── Disconnect Tests ─────────────────────────────────────────────────────────

Deno.test('PipeTransport - pipe end triggers disconnect', async () => {
	// Use makeMemoryPipePair so we have access to the controllers for test injection
	const pipes = makeMemoryPipePair();
	const bufferPool = new BufferPool();
	const transportA = new PipeTransport({
		bufferPool,
		readable: pipes.a.readable,
		writable: pipes.a.writable,
	});
	const transportB = new PipeTransport({
		bufferPool,
		readable: pipes.b.readable,
		writable: pipes.b.writable,
	});

	await Promise.all([transportA.start(), transportB.start()]);

	// Close the B→A stream (simulates B's write end closing)
	pipes.bToA_controller.close();

	// Wait for A to detect the disconnect
	await new Promise((r) => setTimeout(r, 50));

	// A should have transitioned to stopped or disconnected
	const stateA = transportA.state;
	assert(
		stateA === Transport.STATE_STOPPED || stateA === Transport.STATE_DISCONNECTED,
		`Expected stopped or disconnected, got ${transportA.stateString}`
	);

	// Clean up B
	try { await transportB.stop(); } catch (_) { /* may already be stopped */ }
});

// ─── Role Assignment Tests ────────────────────────────────────────────────────

Deno.test('PipeTransport - transports get different roles', async () => {
	const [transportA, transportB] = await makePipeTransportPair();

	// One should be ROLE_EVEN, the other ROLE_ODD
	const roles = new Set([transportA.role, transportB.role]);
	assert(roles.has(Transport.ROLE_EVEN), 'One transport should be ROLE_EVEN');
	assert(roles.has(Transport.ROLE_ODD), 'One transport should be ROLE_ODD');
	assert(transportA.role !== transportB.role, 'Transports should have different roles');

	await Promise.all([transportA.stop(), transportB.stop()]);
});
