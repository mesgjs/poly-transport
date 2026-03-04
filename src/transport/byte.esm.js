/*
 * Byte-Stream-Based Transport Class
 *
 * Features (input):
 * - Buffer-byte-stream-to-message
 * Features (output):
 * - Ring-buffer management
 * - String-to-bytes text encoding
 * - Write-scheduling/batching
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { OutputRingBuffer } from '../output-ring-bffer.esm.js';
import { Transport } from './base.esm.js';
import { VirtualRWBuffer } from '../virtual-buffer.esm.js';
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	decodeAckHeaderFrom, decodeChannelHeaderFrom, encAddlToTotal
} from '../protocol.esm.js';

export class ByteTransport extends Transport {
	#state; // Constructor-threaded private state
	#autoWriteBytes;
	#autoWriteTime;

	constructor (options = {}) {
		super(options);
		this._getState();
		const state = this.#state;
		this.#autoWriteBytes = options.autoWriteBytes ?? 16 * 1024;
		this.#autoWriteTime = options.autoWriteTime ?? 5; // msec
	}

	/**
	 * Byte-stream transport reader task
	 * Handles:
	 * - Line-based greeting + configuration and switch-to-byte-stream
	 * - Byte-stream-based ACK and channel messages
	 */
	async #byteReader () {
		const state = this.#state;
		const input = state.inputBuffer;
		const newLine = 10, stx = 2;
		let firstConfig = true;
		let offset = 0;

		// Line-based config/handshake loop
		while (!state.stopped) {
			if (offset === input.length) {
				await this.#readable(offset + 1);
			}

			const nextByte = input.getUint8(offset);

			if (nextByte === stx && offset > 0) {
				const line = input.decode({ end: offset });
				input.release(offset);
				offset = 0;
				await this.dispatchEvent('outOfBandData', { data: line });
				continue;
			}

			if (nextByte === newLine) {
				const line = input.decode({ end: offset });
				input.release(offset);
				offset = 0;

				if (line === START_BYTE_STREAM) break;
				if (line.startswith(GREET_CONFIG_PREFIX) && line.endsWith(GREET_CONFIG_SUFFIX) && firstConfig) {
					try {
						const config = JSON.parse(line.slice(GREET_CONFIG_PREFIX.length, -GREET_CONFIG_SUFFIX.length));
						firstConfig = false;
						await this.onRemoteConfig(state, config);
					} catch (_e) { /**/ }
				} else {
					await this.dispatchEvent('outOfBandData', { data: line });
				}
				continue;
			}

			++offset;
		}

		// Byte-stream-based message loop
		while (!state.stopped) {
			// Read a message header
			if (input.length < 2) {
				await this.#readable(2);
			}
			const type = input.getUint8(0);
			const encAddl = input.getUint8(1);
			const totalHeaderSize = encAddlToTotal(encAddl);
			if (input.length < totalHeaderSize) {
				await this.#readable(totalHeaderSize);
			}

			let header;
			let data = null;

			switch (type) {
			case HDR_TYPE_ACK:
				header = decodeAckHeaderFrom(input);
				break;
			case HDR_TYPE_CHAN_CONTROL:
			case HDR_TYPE_CHAN_DATA:
				header = decodeChannelHeaderFrom(input);
				break;
			default:
				await this.dispatchEvent('protocolViolation', {
					type: 'unknownHeaderType',
					description: `Unknown header type ${type}`,
					headerType: type,
				});
				await this.stop();
				continue;
			}

			input.release(totalHeaderSize, state.pool);
			const dataSize = header.dataSize ?? 0;
			if (dataSize > 0 && !state.stopped) {
				if (dataSize > input.length) {
					await this.#readable(dataSize);
				}
				data = input.slice(0, dataSize).toPool(state.pool);
				input.release(dataSize, state.pool);
			}

			this.receiveMessage(state, header, data);
		}
	}

	/*
	 * Wait until count bytes of input are available for reading
	 * @param {number} count - The number of bytes required
	 */
	#readable (count) {
		const state = this.#state;
		const input = state.inputBuffer;
		if (input.length >= count) return; // Already available
		
		// Wait on the necessary additional bytes
		const waiter = { count };
		const promise = new Promise((resolve) => waiter.resolve = resolve);
		state.readWaiter = waiter;
		return promise;
	}

	/**
	 * Receive additional transport input into the VirtualRWBuffer
	 * @param {Uint8Array|VirtualBuffer|Array<{buffer: Uint8Array, offset: number, length: number}>} source
	 * @param {number} offset - Starting offset (only used if source is Uint8Array)
	 * @param {number} length - Length (only used if source is Uint8Array)
	 */
	receiveBytes (state, source, offset = 0, length = undefined) {
		if (state !== this.#state) {
			throw new Error('Unauthorized receiveBytes');
		}
		const input = state.inputBuffer.
		input.append(source, offset, length);
		
		// If there's a waiter and we have sufficient input, wake them up
		const waiter = state.readWaiter;
		if (waiter && input.length >= waiter.count) {
			state.readWaiter = null;
			waiter.resolve();
		}
	}

	/**
	 * Figure out when to write our output buffer
	 * Handles batching/scheduling, writes in progress, etc.
	 * @param {Object} state - Private state (for authorization)
	 * @param {boolean} now - Send immediately (if there's any committed output)
	 * @returns
	 */
	async scheduleWrite (state, now = false) {
		if (state !== this.#state) {
			throw new Error('Unauthorized scheduleWrite');
		}
		const { autoWriteBytes: bytes, autoWriteType: time, outputBuffer: buffer } = state;
		const committed = buffer.committed;
		if (committed === 0 || state.writing) {
			return; // Nothing to write, or writing in progress
		}
		if (committed >= (now ? 1 : bytes)) {
			// Send if forced or over byte threshold
			if (state.writeTimer) {
				clearTimeout(state.writeTimer);
				state.writeTimer = null;
			}
			state.writing = true;
			try {
				await this.writeBytes(state);
			}
			finally {
				state.writing = false;
			}
		} else if (Number.isInteger(time) && !state.writeTimer) {
			// Send when we've waited the maximum batching time
			state.writeTimer = setTimeout(() => this.scheduleWrite(state, true), time);
		}
	}

	/**
	 * Send a message (byte-stream version)
	 * @param {symbol} token
	 * @param {Object} header
	 * @param {*} data
	 */
	async sendMessage (token, header, data) {
		const state = this.#state;
		const channel = state.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized sendMessage');
		}
		// TO DO:
		// Encode data
		// writeBytes
	}

	/**
	 * Transport-specific startup - start the byte-stream reader
	 * @param {*} state
	 */
	_start (state) {
		if (state !== this.#state) {
			throw new Error('Unauthorized _start');
		}
		state.readerTimer = setTimeout(() => this.#byteReader(), 0);
	}

	/**
	 * Subscribe to private state
	 * @param {Set} subs - Subscribers Set
	 */
	_subState (subs) {
		super._subState(subs);
		subs.add((s) => this.#state ||= s); // Set #state once
	}

	/**
	 * Sub-classes must override this method to actually get the output buffer(s) and write the bytes
	 * @abstract
	 * @param {Object} _state - Private state (used for authentication)
	 */
	/* async */ writeBytes (_state) {
		throw new Error('byteTransport.writeBytes implementation is missing')
	}
}
