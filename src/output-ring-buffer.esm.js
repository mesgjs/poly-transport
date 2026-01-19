/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * OutputRingBuffer - Circular buffer for streaming output with zero-copy writing
 *
 * Simplified architecture (Update 2026-01-07-B):
 * - Output-only ring buffer (no input ring, no pinning, no migration)
 * - Reserve → commit → getBuffers → consume lifecycle
 * - Zero-after-write security (prevents data leakage)
 * - Integration with VirtualRWBuffer for zero-copy writing
 */

import { VirtualRWBuffer } from './virtual-buffer.esm.js';

/**
 * OutputRingBuffer - Circular buffer for streaming output
 *
 * Lifecycle:
 * 1. reserve(length) - Reserve space for writing (returns VirtualRWBuffer or null)
 * 2. shrink(newLength) - Shrink the reservation if some space was unused
 * 3. commit() - Mark data as ready to send
 * 4. getBuffers(length) - Get actual Uint8Array buffers for writing (may be 1 or 2 if wrapped)
 * 5. consume(length) - Consume sent data and zero the space
 *
 * Security: Zero-after-write prevents leaking bytes from previous iterations
 */
export class OutputRingBuffer {
	#buffer; // Ring buffer Uint8Array
	#size;
	#writeHead; // Where adding to the ring
	#readHead; // Where sending from the ring
	#count; // Commited, ready-to-send bytes
	#reserved; // Reserved bytes
	#reservation; // VirtualRWBuffer for reserved bytes
	#stats;

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
		this.#count = 0;
		this.#reserved = 0;
		this.#reservation = null;
		this.#stats = {
			reservations: 0,
			commits: 0,
			bufferGets: 0,
			consumes: 0,
			wraps: 0,
			bytesReserved: 0,
			bytesCommitted: 0,
			bytesProvided: 0,
			bytesConsumed: 0
		};
	}

	/**
	 * Get bytes available to read (committed but not yet consumed)
	 */
	get available () {
		return this.#count;
	}

	/**
	 * Commit the reservation, making it available to send
	 * @param {VirtualRWBuffer} reservation - The reservation to commit
	 */
	commit () {
		const reservation = this.#reservation;

		// Verify this is the pending reservation
		if (!reservation) {
			throw new Error('Reservation not active');
		}

		// Advance writeHead, move from reserved to committed
		const length = this.#reserved;
		this.#writeHead = (this.#writeHead + length) % this.#size;
		this.#reserved = 0;
		this.#count += length;

		// Clear reservation metadata and pending reservation
		if (typeof reservation.clear === 'function') {
			// Clear reservation buffer to prevent further use
			reservation.clear();
		}
		this.#reservation = null;

		++this.#stats.commits;
		this.#stats.bytesCommitted += length;
	}

	/**
	 * Consume data after it has been sent (zero the space for security)
	 * @param {number} length - Number of bytes to consume
	 */
	consume (length) {
		if (length < 1) {
			throw new RangeError('Consume length must be at least 1 byte');
		}

		if (length > this.available) {
			throw new RangeError(`Cannot consume ${length} bytes - only ${this.available} available`);
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

		// Advance readHead and decrease count
		this.#readHead = (this.#readHead + length) % this.#size;
		this.#count -= length;

		++this.#stats.consumes;
		this.#stats.bytesConsumed += length;
	}

	/**
	 * Get actual buffer(s) for writing committed data
	 * Returns 1 or 2 Uint8Array views depending on whether data wraps around
	 * @param {number} length - Number of bytes to get buffers for
	 * @returns {Uint8Array[]} - Array of 1 or 2 Uint8Array views
	 */
	getBuffers (length) {
		if (length < 1) {
			throw new RangeError('Buffer length must be at least 1 byte');
		}

		if (length > this.available) {
			throw new RangeError(`Cannot get buffers for ${length} bytes - only ${this.available} available`);
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

		++this.#stats.bufferGets;
		this.#stats.bytesProvided += length;

		return buffers;
	}

	/**
	 * Get ring buffer statistics
	 * @returns {Object} - Statistics object
	 */
	getStats () {
		return {
			...this.#stats,
			size: this.#size,
			available: this.available,
			space: this.space,
			writeHead: this.#writeHead,
			readHead: this.#readHead,
			count: this.#count,
			reserved: this.#reserved,
		};
	}

	/**
	 * Reserve space for writing
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
		if (this.space < length) {
			return null;
		}

		// Check if we need to wrap around
		const spaceToEnd = this.#size - this.#writeHead;
		let segments;

		if (spaceToEnd >= length) {
			// Reservation fits before end of buffer
			segments = [
				{ buffer: this.#buffer.buffer, offset: this.#writeHead, length }
			];
		} else {
			// Reservation splits around wrap-around
			const firstPart = spaceToEnd;
			const secondPart = length - firstPart;
			segments = [
				{ buffer: this.#buffer.buffer, offset: this.#writeHead, length: firstPart },
				{ buffer: this.#buffer.buffer, offset: 0, length: secondPart }
			];
			++this.#stats.wraps;
		}

		const onShrink = (_buffer, newLength) => {
			this.shrink(newLength);
		};

		// Create VirtualRWBuffer for the reservation
		const buffer = new VirtualRWBuffer(undefined, { onShrink });
		for (const seg of segments) {
			const view = new Uint8Array(seg.buffer, seg.offset, seg.length);
			buffer.append(view);
		}

		// Track reservation metadata
		this.#reservation = buffer;
		this.#reserved = length;
		++this.#stats.reservations;
		this.#stats.bytesReserved += length;

		return buffer;
	}

	/**
	 * Shrink the reservation (called via VirtualRWBuffer onShrink event)
	 * @param {number} newLength - The new length
	 */
	shrink (newLength) {
		const reservation = this.#reservation;
		if (newLength === 0) {
			// shrink(0) -> cancel reservation
			if (typeof reservation?.clear === 'function') {
				// Clear reservation buffer to prevent further use
				reservation.clear();
			}
			this.#reserved = 0;
			this.#reservation = null;
			return;
		}

		if (newLength < 0) {
			throw new RangeError('New length must be non-negative');
		}

		if (newLength > this.#reserved) {
			throw new RangeError('Cannot grow a reservation, only shrink');
		}

		this.#reserved = newLength;
	}

	/**
	 * Get total ring buffer size
	 */
	get size () {
		return this.#size;
	}

	/**
	 * Get bytes available to write (not yet reserved)
	 */
	get space () {
		return this.#size - this.#count - this.#reserved;
	}
}
