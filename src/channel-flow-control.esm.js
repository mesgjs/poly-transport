/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel Flow Control
 *
 * Inbound and outbound budget-based flow control with chunk sequence tracking
 * and range-based acknowledgment processing.
 */

import { MAX_ACK_RANGES, ProtocolViolationError } from './protocol.esm.js';
export { ProtocolViolationError };

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
	#acksPending = false;      // ACKs are currently pending
	#forceAckBytes;            // # of bytes to override inter-ACK delay
	#forceAckChunks;           // # of chunks to override inter-ACK delay
	#lowReadBytes;             // Low-water-mark bytes
	#nextReadSeq = 1;          // Sequence number expected to be received next
	#read = 0;                 // Total bytes received remaining to be locally ACK'd
	#readAckInfo = new Map();  // Map<seq, {bytes, processed}> from receipt to ACK queued
	#readLimit;                // Max read (local buffer) limit

	// Private outbound state
	#nextWriteSeq = 1;         // Sequence number to use on next send
	#writeAckInfo = new Map(); // Map<seq, {bytes}> of sent but not ACK'd chunks
	#writeLimit;               // Max buffer bytes remote is willing to receive
	#writer = null;            // { bytes, resolve } for TaskQueue-serialized waiting writer
	#written = 0;              // Total bytes sent remaining to be remotely ACK'd

	#logger;

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
	 * @param {number} options.lowReadBytes - read-level below which to start sending ACKs
	 */
	constructor (readLimit, writeLimit, { ackBatchTime, ackCallback, forceAckBytes, forceAckChunks, logger, lowReadBytes } = {}) {
		this.#ackBatchTime = ackBatchTime ?? 0; // Default 0 = no minimum delay between ACKs
		this.#ackCallback = ackCallback;
		this.#forceAckBytes = forceAckBytes ?? 0; // Default 0 = no delay override
		this.#forceAckChunks = forceAckChunks ?? 0; // Default 0 = no delay override
		this.#lowReadBytes = lowReadBytes ?? 0; // Default 0 = don't apply low-water mark
		this.#readLimit = readLimit;
		this.#writeLimit = writeLimit;

		this.#logger = logger || console;
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
		for (let i = 0; i < ranges.length; i += 2) {
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
	 * @param {number} base
	 * @param {number[]} ranges
	 * @returns {{ acks, bytes, duplicate, premature }}
	 */
	clearReadAckInfo (base, ranges) {
		const result = this.#clearAckInfo(base, ranges, this.#readAckInfo, this.#nextReadSeq);
		const batchTime = this.#ackBatchTime;
		this.#ackableBytes -= result.bytes;
		this.#ackableChunks -= result.acks;
		this.#read -= result.bytes;
		this.#acksPending = false;
		this.#scheduleAcks(true);
		return result;
	}

	/**
	 * Clear write info for ACKs received from the remote and recover write budget
	 * @param {*} base
	 * @param {*} ranges
	 * @returns {{ acks, bytes, duplicate, premature }}
	 */
	clearWriteAckInfo (base, ranges) {
		const result = this.#clearAckInfo(base, ranges, this.#writeAckInfo, this.#nextWriteSeq);
		this.#written -= result.bytes;

		// Wake up waiting writer if budget is now sufficient
		if (this.#writer && this.writeBudget >= this.#writer.bytes) {
			const { resolve } = this.#writer;
			this.#writer = null;
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
	 * @returns {{ base: number, ranges: number[] } | null} ACK info or null if nothing to ACK
	 */
	getAckInfo () {
		if (!this.#ackableChunks) return null;

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
			entry.processed = true;
			this.#ackableBytes += entry.bytes;
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
		++this.#nextReadSeq;
		return true;
	}

	// Determine when ACKs should be sent for data that have been processed
	#scheduleAcks (justSent = false) {
		// Nothing more to do if there's no callback or ACKs are already pending
		if (!this.#ackCallback || this.#acksPending) return;

		// Don't ACK yet if unprocessed reads are over the low-water mark
		const lowReadBytes = this.#lowReadBytes;
		if (lowReadBytes && this.#read > lowReadBytes) return;

		// ACK now if we didn't just ACK, there's no batching delay, or there's a delay-override
		const ackBytes = this.#ackableBytes, ackChunks = this.#ackableChunks, batchTime = this.#ackBatchTime;
		const forceBytes = this.#forceAckBytes, forceChunks = this.#forceAckChunks;
		if (!justSent || (!batchTime && ackChunks) || (forceBytes && ackBytes >= forceBytes) || (forceChunks && ackChunks >= forceChunks)) {
			this.#acksPending = true;
			queueMicrotask(this.#ackCallback);
			return;
		}

		if (justSent && batchTime) { // Start the batching timer if we just sent ACKs
			this.#ackBatchTimer = setTimeout(() => {
				this.#ackBatchTimer = null;
				this.#scheduleAcks(); // Recheck after batching delay
			}, batchTime);
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
		return new Promise((resolve) => {
			this.#writer = { bytes, resolve };
		});
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
