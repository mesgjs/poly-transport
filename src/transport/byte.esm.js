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
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	RESERVE_ACK_BYTES, DATA_HEADER_BYTES,
	decodeAckHeaderFrom, decodeChannelHeaderFrom,
	encAddlToTotal, encodeAckHeaderInto, encodeChannelHeaderInto,
} from '../protocol.esm.js';
import { TaskQueue } from '@task-queue';

export class ByteTransport extends Transport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Handle any post-write actions
		 */
		afterWrite () {
			super.afterWrite();
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Wake a pending reservation if a ring-buffer release enables it
			const { outputBuffer, reserveWaiter } = _thys;
			if (reserveWaiter && outputBuffer.available >= reserveWaiter.size) reserveWaiter.resolve();
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
			if (readWaiter && inputBuffer.length >= readWaiter.count) readWaiter.resolve();
		},

		// Wait until there's room for size bytes in the output ring
		/* async */ reservable (size) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;
			if (outputBuffer.available >= size) return; // Requested space is available now
			if (size > outputBuffer.size) throw new RangeError(`Request (${size}) exceeds buffer size (${outputBuffer.size}`);
			const waiter = _thys.reserveWaiter = { size };
			const promise = new Promise((r) => waiter.resolve = r);
			promise.then(() => _thys.reserveWaiter = null);
			return promise;
		},

		/**
		* Figure out when to write our output buffer
		* Handles batching/scheduling, writes in progress, etc.
		* @param {boolean} now - Send immediately (if there's any committed output)
		* @returns
		*/
		scheduleWrite (now = false) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { autoWriteBytes, autoWriteTime, outputBuffer } = _thys;
			const committed = outputBuffer.committed;
			if (committed === 0 || _thys.writing) {
				return; // Nothing to write, or writing in progress
			}
			if (committed >= (now ? 1 : autoWriteBytes)) {
				// Send if forced or over byte threshold
				if (_thys.writeTimer) {
					clearTimeout(_thys.writeTimer);
					_thys.writeTimer = null;
				}
				_thys.writeBytes();
			} else if (Number.isInteger(autoWriteTime) && !_thys.writeTimer) {
				// Send when we've waited the maximum batching time
				_thys.writeTimer = setTimeout(() => _thys.scheduleWrite(true), autoWriteTime);
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

		// Transport-specific startup - start the byte-stream reader
		startReader () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			super.startReader();
			_thys.readerTimer = setTimeout(() => thys.#byteReader(), 0);
		}
	}, super.__protected));

	#_; // ByteTransport-level view of shared protected state
	#autoWriteBytes;
	#autoWriteTime;

	constructor (options = {}) {
		super(options);
		this._get_();
		this.#autoWriteBytes = options.autoWriteBytes ?? 16 * 1024;
		this.#autoWriteTime = options.autoWriteTime ?? 5; // msec
		Object.assign(_thys, {
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
		let firstConfig = true;
		let offset = 0;

		// Line-based config/handshake loop
		while (!_thys.stopped) {
			if (offset === inputBuffer.length) {
				await this.#readable(offset + 1);
			}

			const nextByte = inputBuffer.getUint8(offset);

			if (nextByte === stx && offset > 0) {
				const line = inputBuffer.decode({ end: offset });
				input.release(offset);
				offset = 0;
				await this.dispatchEvent('outOfBandData', { data: line });
				continue;
			}

			if (nextByte === newLine) {
				const line = inputBuffer.decode({ end: offset });
				inputBuffer.release(offset);
				offset = 0;

				if (line === START_BYTE_STREAM) break;
				if (line.startswith(GREET_CONFIG_PREFIX) && line.endsWith(GREET_CONFIG_SUFFIX) && firstConfig) {
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
		while (_thys.status != Transport.STATUS_STOPPED) {
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
				await this.dispatchEvent('protocolViolation', {
					type: 'unknownHeaderType',
					description: `Unknown header type ${type}`,
					headerType: type,
				});
				await this.stop();
				continue;
			}

			inputBuffer.release(totalHeaderSize, bufferPool);
			const dataSize = header.dataSize ?? 0;
			if (dataSize > 0 && !state.stopped) {
				if (dataSize > inputBuffer.length) {
					await this.#readable(dataSize);
				}
				data = inputBuffer.slice(0, dataSize).toPool(bufferPool);
				inputBuffer.release(dataSize, bufferPool);
			}

			_thys.receiveMessage(header, data);
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
		const promise = new Promise((resolve) => waiter.resolve = resolve);
		_thys.readWaiter = waiter;
		promise.then(() => _thys.readWaiter = null);
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
			throw new Error('Unauthorized');
		}
		// Don't queue more ACKs if they're already pending
		if (flowControl.ackPending) return;
		flowControl.ackPending = true;
		const { writeQueue } = _thys;
		const task = writeQueue.add(async () => {
			await _thys.reservable(RESERVE_ACK_BYTES);
			this.#sendAckMessage(channel.id, flowControl);
		});
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
		const { outputBuffer, writeQueue } = _thys;
		// Wait until we're able to reserve space for a max-size ACK header
		const vrwb = outputBuffer.reserve(RESERVE_ACK_BYTES);
		if (!vrwb) throw new Error('Insufficient pre-reservation');
		const { base, ranges, complete } = flowControl.getAckInfo();
		if (base !== undefined) {
			const headerSize = encodeAckHeaderInto(vrwb, 0, { channelId, baseSequence: base, ranges });
			vrwb.shrink(headerSize);
		} else {
			// Nothing to ACK; cancel reservation
			vrwb.shrink(0);
		}
		outputBuffer.commit();
		flowControl.clearReadAckInfo(base, ranges);
		_thys.scheduleWrite();
		if (complete) {
			// All currently ready ACKs have been written
			flowControl.ackPending = false;
		} else {
			// Queue a request to process more ACKs
			writeQueue.add(async () => {
				await _thys.reservable(RESERVE_ACK_BYTES);
				this.#sendAckMessage(channelId, flowControl);
			});
		}
	}

	/**
	 * Send a control or data message (optionally with byte data)
	 * @param {symbol} token - The channel ID token
	 * @param {Object} header - The message header
	 * @param {function} loader - The data-loader function: loader(buffer)
	 * @param {ChannelFlowControl} flowControl - Associated channel flow control
	 */
	sendByteMessage (token, header, loader, flowControl) {
		const _thys = this.#_;
		const { outputBuffer, writeQueue } = _thys;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized');
		}
		const channelId = channel.id;
		const task = writeQueue.add(async () => {
			const { type = HDR_TYPE_CHAN_DATA, flags = 0, sequence, messageType = 0, dataSize = 0 } = header;
			const ackPending = flowControl.ackPending, ackBytes = ackPending ? 0 : RESERVE_ACK_BYTES;
			const maxSize = ackBytes + DATA_HEADER_BYTES + dataSize;
			await _thys.reservable(maxSize);
			if (!ackPending) this.#sendAckMessage(channelId, flowControl);
			const messageSize = DATA_HEADER_BYTES + dataSize;
			const message = outputBuffer.reserve(messageSize);
			if (!message) throw new Error('Insufficient pre-reservation');
			const finalHeader = {
				type, dataSize, flags, channelId, sequence, messageType
			};
			if (dataSize) {
				const data = message.slice(DATA_HEADER_BYTES);
				loader(data);
				const length = data.length;
				finalHeader.dataSize = length;
				message.shrink(DATA_HEADER_BYTES + length);
			}
			encodeChannelHeaderInto(message);
			outputBuffer.commit();
			_thys.scheduleWrite();
		});
		return task;
	}

	/**
	 * Subscribe to private state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
