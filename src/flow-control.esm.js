// Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung

/**
 * Flow control for PolyTransport.
 *
 * Phase 1.3 implements per-channel, per-direction, byte-credit sliding-window
 * flow control.
 *
 * This module is transport-agnostic. It tracks:
 * - Outbound in-flight bytes (consumed from remote-provided credits)
 * - Inbound buffered bytes (bounded by local maxBufferSize)
 * - ACK generation (from consumed inbound chunks)
 * - ACK processing (to restore outbound credits)
 */

export class TimeoutError extends Error {
	constructor (message = 'Timeout') {
		super(message);
		this.name = 'TimeoutError';
	}
}

export class ProtocolViolationError extends Error {
	constructor (message, { reason = 'Protocol violation' } = {}) {
		super(message);
		this.name = 'ProtocolViolationError';
		this.reason = reason;
	}
}

/**
 * FlowController manages flow control for a single channel direction.
 *
 * Typical usage:
 * - Sender side:
 *   - `await reserveSend (size)` before emitting each frame
 *   - `processAck ({ baseSequence, ranges })` upon receiving ACKs
 *
 * - Receiver side:
 *   - `onReceiveChunk ({ sequence, size })` when a chunk arrives
 *   - `onConsumeChunk (sequence)` when the chunk is fully processed/consumed
 *   - `createAck (maxRangeCount)` to produce an ACK when needed
 */
export class FlowController {
	constructor (options = {}) {
		const {
			channelId = 0,
			// Outbound credits (remote-provided). 0 means unlimited.
			remoteMaxBufferSize = 0,
			// Inbound buffer budget (local). 0 means unlimited.
			maxBufferSize = 0,
			lowBufferSize = 0
		} = options;

		if (!Number.isInteger(channelId) || channelId < 0) {
			throw new RangeError('channelId must be a non-negative integer');
		}
		if (!Number.isInteger(remoteMaxBufferSize) || remoteMaxBufferSize < 0) {
			throw new RangeError('remoteMaxBufferSize must be a non-negative integer');
		}
		if (!Number.isInteger(maxBufferSize) || maxBufferSize < 0) {
			throw new RangeError('maxBufferSize must be a non-negative integer');
		}
		if (!Number.isInteger(lowBufferSize) || lowBufferSize < 0) {
			throw new RangeError('lowBufferSize must be a non-negative integer');
		}
		if (maxBufferSize !== 0 && lowBufferSize > maxBufferSize) {
			throw new RangeError('lowBufferSize must be <= maxBufferSize');
		}

		this.channelId = channelId;

		// Outbound state.
		this.remoteMaxBufferSize = remoteMaxBufferSize;
		this._sendNextSequence = 1;
		this._sendInFlightBytes = 0;
		this._sendInFlightBySeq = new Map();
		this._sendWaiters = []; // FIFO of { size, resolve, reject, timer }

		// Inbound state.
		this.maxBufferSize = maxBufferSize;
		this.lowBufferSize = lowBufferSize;
		this._recvNextSequence = 1;
		this._recvBufferedBytes = 0;
		this._recvSizesBySeq = new Map();
		this._recvConsumedNotAcked = new Set();
		this._recvConsumedMin = null;
	}

	get sendInFlightBytes () {
		return this._sendInFlightBytes;
	}

	get sendBudget () {
		if (this.remoteMaxBufferSize === 0) {
			return Infinity;
		}
		return this.remoteMaxBufferSize - this._sendInFlightBytes;
	}

	get recvBufferedBytes () {
		return this._recvBufferedBytes;
	}

	get recvBudget () {
		if (this.maxBufferSize === 0) {
			return Infinity;
		}
		return this.maxBufferSize - this._recvBufferedBytes;
	}

	_grantSend (size) {
		const seq = this._sendNextSequence++;
		this._sendInFlightBySeq.set(seq, size);
		this._sendInFlightBytes += size;
		return seq;
	}

	_drainSendWaiters () {
		while (this._sendWaiters.length > 0) {
			const w = this._sendWaiters[0];
			if (this.sendBudget < w.size) {
				break;
			}
			this._sendWaiters.shift();
			if (w.timer) {
				clearTimeout(w.timer);
				w.timer = null;
			}
			const seq = this._grantSend(w.size);
			w.resolve(seq);
		}
	}

	/**
	 * Awaitable outbound reservation.
	 *
	 * When it resolves, the returned sequence number MUST be used for the
	 * outgoing chunk frame of the corresponding payload size.
	 */
	async reserveSend (size, { timeout = 0 } = {}) {
		if (!Number.isInteger(size) || size < 0) {
			throw new RangeError('size must be a non-negative integer');
		}
		if (this.remoteMaxBufferSize !== 0 && size > this.remoteMaxBufferSize) {
			throw new RangeError('size exceeds remoteMaxBufferSize');
		}
		if (!Number.isInteger(timeout) || timeout < 0) {
			throw new RangeError('timeout must be a non-negative integer');
		}

		if (this.sendBudget >= size) {
			// NOTE: size may be 0. We still create an in-flight entry so ACK processing
			// can validate sequence numbers and prevent duplicate ACK attacks.
			return this._grantSend(size);
		}

		return await new Promise((resolve, reject) => {
			const w = { size, resolve, reject, timer: null };
			if (timeout > 0) {
				// NOTE: timeout starts when the request is made.
				w.timer = setTimeout(() => {
					const idx = this._sendWaiters.indexOf(w);
					if (idx >= 0) {
						this._sendWaiters.splice(idx, 1);
					}
					reject(new TimeoutError('Timed out waiting for send budget'));
				}, timeout);
			}
			this._sendWaiters.push(w);
		});
	}

	/**
	 * Process an ACK for outbound chunks and restore credits.
	 *
	 * Throws ProtocolViolationError on duplicate ACK (ACKing a sequence not
	 * currently in flight).
	 */
	processAck ({ baseSequence, ranges }) {
		if (!Number.isInteger(baseSequence) || baseSequence < 0) {
			throw new RangeError('baseSequence must be a non-negative integer');
		}
		if (!Array.isArray(ranges)) {
			throw new TypeError('ranges must be an array');
		}

		let seq = baseSequence;
		let include = true;
		let releasedBytes = 0;
		let releasedCount = 0;

		for (const q of ranges) {
			if (!Number.isInteger(q) || q < 0 || q > 255) {
				throw new RangeError('range entries must be integers in [0, 255]');
			}
			if (q === 0) {
				include = !include;
				continue;
			}

			if (include) {
				for (let i = 0; i < q; i++) {
					const size = this._sendInFlightBySeq.get(seq);
					if (size === undefined) {
						throw new ProtocolViolationError(
							`Duplicate ACK for sequence ${seq}`,
							{ reason: 'Duplicate ACK' }
						);
					}
					this._sendInFlightBySeq.delete(seq);
					this._sendInFlightBytes -= size;
					releasedBytes += size;
					releasedCount++;
					seq++;
				}
			} else {
				seq += q;
			}
			include = !include;
		}

		this._drainSendWaiters();
		return { releasedBytes, releasedCount };
	}

	_recvRecomputeConsumedMin () {
		let m = null;
		for (const s of this._recvConsumedNotAcked) {
			if (m === null || s < m) {
				m = s;
			}
		}
		this._recvConsumedMin = m;
	}

	/**
	 * Notify the controller that an inbound chunk has arrived.
	 *
	 * Enforces:
	 * - strictly increasing sequence numbers (1,2,3,...)
	 * - maxBufferSize (if non-zero)
	 */
	onReceiveChunk ({ sequence, size }) {
		if (!Number.isInteger(sequence) || sequence <= 0) {
			throw new RangeError('sequence must be a positive integer');
		}
		if (!Number.isInteger(size) || size < 0) {
			throw new RangeError('size must be a non-negative integer');
		}

		if (sequence !== this._recvNextSequence) {
			throw new ProtocolViolationError(
				`Unexpected inbound sequence: got ${sequence}, expected ${this._recvNextSequence}`,
				{ reason: 'Unexpected sequence' }
			);
		}

		if (this.maxBufferSize !== 0 && (this._recvBufferedBytes + size) > this.maxBufferSize) {
			throw new ProtocolViolationError(
				`Inbound buffer overflow: ${this._recvBufferedBytes + size} > ${this.maxBufferSize}`,
				{ reason: 'Buffer overflow' }
			);
		}

		this._recvSizesBySeq.set(sequence, size);
		this._recvBufferedBytes += size;
		this._recvNextSequence++;
	}

	/**
	 * Notify the controller that an inbound chunk has been fully processed.
	 *
	 * Chunks may be consumed out-of-order; the ACK format supports include/skip
	 * ranges for this reason.
	 */
	onConsumeChunk (sequence) {
		if (!Number.isInteger(sequence) || sequence <= 0) {
			throw new RangeError('sequence must be a positive integer');
		}

		const size = this._recvSizesBySeq.get(sequence);
		if (size === undefined) {
			throw new Error(`Unknown inbound sequence ${sequence}`);
		}
		this._recvSizesBySeq.delete(sequence);
		this._recvBufferedBytes -= size;

		this._recvConsumedNotAcked.add(sequence);
		if (this._recvConsumedMin === null || sequence < this._recvConsumedMin) {
			this._recvConsumedMin = sequence;
		}
	}

	get shouldSendAck () {
		if (this._recvConsumedNotAcked.size === 0) {
			return false;
		}
		if (this.maxBufferSize === 0) {
			return true;
		}
		return this._recvBufferedBytes <= this.lowBufferSize;
	}

	/**
	 * Produce and commit an ACK frame description, or null if no ACK should be sent.
	 *
	 * The returned object matches the fields expected by
	 * [`encodeAckHeaderInto()`](src/protocol.esm.js:115).
	 */
	createAck (maxRangeCount = 255) {
		if (!Number.isInteger(maxRangeCount) || maxRangeCount < 0 || maxRangeCount > 255) {
			throw new RangeError('maxRangeCount must be an integer in [0, 255]');
		}
		if (!this.shouldSendAck) {
			return null;
		}
		if (maxRangeCount === 0) {
			return null;
		}

		const seqs = Array.from(this._recvConsumedNotAcked);
		seqs.sort((a, b) => a - b);

		const baseSequence = seqs[0];
		let current = baseSequence;
		let i = 0;
		let include = true;
		const ranges = [];
		let ackedElements = 0;

		while (ranges.length < maxRangeCount && i < seqs.length) {
			if (include) {
				let run = 0;
				while (i < seqs.length && seqs[i] === current) {
					run++;
					i++;
					current++;
				}

				while (run > 0 && ranges.length < maxRangeCount) {
					const q = Math.min(run, 255);
					ranges.push(q);
					ackedElements += q;
					run -= q;
					if (run > 0) {
						if (ranges.length >= maxRangeCount) {
							break;
						}
						ranges.push(0);
					}
				}
				include = false;
			} else {
				const next = seqs[i];
				let gap = next - current;
				if (gap < 0) {
					gap = 0;
				}

				while (gap > 0 && ranges.length < maxRangeCount) {
					const q = Math.min(gap, 255);
					ranges.push(q);
					gap -= q;
					current += q;
					if (gap > 0) {
						if (ranges.length >= maxRangeCount) {
							break;
						}
						ranges.push(0);
					}
				}
				include = true;
			}
		}

		if (ackedElements === 0) {
			return null;
		}

		for (let j = 0; j < ackedElements; j++) {
			this._recvConsumedNotAcked.delete(seqs[j]);
		}
		if (this._recvConsumedNotAcked.size === 0) {
			this._recvConsumedMin = null;
		} else if (this._recvConsumedMin !== null && this._recvConsumedMin === baseSequence) {
			this._recvRecomputeConsumedMin();
		}

		return {
			channelId: this.channelId,
			baseSequence,
			ranges
		};
	}
}

