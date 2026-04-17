/*
 * Nested (PTOC) Transport Test Helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NestedTransport } from '../src/transport/nested.esm.js';
import { BufferPool } from '../src/buffer-pool.esm.js';
import { makeByteTransportPair, makeConnectedChannel } from './integration/helpers.js';
import { PromiseTracer } from '../src/promise-tracer.esm.js';

/**
 * Create a pair of connected NestedTransport instances over an in-memory parent transport.
 *
 * Architecture:
 *   [parentTransportA] ←→ [parentTransportB]
 *         |                      |
 *     channelA              channelB
 *         |                      |
 *   [nestedTransportA] ←→ [nestedTransportB]
 *
 * Uses numeric message type 0 for PTOC traffic (no registration needed).
 *
 * @param {object} optionsA - Options for nestedTransportA
 * @param {object} optionsB - Options for nestedTransportB
 * @returns {Promise<{ nested: [NestedTransport, NestedTransport], parents: [Transport, Transport] }>}
 *   Both nested transports in STATE_ACTIVE; parent transports must be stopped after nested transports.
 */
export async function makeNestedTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();

	// Create parent transport pair (byte-stream)
	const [parentA, parentB] = await makeByteTransportPair();

	// Create a channel on the parent transport dedicated to PTOC traffic
	const [chanA, chanB] = await makeConnectedChannel(parentA, parentB, 'ptoc-channel');

	// Use numeric message type 0 for PTOC traffic (no registration needed)
	const messageType = 0;

	// Create separate promise tracers for each nested transport (5 second threshold, with rejection logging)
	const promiseTracerA = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const promiseTracerB = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	// Create nested transports
	const nestedA = new NestedTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerA,
		...optionsA,
		channel: chanA,
		messageType,
	});

	const nestedB = new NestedTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerB,
		...optionsB,
		channel: chanB,
		messageType,
	});

	// Start both nested transports simultaneously (they exchange handshakes)
	await Promise.all([nestedA.start(), nestedB.start()]);

	return { nested: [nestedA, nestedB], parents: [parentA, parentB] };
}

/**
 * Create a factory function suitable for use with the shared integration test suites.
 *
 * The returned factory creates a nested transport pair and returns
 * [nestedA, nestedB, cleanup] where cleanup() stops the parent transports.
 * The shared suites call `await cleanup?.()` at the end of each test to ensure
 * parent resources are cleaned up.
 *
 * @returns {function(): Promise<[NestedTransport, NestedTransport, function]>}
 */
export function makeNestedTransportPairFactory () {
	return async function (optionsA = {}, optionsB = {}) {
		const { nested: [nestedA, nestedB], parents: [parentA, parentB] } = await makeNestedTransportPair(optionsA, optionsB);

		// Cleanup function: stops the parent transports
		const cleanup = async () => {
			await Promise.all([parentA.stop(), parentB.stop()]);
		};

		return [nestedA, nestedB, cleanup];
	};
}
