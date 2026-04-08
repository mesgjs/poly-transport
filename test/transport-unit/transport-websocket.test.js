import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { WebSocketTransport } from '../../src/transport/websocket.esm.js';
import { ByteTransport } from '../../src/transport/byte.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import { makeMemoryWebSocketPair, makeWebSocketTransportPair } from '../transport-websocket-helpers.js';

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('WebSocketTransport - constructor requires ws', () => {
	try {
		new WebSocketTransport({});
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof TypeError);
		assert(err.message.includes('ws'));
	}
});

Deno.test('WebSocketTransport - constructor creates transport in STATE_CREATED', () => {
	const { a: ws } = makeMemoryWebSocketPair();
	const transport = new WebSocketTransport({ ws });
	assertEquals(transport.state, Transport.STATE_CREATED);
});

Deno.test('WebSocketTransport - extends ByteTransport and Transport', () => {
	const { a: ws } = makeMemoryWebSocketPair();
	const transport = new WebSocketTransport({ ws });
	assert(transport instanceof WebSocketTransport);
	assert(transport instanceof ByteTransport);
	assert(transport instanceof Transport);
});

Deno.test('WebSocketTransport - needsEncodedText returns true', () => {
	const { a: ws } = makeMemoryWebSocketPair();
	const transport = new WebSocketTransport({ ws });
	assertEquals(transport.needsEncodedText, true);
});

Deno.test('WebSocketTransport - has transport id and logger', () => {
	const { a: ws } = makeMemoryWebSocketPair();
	const transport = new WebSocketTransport({ ws });
	assertExists(transport.id);
	assertExists(transport.logger);
});

Deno.test('WebSocketTransport - sets binaryType to arraybuffer', () => {
	const { a: ws } = makeMemoryWebSocketPair();
	new WebSocketTransport({ ws });
	assertEquals(ws.binaryType, 'arraybuffer');
});

// ─── Lifecycle Tests ──────────────────────────────────────────────────────────

Deno.test('WebSocketTransport - start and stop (paired)', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(transportA.state, Transport.STATE_STOPPED);
	assertEquals(transportB.state, Transport.STATE_STOPPED);
});

Deno.test('WebSocketTransport - start resolves when both sides complete handshake', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();
	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);
	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('WebSocketTransport - stop resolves cleanly', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();
	const stopPromise = Promise.all([transportA.stop(), transportB.stop()]);
	await stopPromise;
	assertEquals(transportA.state, Transport.STATE_STOPPED);
	assertEquals(transportB.state, Transport.STATE_STOPPED);
});

Deno.test('WebSocketTransport - beforeStopping event fires before stopped', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const events = [];
	transportA.addEventListener('beforeStopping', () => events.push('beforeStopping'));
	transportA.addEventListener('stopped', () => events.push('stopped'));

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(events[0], 'beforeStopping');
	assertEquals(events[1], 'stopped');
});

Deno.test('WebSocketTransport - stopped event fires after stop', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	let stoppedFired = false;
	transportA.addEventListener('stopped', () => { stoppedFired = true; });

	await Promise.all([transportA.stop(), transportB.stop()]);

	assertEquals(stoppedFired, true);
});

// ─── Channel Tests ────────────────────────────────────────────────────────────

Deno.test('WebSocketTransport - requestChannel creates channel on both sides', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('test')), 0);
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

Deno.test('WebSocketTransport - requestChannel rejected by remote', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

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

Deno.test('WebSocketTransport - write and read a message', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('data-test')), 0);
		});
	});

	const channelA = await transportA.requestChannel('data-test');
	const channelB = await channelBPromise;

	// Write from A
	await channelA.write(0, 'Hello, WebSocket!');

	// Read on B
	const message = await channelB.read({ decode: true });
	assertExists(message);
	assertEquals(message.text, 'Hello, WebSocket!');
	message.done();

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('WebSocketTransport - write and read binary data', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('binary-test')), 0);
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

Deno.test('WebSocketTransport - bidirectional data exchange', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('bidi-test')), 0);
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

Deno.test('WebSocketTransport - multiple messages in sequence', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('multi-test')), 0);
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

Deno.test('WebSocketTransport - channel close completes gracefully', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(transportB.getChannel('close-test')), 0);
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

Deno.test('WebSocketTransport - WebSocket close triggers disconnect', async () => {
	const { a: wsA, b: wsB } = makeMemoryWebSocketPair();
	const bufferPool = new BufferPool();
	const transportA = new WebSocketTransport({
		bufferPool,
		ws: wsA,
	});
	const transportB = new WebSocketTransport({
		bufferPool,
		ws: wsB,
	});

	await Promise.all([transportA.start(), transportB.start()]);

	// Simulate B's WebSocket closing abruptly (without going through transport stop)
	wsB.readyState = 1; // OPEN — ensure close() will fire the event
	wsB.close();

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

Deno.test('WebSocketTransport - transports get different roles', async () => {
	const [transportA, transportB] = await makeWebSocketTransportPair();

	// One should be ROLE_EVEN, the other ROLE_ODD
	const roles = new Set([transportA.role, transportB.role]);
	assert(roles.has(Transport.ROLE_EVEN), 'One transport should be ROLE_EVEN');
	assert(roles.has(Transport.ROLE_ODD), 'One transport should be ROLE_ODD');
	assert(transportA.role !== transportB.role, 'Transports should have different roles');

	await Promise.all([transportA.stop(), transportB.stop()]);
});
