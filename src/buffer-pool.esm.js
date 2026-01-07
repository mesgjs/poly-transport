/*
 * buffer-pool.esm.js - Buffer pool management for PolyTransport
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * Manages pools of reusable ArrayBuffers with size classes to minimize
 * allocation overhead and system calls. Supports worker environments with
 * buffer transfer capabilities.
 */

/**
 * BufferPool manages reusable ArrayBuffers organized by size classes.
 * 
 * Features:
 * - Size classes: 1KB, 4KB, 16KB, 64KB (configurable)
 * - Per-size-class low/high water mark management
 * - Worker support for buffer transfer via postMessage
 * - Buffers are zeroed when released (not when allocated) per requirements.md:850
 * 
 * @example
 * const pool = new BufferPool({
 *   sizeClasses: [1024, 4096, 16384, 65536],
 *   lowWaterMark: 2,
 *   highWaterMark: 10,
 *   waterMarks: {
 *     1024: { low: 5, high: 20 },  // Override for 1KB buffers
 *     65536: { low: 1, high: 5 }   // Override for 64KB buffers
 *   }
 * });
 * 
 * const buffer = pool.acquire(4096);
 * // ... use buffer ...
 * pool.release(buffer);
 */
export class BufferPool {
	#pools;           // Map<size, ArrayBuffer[]>
	#sizeClasses;     // number[] - sorted size classes
	#waterMarks;      // Map<size, {low, high}> - per-size-class water marks
	#isWorker;        // boolean - true if in worker context
	#requestCallback; // function - callback to request buffers from main thread
	#returnCallback;  // function - callback to return buffers to main thread
	#stats;           // Map<size, {acquired, released, allocated, transferred}>

	/**
	 * Create a new BufferPool.
	 * 
	 * @param {Object} options - Configuration options
	 * @param {number[]} [options.sizeClasses=[1024, 4096, 16384, 65536]] - Buffer size classes
	 * @param {number} [options.lowWaterMark=2] - Default low water mark
	 * @param {number} [options.highWaterMark=10] - Default high water mark
	 * @param {Object} [options.waterMarks={}] - Per-size-class overrides: { size: { low, high } }
	 * @param {boolean} [options.isWorker=false] - True if running in worker context
	 * @param {Function} [options.requestCallback] - Callback to request buffers from main thread
	 * @param {Function} [options.returnCallback] - Callback to return buffers to main thread
	 */
	constructor (options = {}) {
		// Default size classes: 1KB, 4KB, 16KB, 64KB
		this.#sizeClasses = options.sizeClasses || [1024, 4096, 16384, 65536];
		this.#sizeClasses.sort((a, b) => a - b); // Ensure sorted

		const defaultLow = options.lowWaterMark ?? 2;
		const defaultHigh = options.highWaterMark ?? 10;
		const overrides = options.waterMarks || {};

		this.#isWorker = options.isWorker ?? false;
		this.#requestCallback = options.requestCallback;
		this.#returnCallback = options.returnCallback;

		// Initialize pools, water marks, and stats for each size class
		this.#pools = new Map();
		this.#waterMarks = new Map();
		this.#stats = new Map();

		for (const size of this.#sizeClasses) {
			this.#pools.set(size, []);

			// Use override if provided, otherwise use defaults
			const override = overrides[size] || {};
			this.#waterMarks.set(size, {
				low: override.low ?? defaultLow,
				high: override.high ?? defaultHigh
			});

			// Initialize stats for this size class
			this.#stats.set(size, {
				acquired: 0,
				released: 0,
				allocated: 0,
				transferred: 0
			});
		}

		// Pre-allocate to low water mark
		for (const size of this.#sizeClasses) {
			this.#ensureLowWaterMark(size);
		}
	}

	/**
	 * Get the appropriate size class for a requested size.
	 * Returns the smallest size class that can accommodate the request.
	 * 
	 * @param {number} requestedSize - Requested buffer size in bytes
	 * @returns {number|null} Size class or null if too large
	 */
	#getSizeClass (requestedSize) {
		for (const size of this.#sizeClasses) {
			if (size >= requestedSize) {
				return size;
			}
		}
		return null; // Requested size exceeds largest size class
	}

	/**
	 * Ensure pool has at least lowWaterMark buffers.
	 * 
	 * @param {number} size - Size class
	 */
	#ensureLowWaterMark (size) {
		const pool = this.#pools.get(size);
		const marks = this.#waterMarks.get(size);
		const needed = marks.low - pool.length;

		if (needed > 0) {
			if (this.#isWorker && this.#requestCallback) {
				// Request buffers from main thread
				this.#requestCallback(size, needed);
			} else {
				// Allocate directly
				const stats = this.#stats.get(size);
				for (let i = 0; i < needed; i++) {
					pool.push(new ArrayBuffer(size));
					stats.allocated++;
				}
			}
		}
	}

	/**
	 * Release excess buffers above high water mark.
	 * 
	 * @param {number} size - Size class
	 */
	#releaseExcess (size) {
		const pool = this.#pools.get(size);
		const marks = this.#waterMarks.get(size);
		const excess = pool.length - marks.high;

		if (excess > 0) {
			const toRelease = pool.splice(marks.high, excess);

			if (this.#isWorker && this.#returnCallback) {
				// Return buffers to main thread
				this.#returnCallback(size, toRelease);
				this.#stats.get(size).transferred += toRelease.length;
			}
			// In main thread, buffers are simply dropped (GC'd)
		}
	}

	/**
	 * Zero a buffer's contents.
	 * 
	 * @param {ArrayBuffer} buffer - Buffer to zero
	 */
	#zeroBuffer (buffer) {
		const view = new Uint8Array(buffer);
		view.fill(0);
	}

	/**
	 * Acquire a buffer from the pool.
	 * 
	 * @param {number} requestedSize - Requested buffer size in bytes
	 * @returns {ArrayBuffer|null} Buffer or null if size exceeds largest class
	 */
	acquire (requestedSize) {
		const size = this.#getSizeClass(requestedSize);
		if (size === null) {
			return null; // Size too large
		}

		const pool = this.#pools.get(size);
		const stats = this.#stats.get(size);
		let buffer;

		if (pool.length > 0) {
			// Reuse from pool
			buffer = pool.pop();
		} else {
			// Allocate new buffer
			buffer = new ArrayBuffer(size);
			stats.allocated++;
		}

		stats.acquired++;

		// Ensure low water mark after acquisition
		this.#ensureLowWaterMark(size);

		return buffer;
	}

	/**
	 * Release a buffer back to the pool.
	 * Buffer is zeroed before being returned to pool (requirements.md:850).
	 * 
	 * @param {ArrayBuffer} buffer - Buffer to release
	 * @returns {boolean} True if released, false if not a recognized size class
	 */
	release (buffer) {
		const size = buffer.byteLength;
		const pool = this.#pools.get(size);

		if (!pool) {
			return false; // Not a recognized size class
		}

		// Zero buffer before returning to pool (requirements.md:850)
		this.#zeroBuffer(buffer);

		pool.push(buffer);
		this.#stats.get(size).released++;

		// Release excess if above high water mark
		this.#releaseExcess(size);

		return true;
	}

	/**
	 * Receive buffers from main thread (worker context only).
	 * 
	 * @param {number} size - Size class
	 * @param {ArrayBuffer[]} buffers - Buffers received
	 */
	receiveBuffers (size, buffers) {
		if (!this.#isWorker) {
			throw new Error('receiveBuffers can only be called in worker context');
		}

		const pool = this.#pools.get(size);
		if (!pool) {
			throw new Error(`Invalid size class: ${size}`);
		}

		pool.push(...buffers);
		this.#stats.get(size).transferred += buffers.length;
	}

	/**
	 * Get pool statistics.
	 * 
	 * @returns {Object} Statistics object with counts per size class
	 */
	getStats () {
		const stats = {
			sizeClasses: [...this.#sizeClasses],
			isWorker: this.#isWorker,
			pools: {}
		};

		for (const size of this.#sizeClasses) {
			const marks = this.#waterMarks.get(size);
			const sizeStats = this.#stats.get(size);
			stats.pools[size] = {
				lowWaterMark: marks.low,
				highWaterMark: marks.high,
				available: this.#pools.get(size).length,
				acquired: sizeStats.acquired,
				released: sizeStats.released,
				allocated: sizeStats.allocated,
				transferred: sizeStats.transferred
			};
		}

		return stats;
	}

	/**
	 * Get current pool sizes.
	 * 
	 * @returns {Object} Map of size class to available buffer count
	 */
	getPoolSizes () {
		const sizes = {};
		for (const size of this.#sizeClasses) {
			sizes[size] = this.#pools.get(size).length;
		}
		return sizes;
	}

	/**
	 * Get water marks for a size class.
	 * 
	 * @param {number} size - Size class
	 * @returns {Object|null} { low, high } or null if invalid size
	 */
	getWaterMarks (size) {
		const marks = this.#waterMarks.get(size);
		return marks ? { ...marks } : null;
	}

	/**
	 * Clear all pools (for testing/cleanup).
	 */
	clear () {
		for (const pool of this.#pools.values()) {
			pool.length = 0;
		}
	}

	/**
	 * Get size classes.
	 * 
	 * @returns {number[]} Array of size classes
	 */
	get sizeClasses () {
		return [...this.#sizeClasses];
	}

	/**
	 * Check if running in worker context.
	 * 
	 * @returns {boolean} True if worker
	 */
	get isWorker () {
		return this.#isWorker;
	}
}
