/*
 * Unix Domain Socket Transport Test Helpers
 */

import { SocketTransport } from '../src/transport/socket.esm.js';
import { BufferPool } from '../src/buffer-pool.esm.js';
import { PromiseTracer } from '../src/promise-tracer.esm.js';

/**
 * Create a pair of connected Deno Unix domain socket connections.
 * Returns { serverConn, clientConn, path } — the listener is closed automatically.
 * The socket file is created in a unique temp directory.
 */
export async function makeLoopbackUnixPair () {
	const dir = await Deno.makeTempDir();
	const path = `${dir}/poly-transport-test.sock`;
	const listener = Deno.listen({ transport: 'unix', path });

	const [serverConn, clientConn] = await Promise.all([
		listener.accept(),
		Deno.connect({ transport: 'unix', path }),
	]);

	listener.close();

	return { serverConn, clientConn, path };
}

/**
 * Create a pair of connected SocketTransport instances over Unix domain sockets and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeUnixSocketTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();
	const { serverConn, clientConn } = await makeLoopbackUnixPair();

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
