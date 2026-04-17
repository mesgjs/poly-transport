/*
 * WebSocket Transport Test Helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { WebSocketTransport } from '../src/transport/websocket.esm.js';
import { BufferPool } from '../src/buffer-pool.esm.js';
import { PromiseTracer } from '../src/promise-tracer.esm.js';

/**
 * Create a pair of in-memory mock WebSocket objects that are connected to each other.
 * Messages sent via ws.send() on one are delivered as 'message' events on the other.
 *
 * The mock WebSocket implements the minimal WebSocket interface needed by WebSocketTransport:
 *   - readyState (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3)
 *   - binaryType (settable)
 *   - send(data)
 *   - close()
 *   - onmessage, onclose, onerror (settable event handlers)
 *
 * Returns { a, b } where each is a mock WebSocket connected to the other.
 */
export function makeMemoryWebSocketPair () {
	const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

	class MockWebSocket {
		static CONNECTING = CONNECTING;
		static OPEN = OPEN;
		static CLOSING = CLOSING;
		static CLOSED = CLOSED;

		readyState = CONNECTING;
		binaryType = 'blob';
		peer = null;

		onmessage = null;
		onclose = null;
		onerror = null;

		/**
		 * Simulate the WebSocket opening (called after both sides are created and paired).
		 */
		_open () {
			this.readyState = OPEN;
		}

		/**
		 * Send binary data to the peer.
		 * Copies bytes before delivering (same as real WebSocket behavior and pipe test fix).
		 * @param {Uint8Array|ArrayBuffer} data
		 */
		send (data) {
			if (this.readyState !== OPEN) {
				throw new DOMException('WebSocket is not open', 'InvalidStateError');
			}
			if (!this.peer || this.peer.readyState !== OPEN) return;

			// Copy bytes before delivering (OutputRingBuffer views are zeroed after release)
			let copy;
			if (data instanceof Uint8Array) {
				copy = new ArrayBuffer(data.byteLength);
				new Uint8Array(copy).set(data);
			} else if (data instanceof ArrayBuffer) {
				copy = data.slice(0);
			} else {
				copy = data;
			}

			// Deliver to peer asynchronously (simulates real async I/O)
			queueMicrotask(() => {
				if (this.peer && this.peer.readyState === OPEN && this.peer.onmessage) {
					this.peer.onmessage({ data: copy });
				}
			});
		}

		/**
		 * Close the WebSocket connection.
		 */
		close () {
			if (this.readyState === CLOSED || this.readyState === CLOSING) return;
			this.readyState = CLOSING;

			queueMicrotask(() => {
				this.readyState = CLOSED;
				if (this.onclose) this.onclose({ code: 1000, reason: '', wasClean: true });

				// Notify peer of close
				if (this.peer && this.peer.readyState !== CLOSED && this.peer.readyState !== CLOSING) {
					this.peer.readyState = CLOSED;
					if (this.peer.onclose) {
						this.peer.onclose({ code: 1000, reason: '', wasClean: true });
					}
				}
			});
		}
	}

	const wsA = new MockWebSocket();
	const wsB = new MockWebSocket();
	wsA.peer = wsB;
	wsB.peer = wsA;

	// Both start as OPEN (already connected)
	wsA._open();
	wsB._open();

	return { a: wsA, b: wsB };
}

/**
 * Create a pair of connected WebSocketTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeWebSocketTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();
	const { a: wsA, b: wsB } = makeMemoryWebSocketPair();

	// Create separate promise tracers for each transport (5 second threshold, with rejection logging)
	const promiseTracerA = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const promiseTracerB = new PromiseTracer(5000, {
		log: console.warn.bind(console),
		logRejections: true
	});

	const transportA = new WebSocketTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerA,
		...optionsA,
		ws: wsA,
	});

	const transportB = new WebSocketTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		promiseTracer: promiseTracerB,
		...optionsB,
		ws: wsB,
	});

	await Promise.all([transportA.start(), transportB.start()]);

	return [transportA, transportB];
}
