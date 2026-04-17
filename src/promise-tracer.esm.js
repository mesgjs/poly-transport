/**
 * PromiseTracer - Diagnostic tool for tracking pending promises
 * 
 * Helps diagnose hung async waits by tracking promises with descriptions
 * and reporting overdue waits. Designed for low overhead and minimal noise.
 * 
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * PromiseTracer tracks pending promises and reports overdue waits.
 * 
 * Features:
 * - Promise-keyed Map for automatic cleanup when promises settle
 * - Lazy stack trace generation (only when overdue)
 * - Event IDs assigned at first auto-report
 * - Low-noise: each overdue wait reported exactly once
 * - Auto-reports pending waits on stop() in quiet mode
 * 
 * @example
 * const tracer = new PromiseTracer(5000, { log: console.warn.bind(console) });
 * 
 * const promise = someAsyncOperation();
 * tracer.trace(promise, 'waiting for channel request');
 * 
 * // Auto-reports overdue waits every 5 seconds (default: thresholdMs)
 * // Manual report: tracer.report({ overdueOnly: true });
 * 
 * tracer.stop(); // Auto-reports remaining pending waits
 */
export class PromiseTracer {
	/** @type {Map<Promise, { trace: Error, timestamp: number, eventId: number|null }>} */
	#registry = new Map();
	
	/** @type {number} Next event ID to assign */
	#nextEventId = 1;
	
	/** @type {number} Milliseconds before a wait is considered overdue */
	#thresholdMs;
	
	/** @type {number} Auto-report interval in milliseconds */
	#intervalMs;
	
	/** @type {function} Bound log function for all output */
	#log;
	
	/** @type {boolean} Whether to unconditionally log rejections */
	#logRejections;
	
	/** @type {number|null} Auto-report timer ID */
	#timer = null;
	
	/**
	 * Create a new PromiseTracer.
	 *
	 * @param {number} thresholdMs - Log waits outstanding longer than this many ms
	 * @param {Object} [options]
	 * @param {number} [options.intervalMs] - How often to scan (default: thresholdMs)
	 * @param {function} [options.log] - Bound log function for all output (default: console.warn)
	 * @param {boolean} [options.logRejections=false] - Unconditionally log rejections
	 */
	constructor (thresholdMs, { intervalMs, log, logRejections = false } = {}) {
		this.#thresholdMs = thresholdMs;
		this.#intervalMs = intervalMs ?? thresholdMs;
		this.#log = log ?? console.warn.bind(console);
		this.#logRejections = logRejections;
		
		// Start interval timer
		this.#timer = setInterval(() => this.#scan(), this.#intervalMs);
	}
	
	/**
	 * Interval scan for overdue waits.
	 * Reports each overdue wait exactly once (assigns event ID on first report).
	 * @private
	 */
	#scan () {
		const now = Date.now();
		const threshold = this.#thresholdMs;
		
		for (const [_promise, entry] of this.#registry) {
			if (entry.eventId !== null) continue; // Already reported; skip
			
			const age = now - entry.timestamp;
			if (age >= threshold) {
				entry.eventId = this.#nextEventId++;
				this.#log(
					`[TRACE #${entry.eventId}] ${new Date(entry.timestamp).toISOString()} (${age}ms)\n${entry.trace.stack}`
				);
			}
		}
	}
	
	/**
	 * Register a promise for tracing.
	 * 
	 * The promise is automatically removed from the registry when it settles.
	 * Stack trace is captured eagerly but formatted lazily (only when overdue).
	 * Returns the same promise for chaining convenience.
	 * 
	 * @param {Promise} promise - The promise to track
	 * @param {string} description - Human-readable description of what is being waited for
	 * @returns {Promise} The same promise (pass-through)
	 */
	trace (promise, description) {
		const timestamp = Date.now();
		const trace = new Error(description); // Captures stack now; .stack formatted lazily
		
		this.#registry.set(promise, { trace, timestamp, eventId: null });
		
		// Use .then/.catch to optionally log rejections
		// Note: We don't re-throw in the catch handler to avoid creating a new uncaught rejection
		promise.then(
			() => {
				// Resolved successfully
				const entry = this.#registry.get(promise);
				if (entry?.eventId !== null) {
					// This wait was auto-reported; log its resolution
					const age = Date.now() - entry.timestamp;
					this.#log(`[TRACE #${entry.eventId}] Resolved after ${age}ms: ${entry.trace.message}`);
				}
				this.#registry.delete(promise);
			},
			(error) => {
				// Rejected
				const entry = this.#registry.get(promise);
				if (this.#logRejections) {
					// Unconditionally log rejections if enabled
					const age = Date.now() - entry.timestamp;
					if (entry?.eventId !== null) {
						this.#log(`[TRACE #${entry.eventId}] Rejected after ${age}ms: ${entry.trace.message}\nReason: ${error}`);
					} else {
						this.#log(`[TRACE] Rejected after ${age}ms: ${entry.trace.message}\nReason: ${error}`);
					}
				}
				this.#registry.delete(promise);
				// Don't re-throw - the original promise is already rejected
			}
		);
		
		return promise;
	}
	
	/**
	 * Explicitly remove a promise from the registry before it settles.
	 * No-op if the promise is not registered.
	 * 
	 * @param {Promise} promise - Promise to stop tracking
	 */
	clear (promise) {
		this.#registry.delete(promise);
	}
	
	/**
	 * Immediately log all currently-tracked promises.
	 * 
	 * @param {Object} [options]
	 * @param {boolean} [options.overdueOnly=false] - Only report waits past threshold
	 * @param {boolean} [options.quiet=false] - Suppress "No pending waits" message
	 */
	report ({ overdueOnly = false, quiet = false } = {}) {
		const now = Date.now();
		const threshold = this.#thresholdMs;
		const entries = [...this.#registry.values()].sort((a, b) => a.timestamp - b.timestamp);
		
		if (!entries.length) {
			if (!quiet) this.#log('[TRACE] No pending waits.');
			return;
		}
		
		for (const entry of entries) {
			const age = now - entry.timestamp;
			if (!overdueOnly || age >= threshold) {
				const idPart = entry.eventId !== null ? ` #${entry.eventId}` : '';
				this.#log(
					`[TRACE${idPart}] ${new Date(entry.timestamp).toISOString()} (${age}ms)\n${entry.trace.stack}`
				);
			}
		}
	}
	
	/**
	 * Stop the interval timer and auto-report any pending waits (quiet mode).
	 * 
	 * Pending waits at stop time are likely a sign of issues, so they are always reported.
	 * The "No pending waits" message is suppressed since clean shutdown is normal.
	 */
	stop () {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.report({ quiet: true }); // Report pending waits; suppress "No pending waits"
	}
}
