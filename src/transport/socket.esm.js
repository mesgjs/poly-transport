/*
 * Deno Socket Transport Class
 *
 * Byte-stream transport over a Deno network or Unix domain socket connection.
 * Accepts any already-open Deno connection that exposes .readable and .writable
 * (e.g. Deno.TcpConn from Deno.connect() / Deno.Listener.accept(), or
 * Deno.UnixConn from Deno.connect({ transport: 'unix', ... })).
 *
 * Usage:
 *   // TCP client
 *   const conn = await Deno.connect({ hostname: 'localhost', port: 8080 });
 *   const transport = new SocketTransport({ conn });
 *   await transport.start();
 *
 *   // TCP server
 *   const listener = Deno.listen({ port: 8080 });
 *   const conn = await listener.accept();
 *   const transport = new SocketTransport({ conn });
 *   await transport.start();
 *
 *   // Unix domain socket client
 *   const conn = await Deno.connect({ transport: 'unix', path: '/tmp/my.sock' });
 *   const transport = new SocketTransport({ conn });
 *   await transport.start();
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PipeTransport } from './pipe.esm.js';

export class SocketTransport extends PipeTransport {
	#conn; // Deno.TcpConn | Deno.UnixConn (any conn with .readable/.writable)

	/**
	 * @param {object} options
	 * @param {Deno.TcpConn|Deno.UnixConn} options.conn - Open Deno socket connection
	 */
	constructor (options = {}) {
		const conn = options.conn;
		if (!conn) throw new TypeError('SocketTransport: options.conn is required');
		// Any Deno conn exposes .readable and .writable directly
		super({ ...options, readable: conn.readable, writable: conn.writable });
		this.#conn = conn;
	}
}
