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

import { Transport } from './base.esm.js';
import { Channel } from '../channel.esm.js';
import { OutputRingBuffer } from '../output-ring-buffer.esm.js';
import { VirtualBuffer, VirtualRWBuffer } from '../virtual-buffer.esm.js';
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	RESERVE_ACK_BYTES, DATA_HEADER_BYTES, FLAG_EOM,
	CHANNEL_TCC, TCC_DTAM_CHAN_RESPONSE,
	decodeAckHeaderFrom, decodeChannelHeaderFrom,
	encAddlToTotal, encodeAckHeaderInto, encodeChannelHeaderInto,
} from '../protocol.esm.js';
import { TaskQueue } from '@task-queue';

export class ByteTransport extends Transport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Handle any post-write actions
		 * (Call from concrete sub-class writeBytes)
		 */
		afterWrite () {
			super.afterWrite();
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Wake a pending reservation if a ring-buffer release enables it
			const { outputBuffer, reserveWaiter } = _thys;
			if (reserveWaiter && outputBuffer.available >= reserveWaiter.size) {
				const resolve = reserveWaiter.resolve;
				_thys.reserveWaiter = null;
				resolve();
			}
		},

		/**
		 * Called when the underlying connection is lost.
		 * Wakes/rejects I/O waiters before calling the base implementation.
		 */
		async onDisconnect () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Wake the read waiter (if any) so the reader loop can exit
			if (_thys.readWaiter) {
				const { reject } = _thys.readWaiter;
				_thys.readWaiter = null;
				reject?.('Disconnected');
			}
			// Wake the reserve waiter (if any)
			if (_thys.reserveWaiter) {
				const { reject } = _thys.reserveWaiter;
				_thys.reserveWaiter = null;
				reject?.('Disconnected');
			}
			// Call base implementation
			await super.onDisconnect();
		},

		/**
		* Receive additional transport input into the VirtualRWBuffer
		* @param {Uint8Array|VirtualBuffer|Uint8Array[]} source
		*/
		receiveBytes (source) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { inputBuffer, readWaiter } = _thys;
			inputBuffer.append(source);

			// If there's a waiter and we have sufficient input, wake them up
			if (readWaiter && inputBuffer.length >= readWaiter.count) {
				const resolve = readWaiter.resolve;
				_thys.readWaiter = null;
				resolve();
			}
		},

		// Wait until there's room for size bytes in the output ring
		/* async */ reservable (size) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');

			const { outputBuffer } = _thys;
			if (outputBuffer.available >= size) return Promise.resolve(); // Requested space is available now

			if (size > outputBuffer.size) throw new RangeError(`Request (${size}) exceeds buffer size (${outputBuffer.size}`);

			const waiter = _thys.reserveWaiter = { size };
			const promise = waiter.promise = new Promise((...r) => [waiter.resolve, waiter.reject] = r);
			return promise;
		},

		/**
		* Figure out when to write our output buffer
		* Handles batching/scheduling, writes in progress, etc.
		* @param {boolean} immediate - Send immediately (if there's any committed output)
		* @returns
		*/
		scheduleWrite (immediate = false) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;
			const committed = outputBuffer.committed;
			if (committed === 0) return; // Nothing to write

			if (!thys.#writeBatchTime || committed >= (immediate ? 1 : thys.#forceWriteBytes)) {
				// Send if immediate-mode, no batch time, or over byte threshold
				if (thys.#writeBatchTimer) {
					clearTimeout(thys.#writeBatchTimer);
					thys.#writeBatchTimer = null;
				}
				_thys.writeBytes();
			} else if (!thys.#writeBatchTimer) {
				// Send when we've waited the maximum batching time
				thys.#writeBatchTimer = setTimeout(() => {
					thys.#writeBatchTimer = null;
					_thys.scheduleWrite(true);
				}, thys.#writeBatchTime);
			}
		},

		/**
		 * Send handshake configuration to remote endpoint
		 * Sends only the greeting + config line (byte stream marker sent later in onRemoteConfig)
		 */
		async sendHandshake () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');

			const { id, c2cSymbol, minChannelId, minMessageTypeId, outputBuffer } = _thys;

			// Prepare configuration object
			const config = {
				transportId: id,
				version: 1,
				c2cEnabled: typeof c2cSymbol === 'symbol',
				minChannelId,
				minMessageTypeId,
			};

			// Calculate size for greeting + config line
			const configJson = JSON.stringify(config);
			const greetConfigLine = GREET_CONFIG_PREFIX + configJson + GREET_CONFIG_SUFFIX;
			const greetConfigSize = greetConfigLine.length * 2; // Still-conservative UTF-8 estimate

			// Check if space is available (handshake is first message, should always fit)
			if (greetConfigSize > outputBuffer.available) {
				throw new Error(`Handshake is too big (${greetConfigSize}) for output buffer (${outputBuffer.available})`);
			}

			// Reserve space for greeting + config line
			const greetReservation = outputBuffer.reserve(greetConfigSize);
			if (!greetReservation) {
				throw new Error('Failed to reserve space for handshake greeting and config');
			}

			// Encode greeting + config line
			const { written } = greetReservation.encodeFrom(greetConfigLine);
			greetReservation.shrink(written);

			// Commit greeting + config line
			outputBuffer.commit();

			// Schedule immediate write
			_thys.scheduleWrite(true);
		},

		/**
		 * Send start of byte stream
		 */
		async startByteStream () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');

			// Deliberately plain ASCII (no length adjustment)
			const start = START_BYTE_STREAM, length = start.length;
			await _thys.reservable(length);

			// Now send the byte stream marker
			const { outputBuffer } = _thys;
			const reservation = outputBuffer.reserve(length);
			reservation.encodeFrom(start);

			// Commit byte stream marker
			outputBuffer.commit();

			// Schedule immediate write
			_thys.scheduleWrite(true);
		},

		// Transport-specific startup
		/* async */ startReader () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			super.startReader(); // Start the byte-stream common reader
			(async () => {
				try {
					// Run our transport-specific reader
					await thys.#byteReader();
				} catch (err) {
					// Disconnected is a condition, as opposed to an error
					if (err instanceof Error) {
						thys.logger.error(err);
					}
				}
			})();
		},

		/**
		 * Transport-specific stop: wait for output buffer to drain, then clear write timer.
		 * Skips drain if transport is in STATE_DISCONNECTED (no connection to drain to).
		 */
		async stop () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Skip drain if disconnected (no connection to drain to)
			if (_thys.state !== Transport.STATE_DISCONNECTED) {
				const { outputBuffer } = _thys;
				// Force any pending committed bytes to be written immediately
				if (outputBuffer.committed) _thys.scheduleWrite(true);
				// Wait until all committed bytes have been sent (output buffer fully drained)
				await _thys.reservable(outputBuffer.size);
			}
			if (thys.#writeBatchTimer) {
				clearTimeout(thys.#writeBatchTimer);
				thys.#writeBatchTimer = null;
			}
		},

		/**
		 * Write bytes from output buffer to underlying transport
		 * Abstract method - must be implemented by subclasses
		 */
		/* async */ writeBytes () {
			thys.logger.error('writeBytes() must be implemented by subclass');
			return Promise.reject(new Error('writeBytes() must be implemented by subclass'));
		}
	}, super.__protected));

	#_; // ByteTransport-level view of shared protected state
	#forceWriteBytes;
	#writeBatchTime;
	#writeBatchTimer = null;

	/**
	 * Base class of hierarchy for byte-stream transports
	 * @param {object} options 
	 * @param {number} options.forceWriteBytes - Number of committed bytes that forces immediate write
	 * @param {number} options.writeBatchTime - Time to wait (in msec) for more bytes to arrive before writing
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		this.#forceWriteBytes = options.forceWriteBytes ?? 16 * 1024;
		this.#writeBatchTime = options.writeBatchTime ?? 5; // msec
		Object.assign(this.#_, {
			inputBuffer: new VirtualRWBuffer(),
			outputBuffer: new OutputRingBuffer(options.outputBufferSize),
			writeQueue: new TaskQueue(),
		});
	}

	/**
	 * Byte-stream transport reader task
	 * Handles:
	 * - Line-based greeting + configuration and switch-to-byte-stream
	 * - Byte-stream-based ACK and channel messages
	 */
	async #byteReader () {
		const _thys = this.#_;
		const { bufferPool, inputBuffer } = _thys;
		const newLine = 10, stx = 2;
		const transportActive = () => {
			const state = _thys.state;
			return state !== Transport.STATE_STOPPED && state !== Transport.STATE_DISCONNECTED;
		};
		let firstConfig = true;
		let offset = 0;

		// Line-based config/handshake loop
		while (transportActive()) {
			if (offset === inputBuffer.length) {
				await this.#readable(offset + 1);
			}

			const nextByte = inputBuffer.getUint8(offset);

			if (nextByte === stx && offset > 0) {
				const line = inputBuffer.decode({ end: offset });
				inputBuffer.release(offset);
				offset = 0;
				await this.dispatchEvent('outOfBandData', { data: line });
				continue;
			}

			if (nextByte === newLine) {
				const line = inputBuffer.decode({ end: ++offset });
				inputBuffer.release(offset);
				offset = 0;

				if (line === START_BYTE_STREAM) break;
				if (line.startsWith(GREET_CONFIG_PREFIX) && line.endsWith(GREET_CONFIG_SUFFIX) && firstConfig) {
					try {
						const config = JSON.parse(line.slice(GREET_CONFIG_PREFIX.length, -GREET_CONFIG_SUFFIX.length));
						firstConfig = false;
						await _thys.onRemoteConfig(config);
					} catch (_) { /**/ }
				} else {
					await this.dispatchEvent('outOfBandData', { data: line });
				}
				continue;
			}

			++offset;
		}

		// Byte-stream-based message loop
		while (transportActive()) {
			// Read a message header
			if (inputBuffer.length < 2) {
				await this.#readable(2);
			}
			const type = inputBuffer.getUint8(0);
			const encAddl = inputBuffer.getUint8(1);
			const totalHeaderSize = encAddlToTotal(encAddl);
			if (inputBuffer.length < totalHeaderSize) {
				await this.#readable(totalHeaderSize);
			}

			let header;
			let data = null;

			switch (type) {
			case HDR_TYPE_ACK:
				header = decodeAckHeaderFrom(inputBuffer);
				break;
			case HDR_TYPE_CHAN_CONTROL:
			case HDR_TYPE_CHAN_DATA:
				header = decodeChannelHeaderFrom(inputBuffer);
				break;
			default:
				this.logger.error(`Unknown PolyTransport header type ${type}`);
				await this.stop();
				continue;
			}

			inputBuffer.release(totalHeaderSize, bufferPool);
			const dataSize = header.dataSize ?? 0;
			if (dataSize > 0) {
				if (dataSize > inputBuffer.length) {
					await this.#readable(dataSize);
				}
				data = inputBuffer.slice(0, dataSize).toPool(bufferPool);
				inputBuffer.release(dataSize, bufferPool);
			}

			_thys.receiveMessage(header, data);
			if (header.channelId === CHANNEL_TCC && header.messageType === TCC_DTAM_CHAN_RESPONSE[0]) {
				// Yield to the next macrotask when potentially adding alternate channel IDs
				// in case there's imminent pending traffic on the new ID
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
	}

	/*
	 * Wait until count bytes of input are available for reading
	 * @param {number} count - The number of bytes required
	 */
	#readable (count) {
		const _thys = this.#_;
		const { inputBuffer } = _thys;
		if (inputBuffer.length >= count) return; // Already available

		// Wait on the necessary additional bytes
		const waiter = { count };
		const promise = new Promise((...r) => [ waiter.resolve, waiter.reject] = r);
		_thys.readWaiter = waiter;
		return promise;
	}

	/**
	 * Send an ACK message (not associated with a data message)
	 * @param {symbol} token - The channel ID token
	 * @param {ChannelFlowControl} flowControl - Associated channel flow control
	 * @returns {Promise}
	 */
	/* async */ sendAckMessage (token, flowControl) {
		const _thys = this.#_;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			return Promise.reject(new Error('Unauthorized'));
		}
		const task = _thys.writeQueue.add(() => this.#sendAckMessage(channel.id, flowControl));
		return task;
	}

	/**
	 * Send an ACK message (private internal)
	 * @param {number} channelId - The channel ID
	 * @param {ChannelFlowControl} flowControl - Associated channel flow control
	 * @returns {Promise}
	 */
	async #sendAckMessage (channelId, flowControl) {
		const _thys = this.#_;
		const { outputBuffer } = _thys;
		// Wait until we're able to reserve space for a max-size ACK header
		await _thys.reservable(RESERVE_ACK_BYTES);
		const ackBuffer = outputBuffer.reserve(RESERVE_ACK_BYTES);
		if (!ackBuffer) throw new Error('Insufficient pre-reservation');
		const { base, ranges } = flowControl.getAckInfo();
		// console.log('sendAckMessage', base, ranges);
		if (base !== undefined) {
			const headerSize = encodeAckHeaderInto(ackBuffer, 0, { channelId, baseSequence: base, ranges });
			ackBuffer.shrink(headerSize);
		} else {
			// Nothing to ACK; cancel reservation
			ackBuffer.shrink(0);
		}
		outputBuffer.commit();
		if (base !== undefined) {
			flowControl.clearReadAckInfo(base, ranges);
			_thys.scheduleWrite();
		}
	}

	/**
	 * Send a control or data message (optionally with byte data)
	 * @param {symbol} token - The channel ID token
	 * @param {ChannelFlowControl} flowControl - The channel flow controller
	 * @param {Object} header - The message header
	 * @param {Object} chunker - The chunking-strategy control-object
	 * @param {number|null} chunker.bufferSize - Buffer size to request for next chunk (or null for UTF-16 text slices); depends on bytesToReserve()
	 * @param {number} chunker.bytesToReserve() - Total max header + data bytes to reserve for chunk
	 * @param {function} chunker.nextChunk() - Returns the next slice of UTF-16 text
	 * @param {function} chunker.nextChunk(buffer) - Fills the supplied buffer with the next chunk's Uint8 data; returns buffer
	 * @param {number} chunker.remaining - Bytes remaining to write (before or) after most recent nextChunk
	 * @param {boolean} eom - Whether to add EOM_FLAG when remaining (after nextChunk) <= 0
	 * @returns {Promise<number>} - Resolves to number of bytes remaining to send
	 */
	async sendChunk (token, flowControl, header, chunker, { eom } = {}) {
		const _thys = this.#_;
		const { outputBuffer, writeQueue } = _thys;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			return Promise.reject(new Error('Unauthorized'));
		}
		const channelId = channel.id;
		const taskResult = writeQueue.add(async () => {
			const { type = HDR_TYPE_CHAN_DATA, flags = 0, messageType = 0 } = header;
			const bytesToReserve = chunker.bytesToReserve(), dataSize = chunker.bufferSize;
			await _thys.reservable(bytesToReserve);
			const chunkBuffer = outputBuffer.reserve(bytesToReserve);
			if (!chunkBuffer) throw new Error('Insufficient pre-reservation');
			const sequence = flowControl.nextWriteSeq;
			const finalHeader = {
				type, dataSize, flags, channelId, sequence, messageType
			};
			if (dataSize) {
				const dataBuffer = chunkBuffer.slice(DATA_HEADER_BYTES);
				chunker.nextChunk(dataBuffer);
				const finalDataSize = dataBuffer.length;
				finalHeader.dataSize = finalDataSize;
				chunkBuffer.shrink(DATA_HEADER_BYTES + finalDataSize);
			}
			// Add EOM flag on final chunk header when indicated
			if (eom && chunker.remaining <= 0) finalHeader.flags |= FLAG_EOM;
			encodeChannelHeaderInto(chunkBuffer, 0, type, finalHeader);
			const numBytesSent = chunkBuffer.length;
			outputBuffer.commit();
			flowControl.sent(numBytesSent);
			// console.log(`(${this.role}) committed chunk`, finalHeader);
			_thys.scheduleWrite();
			return chunker.remaining;
		});
		return await taskResult;
	}

	/**
	 * Subscribe to protected state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
