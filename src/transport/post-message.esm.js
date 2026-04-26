/*
 * postMessage-Based (Worker, Window) Transport Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { Transport } from './base.esm.js';
import {
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	HDR_TYPE_HANDSHAKE, HDR_TYPE_READY,
	DATA_HEADER_BYTES, FLAG_EOM, PROTOCOL, CHANNEL_TCC, TCC_DTAM_CHAN_RESPONSE,
	ackHeaderSize,
} from '../protocol.esm.js';
import { VirtualBuffer, VirtualRWBuffer } from '../virtual-buffer.esm.js';
import { TaskQueue } from '@task-queue';

export class PostMessageTransport extends Transport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Send handshake configuration to remote endpoint
		 * @returns {Promise<void>}
		 */
		sendHandshake () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');

			// Prepare configuration object
			const { id, c2cSymbol, minChannelId, minMessageTypeId } = _thys;
			const config = {
				transportId: id,
				version: 1,
				c2cEnabled: typeof c2cSymbol === 'symbol',
				minChannelId,
				minMessageTypeId,
			};

			// Send handshake as structured object via postMessage
			thys.#gateway.postMessage({
				protocol: PROTOCOL,
				header: { type: HDR_TYPE_HANDSHAKE },
				data: config
			});
		},

		/*
		 * Notify remote to start message-mode.
		 * Called by base #_.onRemoteConfig.
		 */
		startMessageMode() {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');

			thys.#gateway.postMessage({
				protocol: PROTOCOL,
				header: { type: HDR_TYPE_READY }
			});
		}
	}, super.__protected));

	#_;
	#gateway;
	#receiveQueue = new TaskQueue();

	/**
	 * @param {Object} options 
	 * @param {Object} options.gateway - Gateway (sending/receiving) object
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		const { gateway } = options;
		this.#gateway = gateway;
		// gateway object:
		// - Listen for message events to receive
		// - postMessage to send
		gateway.addEventListener('message', (event) => this.#onMessage(event));
	}

	/**
	 * Assemble a VirtualRWBuffer of the requested size from the buffer pool
	 * @param {number} size - The required size in bytes
	 * @returns {VirtualRWBuffer}
	 */
	#getPoolVRWB (size) {
		if (!Number.isInteger(size) || size <= 0) return null;
		const { bufferPool } = this.#_;
		const byteBuffers = bufferPool ? bufferPool.acquireSet(size).map((buffer) => new Uint8Array(buffer)) : [new Uint8Array(size)];
		const virtual = new VirtualRWBuffer(byteBuffers);
		virtual.shrink(size);
		return virtual;
	}

	// postMessage can send string data without encoding
	get needsEncodedText () { return false; }

	/**
	 * Receive a message on a gateway message event
	 * @param {Event} event 
	 */
	#onMessage (event) {
		const _thys = this.#_, queue = this.#receiveQueue;
		const message = event?.data, proto = message?.protocol;
		if (proto !== PROTOCOL) return;
		const { header, data: rawData } = message, type = header?.type;
		switch (type) {
		case HDR_TYPE_HANDSHAKE:
		{
			// Process handshake configuration from remote endpoint
			const config = rawData;
			if (config && typeof config === 'object') {
				_thys.onRemoteConfig(config);
			}
			break;
		}
		case HDR_TYPE_READY:
			if (this.role != null) {
				_thys.onRemoteReady();
			} else {
				this.logger.error(`${this.constructor.name} ${this.idTail}: Received ready but not configuration`);
				this.stop();
			}
			break;
		case HDR_TYPE_ACK:
		{
			const ranges = header?.ranges || [], rangeSize = ranges?.length || 0;
			header.headerSize = ackHeaderSize(rangeSize);
			header.dataSize = 0;
			queue.add(() => _thys.receiveMessage(header));
			break;
		}
		case HDR_TYPE_CHAN_CONTROL:
		case HDR_TYPE_CHAN_DATA:
		{
			header.headerSize = DATA_HEADER_BYTES;
			const data = (() => {
				if (typeof rawData === 'string') return rawData;
				if (rawData) return new VirtualBuffer(rawData);
			})();
			header.dataSize = (() => {
				if (typeof data === 'string') return data.length * 2;
				if (data instanceof VirtualBuffer) return data.length;
				return 0;
			})();
			queue.add(async () => {
				_thys.receiveMessage(header, data);
				if (header.channelId === CHANNEL_TCC && header.messageType === TCC_DTAM_CHAN_RESPONSE[0]) {
					// Process potential channel ID additions synchronously in case of imminent reference
					const tcc = _thys.channels.get(0);
					await tcc.allDataProcessed();
				}
			});
			break;
		}
		}
	}

	/**
	 * Send an ACK message by itself
	 * @param {symbol} token - The channel ID token
	 * @param {ChannelFlowControl} flowControl - The associated channel flow control
	 * @returns {Promise<void>}
	 */
	/* async */ sendAckMessage (token, flowControl) {
		const _thys = this.#_;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			return Promise.reject(new Error('Unauthorized'));
		}
		this.#sendAckMessage(channel.id, flowControl);
		_thys.afterWrite(); // (no deferred write)
		return Promise.resolve();
	}

	/**
	 * Send an ACK message (private internal)
	 * @param {number} channelId - The channel ID
	 * @param {ChannelFlowControl} flowControl - The associatec channel flow control
	 */
	#sendAckMessage (channelId, flowControl) {
		const { base, ranges } = flowControl.getAckInfo();
		if (base === undefined) return;
		const header = {
			type: HDR_TYPE_ACK, channelId, baseSequence: base, ranges
		};
		this.#gateway.postMessage({ protocol: PROTOCOL, header });
		flowControl.clearReadAckInfo(base, ranges);
		// (caller is responsible for afterWrite)
	}

	/**
	 * Send a control or data message (optionally with byte data)
	 * @param {symbol} token - The channel ID token
	 * @param {ChannelFlowControl} flowControl - The channel flow controller
	 * @param {Object} header - The message header
	 * @param {Object} chunker - The chunking-strategy control-object
	 * @param {boolean} [eom] - Whether to add EOM flag when remaining <= 0
	 * @returns {Promise<number>} Resolves to number of bytes remaining to send
	 */
	/* async */ sendChunk (token, flowControl, header, chunker, { eom } = {}) {
		const _thys = this.#_;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			return Promise.reject(new Error('Unauthorized'));
		}
		const numBytesSent = chunker.bytesToReserve();
		const bufferSize = chunker.bufferSize;
		const { type = HDR_TYPE_CHAN_DATA, flags = 0, messageType = 0 } = header;
		const sequence = flowControl.nextWriteSeq;
		const channelId = channel.id, finalHeader = {
			type, flags, channelId, sequence, messageType
		};

		if (bufferSize === null) { // Sending UTF-16 string data
			const data = chunker.nextChunk();
			if (eom && chunker.remaining <= 0) finalHeader.flags |= FLAG_EOM;
			this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data });
		} else { // Sending byte data (or none at all)
			const buffer = this.#getPoolVRWB(bufferSize);
			if (buffer) chunker.nextChunk(buffer);
			const transfer = buffer ? buffer.segments.map((buffer) => buffer.buffer) : [];
			if (eom && chunker.remaining <= 0) finalHeader.flags |= FLAG_EOM;
			this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data: buffer?.segments }, transfer);
		}
		flowControl.sent(numBytesSent);
		// console.log(`(${this.role}) committed chunk`, finalHeader);
		_thys.afterWrite(); // (no deferred write)
		return Promise.resolve(chunker.remaining);
	}

	/*
	 * Subscribe to private state
	 * @param {Set} subs - Set of subscription setter functions
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
