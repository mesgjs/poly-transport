/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel Flow Control
 *
 * Inbound and outbound budget-based flow control with chunk sequence tracking
 * and range-based acknowledgment processing.
 */

import { ProtocolViolationError } from './protocol.esm.js';
export { ProtocolViolationError };

/**
 * ChannelFlowControl manages inbound and outbound data flow for a channel.
 * Note: It is not transport-flow-control-aware. Channel operations are
 * responsible for coordinating that.
 *
 * For inbound traffic, it tracks received chunks, validates sequence order
 * and budget, and generates ACK information for sending to remote.
 *
 * Key Features:
 * - Tracks received chunks (received but not consumed)
 * - Validates sequence order (out-of-order is ProtocolViolationError)
 * - Validates budget (over-budget is ProtocolViolationError)
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
	#localMaxBufferBytes;   // Max buffer bytes we're willing to receive
	#nextExpectedSeq;       // Next expected sequence number
	#receivedChunks;        // Map<seq, {bytes, consumed}> from receipt to ACK queued
	#receivedBytes;         // Total bytes received but not yet ACK'd

	// Private outbound state
	#remoteMaxBufferBytes;  // Max buffer bytes remote is willing to receive
	#nextSendSeq;           // Next sequence number to assign
	#inFlightChunks;        // Map<seq, bytes> of sent but not ACK'd chunks
	#inFlightBytes;         // Total bytes in flight
	#waiter;                // Single { bytes, resolve } for waiting sender (TaskQueue ensures serialization)

	/**
	 * Create a new FlowControl instance.
	 *
	 * @param {number} localMaxBufferBytes - Max buffer bytes we're willing to receive (0 = unlimited)
	 * @param {number} remoteMaxBufferBytes - Max buffer bytes remote is willing to receive (0 = unlimited)
	 */
	constructor (localMaxBufferBytes, remoteMaxBufferBytes) {
		this.#localMaxBufferBytes = localMaxBufferBytes;
		this.#nextExpectedSeq = 1;  // Sequence numbers start at 1
		this.#receivedChunks = new Map();
		this.#receivedBytes = 0;
		
		this.#remoteMaxBufferBytes = remoteMaxBufferBytes;
		this.#nextSendSeq = 1;  // Sequence numbers start at 1
		this.#inFlightChunks = new Map();
		this.#inFlightBytes = 0;
		this.#waiter = null;
	}

	/**
	 * Get the available buffer space (bytes available to receive).
	 * @returns {number} Available bytes to receive (Infinity if unlimited)
	 */
	get bufferAvailable () {
		if (this.#localMaxBufferBytes === 0) {
			return Infinity;
		}
		return Math.max(0, this.#localMaxBufferBytes - this.#receivedBytes);
	}

	/**
	 * Get the current buffer usage (bytes received but not consumed).
	 * @returns {number} Bytes currently in receive buffer
	 */
	get bufferUsed () {
		return this.#receivedBytes;
	}

	/**
	 * Check if we can send the specified number of bytes.
	 * @param {number} chunkBytes - Number of bytes to send (header + data)
	 * @returns {boolean} True if sufficient budget available
	 */
	canSend (chunkBytes) {
		const budget = this.sendingBudget;
		return budget === Infinity || budget >= chunkBytes;
	}

	/**
	 * Check for waiter and wake up if sufficient budget is now available.
	 * Note: TaskQueue ensures only one chunk waiting at a time per channel.
	 * @private
	 */
	#checkWaiter () {
		// Check if there's a waiter and if budget is now sufficient
		if (this.#waiter) {
			const budget = this.sendingBudget;
			if (budget === Infinity || budget >= this.#waiter.bytes) {
				// Wake up the waiter
				const waiter = this.#waiter;
				this.#waiter = null;
				waiter.resolve();
			}
		}
	}

	/**
	 * Clear ACK'd chunks from tracking.
	 * Should be called after ACK is sent to remote.
	 * @param {number} baseSeq - Base sequence number from ACK
	 * @param {number[]} ranges - Ranges from ACK
	 * @returns {number} Number of bytes freed
	 */
	clearAcked (baseSeq, ranges) {
		let bytesFreed = 0;

		// Helper to clear a single ACK'd sequence
		const clearSequence = (seq) => {
			const entry = this.#receivedChunks.get(seq);
			if (entry !== undefined) {
				this.#receivedChunks.delete(seq);
				this.#receivedBytes -= entry.bytes;
				bytesFreed += entry.bytes;
			}
		};

		clearSequence(baseSeq); // Always!
		// Process include + skip ranges, if any
		let currentSeq = baseSeq;
		for (let i = 0; i < ranges.length; i += 2) {
			const [include, skip = 0] = ranges.slice(i, i + 2);

			// Include range: clear these sequences
			for (let j = 0; j < include; j++) {
				clearSequence(++currentSeq);
			}
			// Skip range: don't clear these sequences
			currentSeq += skip;
		}

		return bytesFreed;
	}

	/**
	 * Get acknowledgment information for sending to remote.
	 * Returns base sequence and ranges for all CONSUMED chunks only.
	 * Large include/skip counts (>255) are split into multiple range entries.
	 * Enforces max 255 total ranges (include + skip, including 0-continuations).
	 *
	 * Note: Sequences are guaranteed to be in order (recordReceived enforces this).
	 * No sorting needed.
	 *
	 * @returns {{ baseSeq: number, ranges: number[] } | null} ACK info or null if nothing to ACK
	 */
	getAckInfo () {
		// Filter for consumed chunks only (no sorting needed - already in order)
		const consumedSeqs = [];
		for (const [seq, entry] of this.#receivedChunks) {
			if (entry.consumed) {
				consumedSeqs.push(seq);
			}
		}

		if (consumedSeqs.length === 0) {
			return null;
		}

		const baseSeq = consumedSeqs[0];

		// If only one sequence, return simple ACK
		if (consumedSeqs.length === 1) {
			return { baseSeq, ranges: [] };
		}

		// Build range-based ACK with proper splitting for values >255
		const ranges = [];
		let rangeCount = 0;  // Track total ranges (must not exceed 255)
		const MAX_RANGES = 255;

		// Helper to add a count (include or skip), splitting if >255
		// Returns false if we hit the range limit
		const addCount = (count) => {
			while (count > 255) {
				if (rangeCount + 2 > MAX_RANGES) {
					return false;  // Would exceed limit
				}
				ranges.push(255, 0);
				rangeCount += 2;
				count -= 255;
			}
			if (rangeCount + 1 > MAX_RANGES) {
				return false;  // Would exceed limit
			}
			ranges.push(count);
			rangeCount++;
			return true;
		};

		let currentSeq = baseSeq + 1;  // Start after base
		let includeCount = 0; // Only base so far

		for (let i = 1; i < consumedSeqs.length; i++) {
			const seq = consumedSeqs[i];
			const gap = seq - currentSeq;

			if (gap === 0) {
				// Consecutive sequence
				includeCount++;
			} else {
				// Gap detected - flush include, add skip, start new include
				if (!addCount(includeCount)) {
					break;  // Hit range limit
				}
				if (!addCount(gap)) {
					break;  // Hit range limit
				}
				includeCount = 1;
			}

			currentSeq = seq + 1;
		}

		// Add final include count
		if (includeCount > 0) {
			addCount(includeCount);
		}

		return { baseSeq, ranges };
	}

	/**
	 * Get statistics about flow control state.
	 * @returns {object} Statistics object
	 */
	getStats () {
		return {
			localMaxBufferBytes: this.#localMaxBufferBytes,
			nextExpectedSeq: this.#nextExpectedSeq,
			receivedChunks: this.#receivedChunks.size,
			receivedBytes: this.#receivedBytes,
			bufferUsed: this.bufferUsed,
			bufferAvailable: this.bufferAvailable,

			remoteMaxBufferBytes: this.#remoteMaxBufferBytes,
			nextSendSeq: this.#nextSendSeq,
			inFlightChunks: this.#inFlightChunks.size,
			inFlightBytes: this.#inFlightBytes,
			sendingBudget: this.sendingBudget,
			waiter: this.#waiter ? this.#waiter.bytes : null,
		};
	}

	/**
	 * Get the total bytes currently in flight.
	 * @returns {number} Bytes in flight
	 */
	get inFlightBytes () {
		return this.#inFlightBytes;
	}

	/**
	 * Get the maximum buffer bytes we're willing to receive.
	 * @returns {number} Max buffer bytes (0 = unlimited)
	 */
	get localMaxBufferBytes () {
		return this.#localMaxBufferBytes;
	}

	/**
	 * Get the next expected sequence number.
	 * @returns {number} Next expected sequence number
	 */
	get nextExpectedSeq () {
		return this.#nextExpectedSeq;
	}

	/**
	 * Process an acknowledgment and restore sending budget.
	 * ACKs use range-based encoding: base sequence + alternating include/skip ranges.
	 * Each range value is 0-255, so large ranges are split into multiple entries.
	 *
	 * Validates:
	 * - No duplicate ACKs (ACKing same sequence twice is ProtocolViolationError)
	 * - No ACKs beyond assigned (ACKing sequence >= nextSendSeq is ProtocolViolationError)
	 *
	 * @param {number} baseSeq - Base sequence number
	 * @param {number[]} ranges - Array of alternating include/skip quantities (each 0-255)
	 *                            [include1, skip1, include2, skip2, ...]
	 *                            Range count should be 0 or odd (end with include)
	 * @returns {number} Number of bytes freed by this ACK
	 * @throws {ProtocolViolationError} If duplicate ACK or ACK beyond assigned
	 */
	processAck (baseSeq, ranges) {
		let bytesFreed = 0;

		// Helper to process a single ACK'd sequence
		const ackSequence = (seq) => {
			// Validate ACK is not beyond assigned
			if (seq >= this.#nextSendSeq) {
				throw new ProtocolViolationError('PrematureAck', {
					sequence: seq,
					nextSendSeq: this.#nextSendSeq,
					reason: 'ACK beyond assigned sequence',
				});
			}

			const bytes = this.#inFlightChunks.get(seq);
			if (bytes !== undefined) {
				this.#inFlightChunks.delete(seq);
				this.#inFlightBytes -= bytes;
				bytesFreed += bytes;
			} else {
				// Duplicate ACK (already ACK'd)
				throw new ProtocolViolationError('DuplicateAck', {
					sequence: seq,
					reason: 'Sequence already acknowledged',
				});
			}
		};

		ackSequence(baseSeq);
		// Process alternating include/skip ranges, if present
		let currentSeq = baseSeq;
		for (let i = 0; i < ranges.length; i += 2) {
			const [include, skip = 0] = ranges.slice(i, i + 2);
			
			// Include range: ACK these sequences
			for (let j = 0; j < include; ++j) {
				ackSequence(++currentSeq);
			}
			// Skip range: don't ACK these sequences
			currentSeq += skip;
		}

		// If there's a waiter and sufficient budget, wake it
		this.#checkWaiter();

		return bytesFreed;
	}

	/**
	 * Mark a chunk as consumed (ready to ACK).
	 * The chunk remains tracked until ACK is sent and clearAcked() is called.
	 * @param {number} seq - Sequence number of consumed chunk
	 * @returns {boolean} True if chunk was found and marked consumed
	 */
	recordConsumed (seq) {
		const entry = this.#receivedChunks.get(seq);
		if (entry !== undefined && !entry.consumed) {
			entry.consumed = true;
			return true;
		}
		return false;
	}

	/**
	 * Record a received chunk and consume receive buffer space.
	 * Validates sequence order and budget.
	 *
	 * @param {number} seq - Sequence number of received chunk
	 * @param {number} chunkBytes - Number of bytes received (header + data)
	 * @throws {ProtocolViolationError} If sequence is out of order or over budget
	 */
	recordReceived (seq, chunkBytes) {
		// Validate sequence order
		if (seq !== this.#nextExpectedSeq) {
			throw new ProtocolViolationError('OutOfOrder', {
				expected: this.#nextExpectedSeq,
				received: seq,
			});
		}

		// Validate budget
		const available = this.bufferAvailable;
		if (available !== Infinity && chunkBytes > available) {
			throw new ProtocolViolationError('OverBudget', {
				available,
				requested: chunkBytes,
			});
		}

		// Record the chunk (not yet consumed)
		this.#receivedChunks.set(seq, { bytes: chunkBytes, consumed: false });
		this.#receivedBytes += chunkBytes;
		this.#nextExpectedSeq++;
	}

	/**
	 * Record a sent chunk and consume sending budget.
	 * @param {number} chunkBytes - Number of bytes sent (header + data)
	 * @returns {number} Sequence number assigned to this chunk
	 */
	recordSent (chunkBytes) {
		const seq = this.#nextSendSeq++;
		this.#inFlightChunks.set(seq, chunkBytes);
		this.#inFlightBytes += chunkBytes;
		return seq;
	}

	/**
	 * Get the maximum buffer bytes remote is willing to receive.
	 * @returns {number} Max buffer bytes (0 = unlimited)
	 */
	get remoteMaxBufferBytes () {
		return this.#remoteMaxBufferBytes;
	}

	/**
	 * Get the current sending budget (bytes available to send).
	 * Budget = remote max - in-flight bytes (or unlimited if remote max is 0)
	 * @returns {number} Available bytes to send (Infinity if unlimited)
	 */
	get sendingBudget () {
		if (this.#remoteMaxBufferBytes === 0) {
			return Infinity;
		}
		return Math.max(0, this.#remoteMaxBufferBytes - this.#inFlightBytes);
	}

	/**
	 * Wait for sufficient budget to send the specified number of bytes.
	 * Resolves immediately if sufficient budget is available.
	 * @param {number} chunkBytes - Number of bytes to send (header + data)
	 * @returns {Promise<void>} Resolves when budget is available
	 */
	async waitForBudget (chunkBytes) {
		// If we can send now, resolve immediately
		if (this.canSend(chunkBytes)) {
			return;
		}

		// Otherwise, wait for budget to become available
		// Note: TaskQueue ensures only one chunk waiting at a time per channel
		return new Promise((resolve) => {
			this.#waiter = { bytes: chunkBytes, resolve };
		});
	}
}
