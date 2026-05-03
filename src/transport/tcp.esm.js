/*
 * Deno TCP Socket Transport Class
 *
 * Byte-stream transport over a Deno TCP connection (Deno.TcpConn).
 * Accepts an already-open connection from either Deno.connect() or
 * Deno.Listener.accept().
 *
 * Usage:
 *   // Client-side
 *   const conn = await Deno.connect({ hostname: 'localhost', port: 8080 });
 *   const transport = new TcpTransport({ conn });
 *   await transport.start();
 *
 *   // Server-side
 *   const listener = Deno.listen({ port: 8080 });
 *   const conn = await listener.accept();
 *   const transport = new TcpTransport({ conn });
 *   await transport.start();
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PipeTransport } from './pipe.esm.js';

export class TcpTransport extends PipeTransport {
	#conn; // Deno.TcpConn

	/**
	 * @param {object} options
	 * @param {Deno.TcpConn} options.conn - Open Deno TCP connection
	 */
	constructor (options = {}) {
		const conn = options.conn;
		if (!conn) throw new TypeError('TcpTransport: options.conn is required');
		// Deno.TcpConn exposes .readable and .writable directly
		super({ ...options, readable: conn.readable, writable: conn.writable });
		this.#conn = conn;
	}
}
