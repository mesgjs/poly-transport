/*
 * WebSocket Transport Class
 *
 * Byte-stream transport over a WebSocket connection.
 *
 * Usage:
 *   // Client-side (browser or Deno)
 *   const ws = new WebSocket('ws://localhost:8080');
 *   const transport = new WebSocketTransport({ ws });
 *
 *   // Server-side (Deno)
 *   const handler = (req) => {
 *     const { socket, response } = Deno.upgradeWebSocket(req);
 *     const transport = new WebSocketTransport({ ws: socket });
 *     transport.start();
 *     return response;
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
			const committed = outputBuffer.committed;
			if (committed === 0) return;

			const buffers = outputBuffer.getBuffers(committed);

			try {
				const ws = thys.#ws;
				if (!ws || ws.readyState !== WebSocket.OPEN) return;
				for (const buf of buffers) {
					ws.send(buf);
				}
			} catch (err) {
				// Write failed — connection lost
				thys.logger.error('WebSocketTransport: write error', err);
				_thys.onDisconnect();
				return;
			}

			outputBuffer.release(committed);
			_thys.afterWrite();
		},
	}, super.__protected));

	#_; // WebSocketTransport-level view of shared protected state
	#ws; // WebSocket instance

	/**
	 * @param {object} options
	 * @param {WebSocket} options.ws - WebSocket instance (must be open or opening)
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		const { ws } = options;
		if (!ws) throw new TypeError('WebSocketTransport: options.ws is required');
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
				this.logger.warn('WebSocketTransport: received non-binary message, ignoring');
			}
		};

		ws.onclose = () => {
			const state = _thys.state;
			if (state !== Transport.STATE_STOPPED && state !== Transport.STATE_REMOTE_STOPPING) {
				_thys.onDisconnect();
			}
		};

		ws.onerror = (event) => {
			this.logger.error('WebSocketTransport: WebSocket error', event);
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

	/**
	 * Subscribe to protected state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
