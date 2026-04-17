/*
 * Pipe Transport Test Helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PipeTransport } from '../src/transport/pipe.esm.js';
import { BufferPool } from '../src/buffer-pool.esm.js';
import { PromiseTracer } from '../src/promise-tracer.esm.js';

/**
 * Create a pair of in-memory byte streams that are connected to each other.
 * Returns { a, b } where each side has { readable, writable }, plus the
 * underlying controllers for test injection.
 */
export function makeMemoryPipePair () {
	// A→B pipe
	let aToB_controller;
	const aToB_readable = new ReadableStream({
		start (ctrl) { aToB_controller = ctrl; }
	});
	const aToB_writable = new WritableStream({
		write (chunk) { aToB_controller.enqueue(chunk.slice()); },
		close () { aToB_controller.close(); },
		abort (reason) { aToB_controller.error(reason); }
	});

	// B→A pipe
	let bToA_controller;
	const bToA_readable = new ReadableStream({
		start (ctrl) { bToA_controller = ctrl; }
	});
	const bToA_writable = new WritableStream({
		write (chunk) { bToA_controller.enqueue(chunk.slice()); },
		close () { bToA_controller.close(); },
		abort (reason) { bToA_controller.error(reason); }
	});

	return {
		// Side A: reads from B, writes to B
		a: { readable: bToA_readable, writable: aToB_writable },
		// Side B: reads from A, writes to A
		b: { readable: aToB_readable, writable: bToA_writable },
		// Controllers for test injection
		aToB_controller,
		bToA_controller,
	};
}

/**
 * Create a pair of connected PipeTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makePipeTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();
	const pipes = makeMemoryPipePair();

	// Create separate promise tracers for each transport (5 second threshold, with rejection logging)
	const promiseTracerA = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const promiseTracerB = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const transportA = new PipeTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerA,
		...optionsA,
		readable: pipes.a.readable,
		writable: pipes.a.writable,
	});

	const transportB = new PipeTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerB,
		...optionsB,
		readable: pipes.b.readable,
		writable: pipes.b.writable,
	});

	await Promise.all([transportA.start(), transportB.start()]);

	return [transportA, transportB];
}
