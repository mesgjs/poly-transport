/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { VirtualRWBuffer } from './virtual-buffer.esm.js';

/**
 * OutputRingBuffer - Circular buffer for streaming output
 *
 * Lifecycle:
 * - Content assembly
 * 1. reserve(length) - Reserve space for writing (returns VirtualRWBuffer or null)
 * 2. commit() - Mark data as ready to send
 * - Content transmission
 * 3. await sendable() - Commited bytes are available to send
 * 4. getBuffers(committed) - Get actual Uint8Array buffers for writing (may be 1 or 2 if wrapped)
 * 5. release(written) - Zero and release sent bytes
 */
export class OutputRingBuffer {
	#buffer;      // Ring buffer Uint8Array
	#size;
	#writeHead;   // Where adding to the ring
	#readHead;    // Where sending from the ring
	#committed;   // Commited, ready-to-send bytes
	#reserved;    // Reserved bytes
	#reservation; // VirtualRWBuffer for reserved bytes
	#stats;
	#waiter;      // Waiter waiting to send

	/**
	 * Create a new OutputRingBuffer
	 * @param {number} size - Total ring buffer size in bytes (default 256KB)
	 * @param {Object} options - Optional configuration
	 */
	constructor (size = 256 * 1024, options = {}) {
		if (size < 1024) {
			throw new RangeError('Ring buffer size must be at least 1024 bytes');
		}

		this.#buffer = new Uint8Array(size);
		this.#size = size;
		this.#writeHead = 0;
		this.#readHead = 0;
		this.#committed = 0;
		this.#reserved = 0;
		this.#reservation = null;
		this.#stats = {
			bytesCommitted: 0,
			bytesGotten: 0,
			bytesReleased: 0,
			bytesReserved: 0,
			commits: 0,
			getBuffers: 0,
			releases: 0,
			reservations: 0,
			wraps: 0,
		};
		this.#waiter = null;
	}

	/**
	 * Get number of bytes of available free space
	 * Callers should not be checking availability mid-reservation.
	 * More precisely, this is the number of uncommitted bytes.
	 */
	get available () {
		return this.#reserved ? 0 : this.#size - this.#committed;
	}

	/**
	 * Commit the reservation, making it available to send
	 */
	commit () {
		const reservation = this.#reservation;

		// Verify this is the pending reservation
		if (!reservation) {
			throw new Error('Reservation not active');
		}

		// The reservation can be shortened, but never lengthened
		const length = Math.min(reservation.length, this.#reserved);
		
		// Clear reservation
		this.#reserved = 0;
		this.#reservation = null;

		if (typeof reservation.clear === 'function') {
			// Clear reservation virtual buffer to prevent further access
			reservation.clear();
		}

		if (length < 1) return; // Effectively cancelled

		// Advance writeHead, move from reserved to committed
		this.#writeHead = (this.#writeHead + length) % this.#size;
		this.#committed += length;

		++this.#stats.commits;
		this.#stats.bytesCommitted += length;

		// If there's committed content and a monitor waiting on bytes to send, wake it up
		if (this.#committed > 0 && this.#waiter) {
			const waiter = this.#waiter;
			this.#waiter = null;
			waiter.resolve(this.#committed);
		}
	}

	/**
	 * Get number of bytes committed and ready to send
	 */
	get committed () {
		return this.#committed;
	}

	/**
	 * Get actual buffer(s) for writing committed data
	 * Returns (0,) 1, or 2 Uint8Array views depending on whether data wraps around
	 * @param {number} length - Number of bytes to get buffers for
	 * @returns {Uint8Array[]} - Array of Uint8Array views
	 */
	getBuffers (length = this.#committed) {
		if (!Number.isInteger(length) || length < 1) {
			return [];
		}

		const committed = this.#committed;
		if (length > committed) {
			throw new RangeError(`Cannot get buffers for ${length} bytes - only ${committed} committed`);
		}

		// Check if data splits around wrap-around
		const spaceToEnd = this.#size - this.#readHead;
		const buffers = [];

		if (spaceToEnd >= length) {
			// Data fits before end of buffer
			buffers.push(new Uint8Array(this.#buffer.buffer, this.#readHead, length));
		} else {
			// Data splits around wrap-around
			const firstPart = spaceToEnd;
			const secondPart = length - firstPart;
			buffers.push(new Uint8Array(this.#buffer.buffer, this.#readHead, firstPart));
			buffers.push(new Uint8Array(this.#buffer.buffer, 0, secondPart));
		}

		++this.#stats.getBuffers;
		this.#stats.bytesGotten += length;

		return buffers;
	}

	/**
	 * Get ring buffer statistics
	 * @returns {Object} - Statistics object
	 */
	getStats () {
		return {
			...this.#stats,
			available: this.available,
			committed: this.#committed,
			readHead: this.#readHead,
			reserved: this.#reserved,
			size: this.#size,
			writeHead: this.#writeHead,
		};
	}

	/**
	 * Release committed bytes at the read head after sending
	 * (zeroing the space for security)
	 * @param {number} length - Number of bytes to release
	 */
	release (length) {
		if (length < 1) {
			throw new RangeError('Release length must be at least 1 byte');
		}

		const committed = this.committed;
		if (length > committed) {
			throw new RangeError(`Cannot release ${length} bytes - only ${committed} committed`);
		}

		// Zero the consumed space (security: prevent data leakage)
		const spaceToEnd = this.#size - this.#readHead;

		if (spaceToEnd >= length) {
			// Consumed region fits before end of buffer
			this.#buffer.fill(0, this.#readHead, this.#readHead + length);
		} else {
			// Consumed region splits around wrap-around
			const firstPart = spaceToEnd;
			const secondPart = length - firstPart;
			this.#buffer.fill(0, this.#readHead, this.#size);
			this.#buffer.fill(0, 0, secondPart);
		}

		// Advance read head and reduce committed bytes
		this.#readHead = (this.#readHead + length) % this.#size;
		this.#committed -= length;

		++this.#stats.releases;
		this.#stats.bytesReleased += length;
	}

	/**
	 * Reserve space for writing
	 * Note: shrinking the returned VirtualRWBuffer shrinks the number of bytes
	 *  committed; committing a zero-length buffer cancels the reservation
	 * @param {number} length - Number of bytes to reserve
	 * @returns {VirtualRWBuffer|null} - Reservation that can be written to, or null if insufficient space
	 */
	reserve (length) {
		if (length < 1) {
			throw new RangeError('Reservation length must be at least 1 byte');
		}

		if (length > this.#size) {
			throw new RangeError(`Reservation length ${length} exceeds ring buffer capacity ${this.#size}`);
		}

		// Only allow one pending reservation at a time
		if (this.#reservation !== null) {
			throw new Error('Reservation already pending');
		}

		// Return null if insufficient space (transport will wait and retry)
		if (this.available < length) {
			return null;
		}

		// Check if we need to wrap around
		const writeHead = this.#writeHead;
		const spaceToEnd = this.#size - writeHead;
		const buffer = this.#buffer;
		let segments;

		if (spaceToEnd >= length) {
			// Reservation fits before end of buffer
			segments = [
				 buffer.subarray(writeHead, writeHead + length)
			];
		} else {
			// Reservation splits around wrap-around
			const firstLength = spaceToEnd;
			const secondLength = length - firstLength;
			segments = [
				buffer.subarray(writeHead, writeHead + firstLength),
				buffer.subarray(0, secondLength)
			];
			++this.#stats.wraps;
		}

		// Create VirtualRWBuffer for the reservation
		const reservation = this.#reservation = new VirtualRWBuffer(segments);

		// Track reservation metadata
		this.#reserved = length;
		++this.#stats.reservations;
		this.#stats.bytesReserved += length;

		return reservation;
	}

	/**
	 * Wait until there are committed bytes to send
	 */
	async sendable () {
		if (this.#committed > 0) return;
		if (!this.#waiter) {
			const waiter = this.#waiter = {};
			waiter.promise = new Promise((...r) => [waiter.resolve, waiter.reject] = r);
		}
		return this.#waiter.promise;
	}

	/**
	 * Get total ring buffer size
	 */
	get size () {
		return this.#size;
	}

	// Basic cleanup on shutdown (e.g. for testing)
	stop () {
		if (this.#waiter) {
			this.#waiter.reject(new Error('Stopping'));
		}
	}
}
