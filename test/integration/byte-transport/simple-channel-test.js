/*
 * ByteTransport Simple Channel Test
 *
 * Test channel request and data exchange.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { makeByteTransportPair, makeConnectedChannel } from '../helpers.js';
import { Channel } from '../../../src/channel.esm.js';

Deno.test('ByteTransport - can request and accept channel', async () => {
	const [transportA, transportB] = await makeByteTransportPair();

	const [channelA, channelB] = await makeConnectedChannel(transportA, transportB);

	assertExists(channelA);
	assertExists(channelB);
	assertEquals(channelA.state, Channel.STATE_OPEN);
	assertEquals(channelB.state, Channel.STATE_OPEN);

	await Promise.all([transportA.stop(), transportB.stop()]);
});

Deno.test('ByteTransport - can exchange data', async () => {
	const [transportA, transportB] = await makeByteTransportPair();
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
