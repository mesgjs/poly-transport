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
	#groups = new Map();// Map<size, Object>
	#sizeClasses;     // number[] - sorted size classes
	#isWorker;        // boolean - true if in worker context
	#requestCallback; // function - callback to request buffers from main thread
	#returnCallback;  // function - callback to return buffers to main thread
	#stopped = false;
	#manageSizes = new Set();  // Additional pool-level management required
	#timer = null;    // Scheduled pool-level management

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
		for (const size of this.#sizeClasses) {
			// Use override if provided, otherwise use defaults
			const override = overrides[size] || {};
			this.#groups.set(size, {
				cleanPool: [],
				dirtyPool: [],
				marks: { low: override.low ?? defaultLow, high: override.high ?? defaultHigh },
				stats: {
					acquired: 0,
					released: 0,
					allocated: 0,
					transferred: 0
				}
			});
		}

		// Pre-allocate to low water mark
		for (const size of this.#sizeClasses) {
			this.#ensureMinimum(size, true);
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
	 * @param {boolean} sync - True (do it now) or false (schedule for later)
	 */
	#ensureMinimum (size, sync = false) {
		if (!sync) {
			// Async pool management
			this.#manageSizes.add(size);
			this.#manageLevels();
			return;
		}

		// Check immediately
		const group = this.#groups.get(size);
		const { cleanPool, dirtyPool, marks, stats } = group;
		const needed = marks.low - cleanPool.length;

		if (needed > 0) {
			if (this.#isWorker && this.#requestCallback) {
				// Request buffers from main thread
				this.#requestCallback(size, needed);
			} else {
				for (let i = 0; i < needed; i++) {
					if (dirtyPool.length > 0) {
						// Clean a dirty buffer and reuse it
						const buffer = dirtyPool.pop();
						this.#zeroBuffer(buffer);
						cleanPool.push(buffer);
					} else {
						// Allocate directly
						cleanPool.push(new ArrayBuffer(size));
						++stats.allocated;
					}
				}
			}
		}
	}

	/**
	 * Stop pool management (e.g. during transport shutdown)
	 */
	stop () {
		this.#stopped = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
		}
	}

	/**
	 * Asynchronously manage pool levels
	 * @param {boolean} handler Timeout handler (true) or scheduling call (false)
	 */
	async #manageLevels (handler = false) {
		if (!handler) {
			// Schedule management in the next event loop if not yet running
			if (!this.#timer && !this.#stopped) {
				this.#timer = setTimeout(() => this.#manageLevels(true), 0);
			}
			return;
		}

		let runAgain = false;
		for (const size of this.#manageSizes) {
			if (runAgain) {
				// Yield to the event queue between sizes
				await new Promise((resolve) => setTimeout(resolve, 0));
			} else {
				runAgain = true;
			}
			this.#manageSizes.delete(size);

			// Make sure pool has the minimum
			this.#ensureMinimum(size, true);

			// Scrub dirty buffers to top off and then release excess
			this.#releaseExcess(size, true);

		}

		if (runAgain && !this.#stopped) {
			this.#timer = setTimeout(() => this.#manageLevels(true), 0);
		} else {
			this.#timer = null;
		}
	}

	/**
	 * Scrub dirty buffers to top off, then release excess buffers above high water mark.
	 *
	 * @param {number} size - Size class
	 * @param {boolean} sync - True (do it now) or false (schedule for later)
	 */
	#releaseExcess (size, sync = false) {
		if (!sync) {
			this.#manageSizes.add(size);
			this.#manageLevels();
			return;
		}

		const group = this.#groups.get(size);
		const { cleanPool, dirtyPool, marks, stats } = group;
		const release = (pool, excess, high = 0) => {
			const toRelease = pool.splice(high, excess);
			if (this.#isWorker && this.#returnCallback) {
				// Return (assumed dirty) buffers to main thread
				this.#returnCallback(size, toRelease);
				stats.transferred += toRelease.length;
			}
			// In the main thread, excess buffers are just dropped and GC'd
		};

		// Top-off the clean pool up to the high-water mark by scrubbing dirty buffers
		while (cleanPool.length < marks.high && dirtyPool.length > 0) {
			const buffer = dirtyPool.pop();
			this.#zeroBuffer(buffer);
			cleanPool.push(buffer);
		}

		// Everything over is excess to be released
		// (The main thread assumes we're sending dirty buffers, so send those first)
		if (dirtyPool.length > 0) release(dirtyPool, dirtyPool.length);
		const excess = cleanPool.length - marks.high;
		if (excess > 0) release(cleanPool, excess, marks.high);
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
	 * Acquire a (single) buffer from the pool.
	 *
	 * @param {number} requestedSize - Requested buffer size in bytes
	 * @returns {ArrayBuffer|null} Buffer or null if size exceeds largest class
	 */
	acquire (requestedSize) {
		const size = this.#getSizeClass(requestedSize);
		if (size === null) {
			return null; // Size too large
		}

		const group = this.#groups.get(size);
		const { cleanPool, dirtyPool, stats } = group;
		let buffer;

		if (cleanPool.length > 0) {
			// Reuse a ready buffer from the clean pool
			buffer = cleanPool.pop();
		} else if (dirtyPool.length > 0) {
			// Clean a buffer from the dirty pool and reuse it
			buffer = dirtyPool.pop();
			this.#zeroBuffer(buffer);
		} else {
			// Allocate new buffer
			buffer = new ArrayBuffer(size);
			++stats.allocated;
		}

		++stats.acquired;

		// Ensure low water mark after acquisition
		this.#ensureMinimum(size);

		return buffer;
	}

	/**
	 * Acquire a set of buffers from the pool sufficient to hold the request.
	 * @param {number} request - Requested total buffer size in bytes
	 * @returns {Array<ArrayBuffer>} Array of buffers to hold the requested size
	 */
	acquireSet (request) {
		let remaining = request;
		const biggestSize = this.#sizeClasses.slice(-1);;
		const buffers = [];
		while (remaining > 0) {
			const size = (remaining >= biggestSize) ? biggestSize : this.#getSizeClass(remaining);
			buffers.push(this.acquire(size));
			remaining -= size;
		}
		return buffers;
	}

	/**
	 * Release a buffer to the dirty pool.
	 * Buffer will be zeroed before returning to the main pool (requirements.md:850).
	 *
	 * @param {ArrayBuffer} buffer - Buffer to release
	 * @returns {boolean} True if released, false if not a recognized size class
	 */
	release (buffer) {
		const size = buffer.byteLength;
		const group = this.#groups.get(size);

		if (!group) {
			return false; // Not a recognized size class
		}

		const { dirtyPool, stats } = group;
		dirtyPool.push(buffer); // Note: Added to *dirty* pool (to be cleaned later)
		++stats.released;

		// Release excess if above high water mark
		this.#releaseExcess(size);

		return true;
	}

	/**
	 * Receive buffers from another thread
	 *
	 * @param {number} size - Size class
	 * @param {ArrayBuffer[]} buffers - Buffers received
	 */
	receiveBuffers (size, buffers) {
		if (!this.#isWorker) {
			throw new Error('receiveBuffers can only be called in worker context');
		}

		const group = this.#groups.get(size);
		if (!group) {
			throw new Error(`Invalid size class: ${size}`);
		}
		if (this.#isWorker) {
			// Clean buffers from main thread
			group.cleanPool.push(...buffers);
		} else {
			// Dirty buffers from worker threads
			group.dirtyPool.push(...buffers);
		}
		group.stats.transferred += buffers.length;
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
			const group = this.#groups.get(size);
			const { cleanPool, dirtyPool, marks, stats: sizeStats } = group;
			stats.pools[size] = {
				lowWaterMark: marks.low,
				highWaterMark: marks.high,
				available: cleanPool.length + dirtyPool.length,
				clean: cleanPool.length,
				dirty: dirtyPool.length,
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
			const group = this.#groups.get(size);
			sizes[size] = group.cleanPool.length + group.dirtyPool.length;
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
		const marks = this.#groups.get(size)?.marks;
		return marks ? { ...marks } : null;
	}

	/**
	 * Clear all pools (for testing/cleanup).
	 */
	clear () {
		for (const group of this.#groups.values()) {
			group.cleanPool.length = group.dirtyPool.length = 0;
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
