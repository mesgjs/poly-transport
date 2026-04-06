/*
 * Integration Test Helpers
 *
 * Shared infrastructure for integration tests across PostMessageTransport and ByteTransport.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PostMessageTransport } from '../../src/transport/post-message.esm.js';
import { ByteTransport } from '../../src/transport/byte.esm.js';
import { Transport } from '../../src/transport/base.esm.js';
import { BufferPool } from '../../src/buffer-pool.esm.js';
import { Channel } from '../../src/channel.esm.js';
import { VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';

// ─── PostMessageTransport Helpers ─────────────────────────────────────────────

/**
 * A pair of gateways that are connected to each other.
 * Messages sent via postMessage on one are delivered as 'message' events on the other.
 */
export class PairedGateway {
	listeners = new Map();
	peer = null;
	sentMessages = []; // Capture outgoing messages for assertions

	setPeer (peer) {
		this.peer = peer;
	}

	addEventListener (type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(handler);
	}

	removeEventListener (type, handler) {
		const handlers = this.listeners.get(type);
		if (handlers) {
			const idx = handlers.indexOf(handler);
			if (idx >= 0) handlers.splice(idx, 1);
		}
	}

	postMessage (data, _transfer) {
		// Capture message for assertions
		this.sentMessages.push(data);

		// Deliver to peer's message listeners
		queueMicrotask(() => {
			if (this.peer) {
				const handlers = this.peer.listeners.get('message') || [];
				const event = { data };
				for (const handler of handlers) handler(event);
			}
		});
	}

	/**
	 * Inject a message as if received from peer (for testing)
	 */
	simulateMessage (data) {
		const handlers = this.listeners.get('message') || [];
		const event = { data };
		for (const handler of handlers) handler(event);
	}
}

/**
 * Create a pair of connected gateways
 */
export function makePairedGateways () {
	const a = new PairedGateway();
	const b = new PairedGateway();
	a.setPeer(b);
	b.setPeer(a);
	return [a, b];
}

/**
 * Create two connected PostMessageTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeMessageTransportPair (optionsA = {}, optionsB = {}) {
	const [gatewayA, gatewayB] = makePairedGateways();
	const bufferPool = new BufferPool();

	const transportA = new PostMessageTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsA,
		gateway: gatewayA,
	});

	const transportB = new PostMessageTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsB,
		gateway: gatewayB,
	});

	// Start both transports simultaneously (they exchange handshakes)
	await Promise.all([transportA.start(), transportB.start()]);

	return [transportA, transportB];
}

// ─── ByteTransport Helpers ────────────────────────────────────────────────────

/**
 * Connected ByteTransport for integration testing.
 * Two instances can be paired to simulate bidirectional byte-stream communication.
 */
export class ConnectedByteTransport extends ByteTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		async writeBytes () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;
			const committed = outputBuffer.committed;
			if (committed === 0) return;

			// Get buffers and make TRUE COPIES (not just views)
			const buffers = outputBuffer.getBuffers(committed);
			const snapshots = buffers.map((buf) => {
				const copy = new Uint8Array(buf.length);
				copy.set(buf);
				return copy;
			});
			
			// Capture for assertions
			for (const snapshot of snapshots) {
				thys.writtenBytes.push(snapshot);
			}

			// Now release the ring buffer space
			outputBuffer.release(committed);
			_thys.afterWrite();

			// Deliver to peer asynchronously (simulates real async I/O)
			queueMicrotask(() => {
				if (thys.peer) {
					for (const snapshot of snapshots) {
						thys.peer.#_.receiveBytes(snapshot);
					}
				}
			});
		}
	}, super.__protected));

	// All public for easy test inspection and setup
	peer = null;
	writtenBytes = []; // Capture outgoing bytes for assertions
	#_;

	constructor (options = {}) {
		const bufferPool = options.bufferPool || new BufferPool();
		super({ ...options, bufferPool });
		this._get_();
	}

	setPeer (peer) {
		this.peer = peer;
	}

	clearWrittenBytes () {
		this.writtenBytes = [];
	}

	/**
	 * Simulate receiving bytes from remote (for testing)
	 */
	simulateReceive (data) {
		const _thys = this.#_;
		if (typeof data === 'string') {
			// Encode string to bytes
			const encoder = new TextEncoder();
			const bytes = encoder.encode(data);
			_thys.receiveBytes(bytes);
		} else if (data instanceof Uint8Array) {
			_thys.receiveBytes(data);
		} else if (Array.isArray(data)) {
			_thys.receiveBytes(new Uint8Array(data));
		}
	}

	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}
}

/**
 * Create two connected ConnectedByteTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeByteTransportPair (optionsA = {}, optionsB = {}) {
	const bufferPool = new BufferPool();

	const transportA = new ConnectedByteTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsA,
	});

	const transportB = new ConnectedByteTransport({
		bufferPool,
		maxChunkBytes: 16 * 1024,
		lowBufferBytes: 4 * 1024,
		...optionsB,
	});

	// Connect the pair
	transportA.setPeer(transportB);
	transportB.setPeer(transportA);

	// Start both transports simultaneously (they exchange handshakes)
	await Promise.all([transportA.start(), transportB.start()]);

	return [transportA, transportB];
}

// ─── Shared Channel Helpers ───────────────────────────────────────────────────

/**
 * Request a channel from A and accept it on B.
 * Returns [channelA, channelB].
 */
export async function makeConnectedChannel (transportA, transportB, name = 'test-channel') {
	// Set up B to accept the channel request
	const channelBPromise = new Promise((resolve) => {
		transportB.addEventListener('newChannel', (event) => {
			event.accept();
			// Get the channel after it's created
			setTimeout(() => resolve(transportB.getChannel(name)), 0);
		});
	});

	// Request channel from A
	const channelA = await transportA.requestChannel(name);
	const channelB = await channelBPromise;

	return [channelA, channelB];
}
