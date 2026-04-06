/*
 * ByteTransport Handshake Test
 *
 * Simple test to verify ByteTransport handshake works correctly.
 */

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { makeByteTransportPair } from '../helpers.js';
import { Transport } from '../../../src/transport/base.esm.js';

Deno.test('ByteTransport - handshake completes successfully', async () => {
	const [transportA, transportB] = await makeByteTransportPair();

	assertEquals(transportA.state, Transport.STATE_ACTIVE);
	assertEquals(transportB.state, Transport.STATE_ACTIVE);

	await Promise.all([transportA.stop(), transportB.stop()]);
});
