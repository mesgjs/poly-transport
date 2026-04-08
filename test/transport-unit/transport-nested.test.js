import { assertEquals, assertRejects, assert, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { NestedTransport } from '../../src/transport/nested.esm.js';
import { ByteTransport } from '../../src/transport/byte.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import { makeNestedTransportPair } from '../transport-nested-helpers.js';
import { makeByteTransportPair, makeConnectedChannel } from '../integration/helpers.js';

// ─── Constructor Tests ────────────────────────────────────────────────────────

Deno.test('NestedTransport - constructor requires channel', () => {
	try {
		new NestedTransport({ messageType: 0 });
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof TypeError);
		assert(err.message.includes('channel'));
	}
});

Deno.test('NestedTransport - constructor requires messageType', async () => {
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA] = await makeConnectedChannel(parentA, parentB, 'test');

	try {
		new NestedTransport({ channel: chanA });
		assert(false, 'Should have thrown');
	} catch (err) {
		assert(err instanceof TypeError);
		assert(err.message.includes('messageType'));
	} finally {
		await Promise.all([parentA.stop(), parentB.stop()]);
	}
});

Deno.test('NestedTransport - constructor creates transport in STATE_CREATED', async () => {
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA] = await makeConnectedChannel(parentA, parentB, 'test');

	const transport = new NestedTransport({ channel: chanA, messageType: 0 });
	assertEquals(transport.state, Transport.STATE_CREATED);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - extends ByteTransport and Transport', async () => {
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA] = await makeConnectedChannel(parentA, parentB, 'test');

	const transport = new NestedTransport({ channel: chanA, messageType: 0 });
	assert(transport instanceof NestedTransport);
	assert(transport instanceof ByteTransport);
	assert(transport instanceof Transport);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - needsEncodedText returns true', async () => {
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA] = await makeConnectedChannel(parentA, parentB, 'test');

	const transport = new NestedTransport({ channel: chanA, messageType: 0 });
	assertEquals(transport.needsEncodedText, true);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - has transport id and logger', async () => {
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA] = await makeConnectedChannel(parentA, parentB, 'test');

	const transport = new NestedTransport({ channel: chanA, messageType: 0 });
	assertExists(transport.id);
	assertExists(transport.logger);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Lifecycle Tests ──────────────────────────────────────────────────────────

Deno.test('NestedTransport - start and stop (paired)', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	assertEquals(nestedA.state, Transport.STATE_ACTIVE);
	assertEquals(nestedB.state, Transport.STATE_ACTIVE);

	await Promise.all([nestedA.stop(), nestedB.stop()]);

	assertEquals(nestedA.state, Transport.STATE_STOPPED);
	assertEquals(nestedB.state, Transport.STATE_STOPPED);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - start resolves when both sides complete handshake', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();
	assertEquals(nestedA.state, Transport.STATE_ACTIVE);
	assertEquals(nestedB.state, Transport.STATE_ACTIVE);
	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - stop resolves cleanly', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();
	await Promise.all([nestedA.stop(), nestedB.stop()]);
	assertEquals(nestedA.state, Transport.STATE_STOPPED);
	assertEquals(nestedB.state, Transport.STATE_STOPPED);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - beforeStopping event fires before stopped', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const events = [];
	nestedA.addEventListener('beforeStopping', () => events.push('beforeStopping'));
	nestedA.addEventListener('stopped', () => events.push('stopped'));

	await Promise.all([nestedA.stop(), nestedB.stop()]);

	assertEquals(events[0], 'beforeStopping');
	assertEquals(events[1], 'stopped');

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - stopped event fires after stop', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	let stoppedFired = false;
	nestedA.addEventListener('stopped', () => { stoppedFired = true; });

	await Promise.all([nestedA.stop(), nestedB.stop()]);

	assertEquals(stoppedFired, true);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - stop({ disconnected: true }) redirects to graceful stop', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	// stop({ disconnected: true }) should be treated as graceful stop
	await Promise.all([
		nestedA.stop({ disconnected: true }),
		nestedB.stop({ disconnected: true }),
	]);

	// Should end in STATE_STOPPED (graceful), not STATE_DISCONNECTED
	assertEquals(nestedA.state, Transport.STATE_STOPPED);
	assertEquals(nestedB.state, Transport.STATE_STOPPED);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Channel Tests ────────────────────────────────────────────────────────────

Deno.test('NestedTransport - requestChannel creates channel on both sides', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('test');
	const channelB = await channelBPromise;

	assertExists(channelA);
	assertExists(channelB);
	assertEquals(channelA.name, 'test');
	assertEquals(channelB.name, 'test');

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - requestChannel rejected by remote', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	nestedB.addEventListener('newChannel', (event) => {
		event.reject();
	});

	await assertRejects(
		() => nestedA.requestChannel('test'),
		Error,
		'rejected'
	);

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Data Exchange Tests ──────────────────────────────────────────────────────

Deno.test('NestedTransport - write and read a message', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('data-test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('data-test');
	const channelB = await channelBPromise;

	// Write from A
	await channelA.write(0, 'Hello, PTOC!');

	// Read on B
	const message = await channelB.read({ decode: true });
	assertExists(message);
	assertEquals(message.text, 'Hello, PTOC!');
	message.done();

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - write and read binary data', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('binary-test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('binary-test');
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

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - bidirectional data exchange', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('bidi-test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('bidi-test');
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

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

Deno.test('NestedTransport - multiple messages in sequence', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('multi-test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('multi-test');
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

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Channel Close Tests ──────────────────────────────────────────────────────

Deno.test('NestedTransport - channel close completes gracefully', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	const channelBPromise = new Promise((resolve) => {
		nestedB.addEventListener('newChannel', (event) => {
			event.accept();
			setTimeout(() => resolve(nestedB.getChannel('close-test')), 0);
		});
	});

	const channelA = await nestedA.requestChannel('close-test');
	const channelB = await channelBPromise;

	// Close both sides
	await Promise.all([channelA.close(), channelB.close()]);

	assertEquals(channelA.state, 'closed');
	assertEquals(channelB.state, 'closed');

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Parent Channel Lifecycle Tests ──────────────────────────────────────────

Deno.test('NestedTransport - parent channel close triggers PTOC stop', async () => {
	const bufferPool = new BufferPool();
	const [parentA, parentB] = await makeByteTransportPair();
	const [chanA, chanB] = await makeConnectedChannel(parentA, parentB, 'ptoc-channel');

	const nestedA = new NestedTransport({ bufferPool, channel: chanA, messageType: 0 });
	const nestedB = new NestedTransport({ bufferPool, channel: chanB, messageType: 0 });
	await Promise.all([nestedA.start(), nestedB.start()]);

	assertEquals(nestedA.state, Transport.STATE_ACTIVE);
	assertEquals(nestedB.state, Transport.STATE_ACTIVE);

	// Set up promises to wait for PTOC transports to stop
	const nestedAStopped = new Promise((resolve) => nestedA.addEventListener('stopped', resolve));
	const nestedBStopped = new Promise((resolve) => nestedB.addEventListener('stopped', resolve));

	// Close the parent channels — should trigger PTOC stop
	await Promise.all([chanA.close(), chanB.close()]);

	// Wait for PTOC transports to stop
	await Promise.all([nestedAStopped, nestedBStopped]);

	// PTOC transports should have stopped (gracefully or disconnected)
	const stateA = nestedA.state;
	const stateB = nestedB.state;
	assert(
		stateA === Transport.STATE_STOPPED || stateA === Transport.STATE_DISCONNECTED,
		`Expected nestedA stopped or disconnected, got ${nestedA.stateString}`
	);
	assert(
		stateB === Transport.STATE_STOPPED || stateB === Transport.STATE_DISCONNECTED,
		`Expected nestedB stopped or disconnected, got ${nestedB.stateString}`
	);

	await Promise.all([parentA.stop(), parentB.stop()]);
});

// ─── Role Assignment Tests ────────────────────────────────────────────────────

Deno.test('NestedTransport - transports get different roles', async () => {
	const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair();

	// One should be ROLE_EVEN, the other ROLE_ODD
	const roles = new Set([nestedA.role, nestedB.role]);
	assert(roles.has(Transport.ROLE_EVEN), 'One transport should be ROLE_EVEN');
	assert(roles.has(Transport.ROLE_ODD), 'One transport should be ROLE_ODD');
	assert(nestedA.role !== nestedB.role, 'Transports should have different roles');

	await Promise.all([nestedA.stop(), nestedB.stop()]);
	await Promise.all([parentA.stop(), parentB.stop()]);
});
