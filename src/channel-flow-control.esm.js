/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel Flow Control
 *
 * Inbound and outbound budget-based flow control with chunk sequence tracking
 * and range-based acknowledgment processing.
 */

import { MAX_ACK_RANGES } from './protocol.esm.js';

/**
 * ChannelFlowControl manages inbound and outbound data flow for a channel.
 *
 * For inbound traffic, it tracks received chunks, validates sequence order
 * and budget, and generates ACK information for sending to remote.
 *
 * Key Features:
 * - Tracks received chunks (received but not processed)
 * - Validates sequence order (out-of-order is protocol violation)
 * - Validates budget (over-budget is protocol violation)
 * - Generates range-based ACK information
 * - Budget includes ALL channel message headers (control and data)
 *
 * For outbound traffic, it tracks in-flight chunks, calculates available
 * sending budget, and processes incoming ACKs to restore budget.
 *
 * Key Features:
 * - Budget-based flow control (budget = remote max - in-flight)
 * - Chunk sequence tracking (per channel and direction)
 * - Range-based acknowledgment processing
 * - Async waiting for budget availability
 * - Budget includes ALL channel message headers (control and data)
 * - Validates ACKs (no duplicates, no ACKs beyond assigned)
 */
export class ChannelFlowControl {
	// Private inbound state
	#ackableBytes = 0;         // Number of ACKable *read* bytes
	#ackableChunks = 0         // Number of ACKable *read* chunks/sequence numbers
	#ackBatchTime;             // ACK batching time (msec)
	#ackBatchTimer = null;     // ACK batching timer
	#ackCallback;              // Channel callback to send ACKs
	#forceAckBytes;            // # of bytes to override inter-ACK delay
	#forceAckChunks;           // # of chunks to override inter-ACK delay
	#lowWaterBytes;            // Low-water-mark for unprocessed bytes
	#nextReadSeq = 1;          // Sequence number expected to be received next
	#read = 0;                 // Total bytes received remaining to be locally ACK'd
	#readAckInfo = new Map();  // Map<seq, {bytes, processed}> from receipt to ACK queued
	#readLimit;                // Max read (local buffer) limit
	#unprocessed = 0;          // Total unprocessed bytes

	// Private outbound state
	#allWritesAcked = null;    // Promise for all pending writes ACKed
	#nextWriteSeq = 1;         // Sequence number to use on next send
	#writeAckInfo = new Map(); // Map<seq, {bytes}> of sent but not ACK'd chunks
	#writeLimit;               // Max buffer bytes remote is willing to receive
	#writer = null;            // { bytes, resolve } for TaskQueue-serialized waiting writer
	#written = 0;              // Total bytes sent remaining to be remotely ACK'd

	#channel;
	#logger;
	#promiseTracer; // Optional PromiseTracer instance for tracing long-lived waits
	#stopped = false;

	/**
	 * Create a new FlowControl instance.
	 *
	 * @param {number} readLimit - Max buffer bytes we're willing to receive (0 = unlimited)
	 * @param {number} writeLimit - Max buffer bytes remote is willing to receive (0 = unlimited)
	 * @param {Object} options
	 * @param {number} options.ackBatchTime - standard time to wait between ACKs (msec)
	 * @param {function} options.ackCallback - channel callback to send ACKs
	 * @param {number} options.forceAckBytes - number of ACKable bytes that overrides ackBatchTime
	 * @param {number} options.forceAckChunks - number of ACKable chunks that overrides ackBatchTime
	 * @param {number} options.lowWaterBytes - read-level below which to start sending ACKs
	 * @param {PromiseTracer} options.promiseTracer - Promise tracer for monitoring long-lived waits
	 */
	constructor (readLimit, writeLimit, { ackBatchTime, ackCallback, channel, forceAckBytes, forceAckChunks, logger, lowWaterBytes, promiseTracer } = {}) {
		this.#ackBatchTime = ackBatchTime ?? 0; // Default 0 = no minimum delay between ACKs
		this.#ackCallback = ackCallback;
		this.#forceAckBytes = forceAckBytes ?? 0; // Default 0 = no delay override
		this.#forceAckChunks = forceAckChunks ?? 0; // Default 0 = no delay override
		this.#lowWaterBytes = lowWaterBytes ?? 0; // Default 0 = don't apply low-water mark
		this.#readLimit = readLimit;
		this.#writeLimit = writeLimit;

		this.#channel = channel;
		this.#logger = logger || console;
		this.#promiseTracer = promiseTracer ?? null;

		if (channel && !ackCallback) {
			this.#logger.warn(`No ACK callback for channel ${channel?.name}!`);
		}
	}

	/**
	 * Return count of ACKable bytes
	 */
	get ackableBytes () {
		return this.#ackableBytes;
	}

	/**
	 * Return count of ACKable chunks/sequences
	 */
	get ackableChunks () {
		return this.#ackableChunks;
	}

	/**
	 * Wait for all pending writes to be ACKed (e.g. when channel is closing)
	 * @returns {Promise<void>} - Resolves when no writes are pending ACKs
	 */
	/* async */ allWritesAcked () {
		if (!this.#writeAckInfo.size) return Promise.resolve(); // Already empty now

		const existing = this.#allWritesAcked; // Return existing promise if there is one
		if (existing) return existing.promise;

		const promise = this.#allWritesAcked = {}; // No existing promise yet, so create one
		promise.promise = new Promise((...r) => [promise.resolve, promise.reject] = r);

		// Trace promise if tracer is enabled
		const channelName = this.#channel?.name ?? 'unknown';
		this.#promiseTracer?.trace(promise.promise,
			`Channel "${channelName}" close waiting for ${this.#writeAckInfo.size} in-flight write(s) to be ACKed`);

		return promise.promise;
	}

	/**
	 * Common code to clear ACK'd sequences from tracking.
	 * @param {number} base - Base sequence number from ACK
	 * @param {number[]} ranges - Ranges from ACK
	 * @param {Map<seq, {bytes}} seqMap - The sequence map from which to clear ACKS
	 * @param {number|undefined} nextSeq - The next sequence number
	 * @returns {{acks: number, bytes: number, duplicate: number, premature: number}} Number of: ACKs, ACK'd bytes, duplicate sequences, and premature sequences
	 */
	#clearAckInfo (base, ranges, seqMap, nextSeq) {
		let acks = 0, bytes = 0, duplicate = 0, premature = 0;

		// Helper to clear a single ACK'd sequence
		const clearSequence = (seq) => {
			if (typeof nextSeq === 'number' && seq >= nextSeq) {
				++premature;
				return;
			}
			const info = seqMap.get(seq);
			if (info) {
				seqMap.delete(seq);
				++acks;
				bytes += info.bytes;
			} else {
				++duplicate;
			}
		};

		clearSequence(base); // Always!
		// Process additional + skip ranges, if any
		let current = base;
		if (ranges) for (let i = 0; i < ranges.length; i += 2) {
			const [additional, skip = 0] = ranges.slice(i, i + 2);

			// Additional range: clear these sequences
			for (let j = 0; j < additional; j++) {
				clearSequence(++current);
			}
			// Skip range: don't clear these sequences
			current += skip;
		}

		return { acks, bytes, duplicate, premature };
	}

	/**
	 * Clear read info and recover read budget for processed sequences
	 * Called when ACKs for data read and processed are sent to the remote
	 * @param {number} base
	 * @param {number[]} ranges
	 * @returns {{ acks, bytes, duplicate, premature }}
	 */
	clearReadAckInfo (base, ranges) {
		const result = this.#clearAckInfo(base, ranges, this.#readAckInfo, this.#nextReadSeq);
		this.#ackableBytes -= result.bytes;
		this.#ackableChunks -= result.acks;
		this.#read -= result.bytes; // Free up read budget
		const { duplicate, premature } = result;
		if (!duplicate && !premature) this.#scheduleAcks(); // Just sent some, but check if we need to send more
		return result;
	}

	/**
	 * Clear write info for ACKs received from the remote and recover write budget
	 * @param {*} base
	 * @param {*} ranges
	 * @returns {{ acks, bytes, duplicate, premature }}
	 */
	clearWriteAckInfo (base, ranges) {
		const writeAckInfo = this.#writeAckInfo;
		const result = this.#clearAckInfo(base, ranges, writeAckInfo, this.#nextWriteSeq);
		this.#written -= result.bytes;

		// Wake up waiting writer if budget is now sufficient
		if (this.#writer && this.writeBudget >= this.#writer.bytes) {
			const { resolve } = this.#writer;
			this.#writer = null;
			resolve();
		} else if (this.#allWritesAcked && !this.#writer && !writeAckInfo.size) {
			const resolve = this.#allWritesAcked.resolve;
			this.#allWritesAcked = null;
			resolve();
		}

		return result;
	}

	/**
	 * Get acknowledgment information for sending to remote.
	 * Returns base sequence and up to 255 ranges (additional + skip,
	 * including 0-continuations) for processed chunks.
	 * Large additional/skip counts (>255) are split into multiple range entries.
	 *
	 * Note: Sequences are guaranteed to be in order (`received` enforces this).
	 *
	 * @returns {{ base: number, ranges: number[], complete: boolean } | { complete: true}} ACK info
	 */
	getAckInfo () {
		if (!this.#ackableChunks) return { complete: true };

		// Filter for consumed chunks only (no sorting needed - already in order)
		const processed = [];
		for (const [seq, info] of this.#readAckInfo) {
			if (info.processed) {
				processed.push(seq);
			}
		}

		const base = processed[0];

		// If only one sequence, return simple ACK
		if (processed.length === 1) {
			return { base, ranges: [], complete: true };
		}

		// Build range-based ACK with proper splitting for values >255
		const ranges = [];
		let length = 0; // *include*-based length

		// Helper to add a count (additional or skip), splitting if >255
		// Returns false if we hit the range limit
		const addCount = (count, isInclude = true) => {
			while (count > 255 && ranges.length + 2 <= MAX_ACK_RANGES) {
				ranges.push(255, 0);
				count -= 255;
				if (isInclude) length = ranges.length - 1;
			}
			if (ranges.length + 1 > MAX_ACK_RANGES) {
				return false;  // Would exceed limit
			}
			ranges.push(Math.min(count, 255));
			if (isInclude) length = ranges.length;
			return count <= 255;
		};

		let sequential = base + 1;  // Start after base
		let additional = 0; // Only base so far
		let complete = true; // Is base + ranges complete?

		for (let i = 1; i < processed.length; ++i) {
			const sequence = processed[i];
			const gap = sequence - sequential;

			if (gap === 0) {
				// Consecutive sequence
				additional++;
			} else {
				// Gap detected - flush additional, add skip, start new additional
				if (!addCount(additional) || !addCount(gap, false)) {
					complete = false; // Hit range limit; result is incomplete
					break;
				}
				additional = 1;
			}

			sequential = sequence + 1;
		}

		// Try to add the final additional count
		if (additional && !addCount(additional)) complete = false;

		ranges.length = length; // In case we ended in the middle of a large skip range
		return { base, ranges, complete };
	}

	/**
	 * Get statistics about flow control state.
	 * @returns {object} Statistics object
	 */
	getStats () {
		return {
			ackableBytes: this.#ackableBytes,
			ackableChunks: this.#ackableChunks,
			nextReadSeq: this.#nextReadSeq,
			read: this.#read,
			readAckInfo: this.#readAckInfo.size,
			readBudget: this.readBudget,
			readLimit: this.#readLimit,
			unprocessed: this.#unprocessed,

			nextWriteSeq: this.#nextWriteSeq,
			writeAckInfo: this.#writeAckInfo.size,
			writeBudget: this.writeBudget,
			writeLimit: this.#writeLimit,
			written: this.#written,
			writer: this.#writer ? this.#writer.bytes : null,
		};
	}

	/**
	 * Mark a read sequence processed (ready to ACK).
	 * The chunk remains tracked until ACK is sent and clearAcked() is called.
	 * @param {number} seq - Sequence number of consumed chunk
	 * @returns {boolean} True if chunk was found and marked consumed
	 */
	markProcessed (seq) {
		const entry = this.#readAckInfo.get(seq);
		if (entry !== undefined && !entry.processed) {
			const bytes = entry.bytes;
			entry.processed = true;
			this.#ackableBytes += bytes;
			this.#unprocessed -= bytes;
			++this.#ackableChunks;
			this.#scheduleAcks();
			return true;
		}
		return false;
	}

	/**
	 * Get the next expected read sequence number.
	 * @returns {number} Next expected read sequence number
	 */
	get nextReadSeq () {
		return this.#nextReadSeq;
	}

	/**
	 * Get the next write sequence number.
	 * @returns {number} Next write sequence number
	 */
	get nextWriteSeq () {
		return this.#nextWriteSeq;
	}

	/**
	 * Get the total bytes currently received but not yet ACK'd.
	 * @returns {number} Bytes received
	 */
	get read () {
		return this.#read;
	}

	/**
	 * Get the read budget (negative if over budget, Infinity if unlimited)
	 * @returns {number} Available budget in bytes
	 */
	get readBudget () {
		if (this.#readLimit === 0) return Infinity;
		return this.#readLimit - this.#read;
	}

	/**
	 * Get the maximum buffer bytes we're willing to receive.
	 * @returns {number} Max buffer bytes (0 = unlimited)
	 */
	get readLimit () {
		return this.#readLimit;
	}

	/**
	 * Record a received sequence and track bytes received.
	 * Validates sequence order and budget.
	 *
	 * @param {number} seq - Sequence number of received chunk
	 * @param {number} bytes - Number of bytes received
	 * @returns {boolean} - Whether received sequence is valid
	 */
	received (seq, bytes) {
		// Validate sequence order
		if (seq !== this.#nextReadSeq) {
			this.#logger.error(`Sequence out of order (expected ${this.#nextReadSeq}, received ${seq})`);
			return false;
		}

		// Validate budget
		const available = this.readBudget;
		if (bytes > available) {
			this.#logger.error(`Chunk over budget (available ${available}, received ${bytes})`);
			return false;
		}

		// Record the chunk (not yet consumed)
		this.#readAckInfo.set(seq, { bytes, processed: false });
		this.#read += bytes;
		this.#unprocessed += bytes;
		++this.#nextReadSeq;
		return true;
	}

	// Determine when ACKs should be sent for data that have been processed
	#scheduleAcks () {
		const callback = this.#ackCallback, ackChunks = this.#ackableChunks, lowWaterBytes = this.#lowWaterBytes;
		// Return now if there's nothing to do
		if (!callback || !ackChunks || (lowWaterBytes && this.#unprocessed > lowWaterBytes)) return;

		// ACK now if there's no batch timer running or there's a delay-override
		const ackBytes = this.#ackableBytes, batchTime = this.#ackBatchTime;
		const forceBytes = this.#forceAckBytes, forceChunks = this.#forceAckChunks;
		if (!this.#ackBatchTimer || (forceBytes && ackBytes >= forceBytes) || (forceChunks && ackChunks >= forceChunks)) {
			if (this.#ackBatchTimer) {
				clearTimeout(this.#ackBatchTimer);
				this.#ackBatchTimer = null;
			}
			queueMicrotask(callback);
			if (batchTime && !this.#stopped) {
				this.#ackBatchTimer = setTimeout(() => {
					this.#ackBatchTimer = null;
					this.#scheduleAcks(); // Recheck after batching delay
				}, batchTime);
			}
			return;
		}
	}

	/**
	 * Record sent bytes, attributed to the next sequence number
	 * @param {number} bytes - The number of bytes in the chunk
	 */
	sent (bytes) {
		const seq = this.#nextWriteSeq++;
		this.#writeAckInfo.set(seq, { bytes });
		this.#written += bytes;
	}

	/**
	 * Allow updating ackBatchTime for channel-close in discard mode
	 * @param {number} time 
	 */
	setAckBatchTime (time) {
		this.#ackBatchTime = time;
	}

	/**
	 * Stop any running batch timer when finalizing channel closure.
	 * If disconnected is true, also rejects pending writable() and allWritesAcked() waiters.
	 * @param {Object} options
	 * @param {boolean} options.disconnected - Whether to reject pending waiters (default: false)
	 */
	stop ({ disconnected = false } = {}) {
		const timer = this.#ackBatchTimer;
		if (timer) clearTimeout(timer);
		this.#stopped = true;

		if (disconnected) {
			// Reject pending writable() waiter
			if (this.#writer) {
				const { reject } = this.#writer;
				this.#writer = null;
				reject?.('Disconnected');
			}
			// Reject pending allWritesAcked() waiter
			if (this.#allWritesAcked) {
				const { reject } = this.#allWritesAcked;
				this.#allWritesAcked = null;
				reject?.('Disconnected');
			}
		}
	}

	/**
	 * Get the number of unprocessed bytes
	 */
	get unprocessed () {
		return this.#unprocessed;
	}

	/**
	 * Get the maximum buffer bytes remote is willing to receive.
	 * @returns {number} Max buffer bytes (0 = unlimited)
	 */
	get writeLimit () {
		return this.#writeLimit;
	}

	/**
	 * Wait for sufficient budget to send the specified number of bytes.
	 * Resolves immediately if sufficient budget is available.
	 * @param {number} bytes - Total number of bytes we want to send (header (for byte-streams) + data)
	 * @returns {Promise<void>} Resolves when budget is available
	 */
	async writable (bytes) {
		// If we can send now, resolve immediately
		if (this.writeBudget > bytes) {
			return;
		}

		// Otherwise, wait for budget to become available
		// Note: TaskQueue ensures only one chunk waiting at a time per channel
		const promise = new Promise((resolve, reject) => {
			this.#writer = { bytes, resolve, reject };
		});

		// Trace promise if tracer is enabled
		const channelName = this.#channel?.name ?? 'unknown';
		this.#promiseTracer?.trace(promise,
			`Channel "${channelName}" write blocked: need ${bytes} bytes, budget ${this.writeBudget} / limit ${this.#writeLimit}`);

		return promise;
	}

	/**
	 * Get the write budget (Infinity if unlimited)
	 * @returns {number} Available budget in bytes
	 */
	get writeBudget () {
		if (this.#writeLimit === 0) return Infinity;
		return this.#writeLimit - this.#written;
	}

	/**
	 * Get the total bytes currently in flight.
	 * @returns {number} Bytes in flight
	 */
	get written () {
		return this.#written;
	}
}
