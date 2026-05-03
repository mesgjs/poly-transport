/*
 * Socket Transport Test Helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { SocketTransport } from '../src/transport/socket.esm.js';
import { BufferPool } from '../src/buffer-pool.esm.js';
import { PromiseTracer } from '../src/promise-tracer.esm.js';

/**
 * Create a pair of connected Deno TCP connections using a loopback listener.
 * Returns { serverConn, clientConn } — the listener is closed automatically.
 */
export async function makeLoopbackSocketPair () {
	const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
	const port = listener.addr.port;

	const [serverConn, clientConn] = await Promise.all([
		listener.accept(),
		Deno.connect({ hostname: '127.0.0.1', port }),
	]);

	listener.close();

	return { serverConn, clientConn };
}

/**
 * Create a pair of connected SocketTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeSocketTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();
	const { serverConn, clientConn } = await makeLoopbackSocketPair();

	// Create separate promise tracers for each transport (5 second threshold, with rejection logging)
	const promiseTracerA = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const promiseTracerB = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const transportA = new SocketTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerA,
		...optionsA,
		conn: serverConn,
	});

	const transportB = new SocketTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerB,
		...optionsB,
		conn: clientConn,
	});

	await Promise.all([transportA.start(), transportB.start()]);

	return [transportA, transportB];
}
