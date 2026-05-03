/*
 * WebSocket Transport Class
 *
 * Byte-stream transport over a WebSocket connection.
 *
 * Usage:
 *   // Client-side (browser or Deno)
 *   const socket = new WebSocket('ws://localhost:8080');
 *   const transport = new WebSocketTransport({ socket });
 *   await transport.start();
 *
 *   // Server-side (Deno)
 *   const handler = (req) => {
 *     const { socket, response } = Deno.upgradeWebSocket(req);
 *     const transport = new WebSocketTransport({ socket });
 *     return { response, transport };
 *     // await transport.start() will hang if the response has not been sent
 *   };
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ByteTransport } from './byte.esm.js';
import { Transport } from './base.esm.js';

export class WebSocketTransport extends ByteTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Start the byte reader.
		 * Calls super.startReader() (which starts the protocol parser / #byteReader),
		 * then attaches WebSocket message/close/error handlers.
		 */
		startReader () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			super.startReader(); // Starts ByteTransport's #byteReader (protocol parser)
			thys.#attachHandlers(); // Attach WebSocket event handlers
		},

		/**
		 * Transport-specific stop: drain output buffer, clear write timer, close WebSocket.
		 * Called by Transport base class #finalizeStop() and #onDisconnect().
		 */
		async stop () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Let ByteTransport drain the output buffer and clear the write timer
			await super.stop();

			// Close the WebSocket (signals the remote end)
			thys.#closeWebSocket();
		},

		/**
		 * Write committed bytes from the output ring buffer to the WebSocket.
		 * Called by scheduleWrite() when there is committed data to send.
		 */
		async writeBytes () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;

			// Loop to drain all committed data, including any newly committed
			// while we were sending in a previous iteration.
			while (outputBuffer.committed > 0) {
				const committed = outputBuffer.committed;
				const buffers = outputBuffer.getBuffers(committed);

				try {
					const ws = thys.#ws;
					if (!ws || ws.readyState !== WebSocket.OPEN) break;
					for (const buf of buffers) {
						ws.send(buf);
					}
				} catch (err) {
					// Write failed — connection lost
					thys.logger.error(`${thys.constructor.name}: write error`, err);
					_thys.onDisconnect();
					return;
				}

				outputBuffer.release(committed);
			}

			_thys.afterWrite();
		},
	}, super.__protected));

	#_; // WebSocketTransport-level view of shared protected state
	#openWait;
	#ws; // WebSocket instance

	/**
	 * @param {object} options
	 * @param {WebSocket} options.socket - WebSocket instance (must be open or opening)
	 * @param {WebSocket} options.ws - Alternative WebSocket option name
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		const ws = options.socket || options.ws;
		if (!ws) throw new TypeError('WebSocketTransport: options.socket is required');
		this.#ws = ws;
		// Receive binary messages as ArrayBuffer (not Blob)
		ws.binaryType = 'arraybuffer';
	}

	/**
	 * Attach WebSocket event handlers for message, close, and error events.
	 * Called from startReader() after the byte reader is started.
	 */
	#attachHandlers () {
		const _thys = this.#_;
		const ws = this.#ws;

		ws.onmessage = (event) => {
			const { data } = event;
			if (data instanceof ArrayBuffer) {
				_thys.receiveBytes(new Uint8Array(data));
			} else if (data instanceof Uint8Array) {
				_thys.receiveBytes(data);
			} else {
				// Unexpected non-binary message — ignore
				this.logger.warn(`${this.constructor.name}: received non-binary message, ignoring`);
			}
		};

		ws.onclose = () => {
			const state = _thys.state;
			if (state !== Transport.STATE_STOPPED && state !== Transport.STATE_REMOTE_STOPPING) {
				_thys.onDisconnect();
			}
		};

		ws.onerror = (event) => {
			this.logger.error(`${this.constructor.name}: WebSocket error`, event);
			_thys.onDisconnect();
		};
	}

	/**
	 * Close the WebSocket connection gracefully.
	 * Detaches handlers first to prevent spurious disconnect events.
	 */
	#closeWebSocket () {
		const ws = this.#ws;
		if (!ws) return;

		// Detach handlers to prevent spurious disconnect events during close
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;

		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			try {
				ws.close();
			} catch (_) { /* ignore close errors */ }
		}

		this.#ws = null;
	}

	/*
	 * Start the transport when the WebSocket connection is open
	 * IMPORTANT: Do not await transport.start() until the WS response has been sent!
	 */
	async start () {
		const ws = this.#ws;
		if (ws.readyState !== WebSocket.OPEN) {
			// Wait for the socket connection to be open
			if (!this.#openWait) {
				const open = this.#openWait = { promise: null, resolve: null };
				open.promise = new Promise((resolve) => open.resolve = resolve);
				ws.onopen = () => {
					const resolve = open.resolve;
					this.#openWait = null;
					ws.onopen = null;
					resolve();
				};
			}
			await this.#openWait.promise;
		}
		return super.start(); // Start the transport
	}

	/**
	 * Subscribe to protected state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
