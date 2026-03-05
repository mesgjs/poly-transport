/*
 * postMessage-Based (Worker, Window) Transport Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { ObjectTransport } from './object.esm.js';
import {
	// GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	MAX_DATA_HEADER_BYTES, PROTOCOL,
	ackHeaderSize,
} from '../protocol.esm.js';

export class PostMessageTransport extends ObjectTransport {
	#state;
	#bufferPool;
	#gateway;

	/**
	 * @param {Object} options 
	 * @param {Object} options.gateway - Gateway (sending/receiving) object
	 */
	constructor (options = {}) {
		super(options);
		this._getState();
		const { bufferPool, gateway } = options;
		this.#bufferPool = bufferPool;
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
		const byteBuffers = this.#bufferPool.acquireSet(size).map((buffer) => new Uint8Array(buffer));
		const virtual = new VirtualRWBuffer(byteBuffers);
		virtual.shrink(size);
		return virtual;
	}

	/**
	 * Receive a message on a gateway message event
	 * @param {Event} event 
	 */
	#onMessage (event) {
		const state = this.#state, message = event?.data, proto = message?.protocol;
		if (proto === PROTOCOL) {
			const { header, data: rawData } = message, type = header?.type;
			switch (type) {
			case HDR_TYPE_ACK:
			{
				const ranges = header?.ranges || [], rangeSize = ranges?.length || 0;
				header.headerSize = ackHeaderSize(rangeSize);
				header.dataSize = 0;
				this.receiveMessage(state, header);
				break;
			}
			case HDR_TYPE_CHAN_CONTROL:
			case HDR_TYPE_CHAN_DATA:
			{
				header.headerSize = MAX_DATA_HEADER_BYTES;
				const data = (() => {
					if (typeof rawData === 'string') return rawData;
					if (rawData) return new VirtualBuffer(rawData);
				})();
				header.dataSize = (() => {
					if (typeof data === 'string') return data.length() * 2;
					if (data instanceof VirtualBuffer) return data.length;
					return 0;
				})();
				this.receiveMessage(state, header, data);
				break;
			}
			}
		}
	}

	/**
	 * Send an ACK message
	 * @param {symbol} token - The channel ID token
	 * @param {number} baseSequence - The base sequence number to ACK
	 * @param {number[]} ranges - Optional addition sequence ranges to ACK
	 */
	sendAckMessage (token, baseSequence, ranges) {
		const state = this.#state;
		const channel = state.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized sendByteMessage');
		}
		const header = {
			type: HDR_TYPE_ACK. baseSequence, ranges
		};
		this.#gateway.postMessage({ protocol: PROTOCOL, header });
	}

	/**
	 * Send a control or data message (optionally with byte data)
	 * @param {symbol} token - The channel ID token
	 * @param {Object} header - The message header
	 * @param {Function} loader - The data-loader function: loader(buffer)
	 */
	sendByteMessage (token, header, loader) {
		const state = this.#state;
		const channel = state.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized sendByteMessage');
		}
		const buffer = this.#getPoolVRWB(header.dataSize);
		if (buffer) loader(buffer);
		const { type = HDR_TYPE_CHAN_DATA, flags = 0, sequence, messageType = 0 } = header;
		const finalHeader = {
			type, flags, channelId: channel.ids[0], sequence, messageType
		};
		const transfer = buffer ? buffer.segments.map((buffer) => buffer.buffer) : [];
		this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data: buffer?.segments }, transfer);
	}

	/**
	 * Send a control or data message with UTF-16 textual (string) data
	 * @param {symbol} token - The channel ID token
	 * @param {Object} header - The message header
	 * @param {string} data
	 */
	sendTextMessage (token, header, data) {
		const state = this.#state;
		const channel = state.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized sendByteMessage');
		}
		const { type = HDR_TYPE_CHAN_DATA, flags = 0, sequence, messageType = 0 } = header;
		const finalHeader = {
			type, flags, channelId: channel.ids[0], sequence, messageType
		};
		this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data });
	}

	/*
	 * Subscribe to private state
	 * @param {Set} subs - Set of subscription setter functions
	 */
	_subState (subs) {
		super._subState(subs);
		subs.add((s) => this.#state ||= s); // Set #state once
	}
}