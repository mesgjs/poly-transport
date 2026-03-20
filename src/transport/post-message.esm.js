/*
 * postMessage-Based (Worker, Window) Transport Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { Transport } from './base.esm.js';
import {
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA, HDR_TYPE_HANDSHAKE,
	DATA_HEADER_BYTES, PROTOCOL,
	ackHeaderSize,
} from '../protocol.esm.js';

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
				header: {
					type: HDR_TYPE_HANDSHAKE
				},
				data: config
			});
		}
	}, super.__protected));

	#_;
	#gateway;

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
		const byteBuffers = bufferPool.acquireSet(size).map((buffer) => new Uint8Array(buffer));
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
		const _thys = this.#_;
		const message = event?.data, proto = message?.protocol;
		if (proto === PROTOCOL) {
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
			case HDR_TYPE_ACK:
			{
				const ranges = header?.ranges || [], rangeSize = ranges?.length || 0;
				header.headerSize = ackHeaderSize(rangeSize);
				header.dataSize = 0;
				_thys.receiveMessage(header);
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
					if (typeof data === 'string') return data.length() * 2;
					if (data instanceof VirtualBuffer) return data.length;
					return 0;
				})();
				_thys.receiveMessage(header, data);
				break;
			}
			}
		}
	}
	/**
	 * Send an ACK message by itself
	 * @param {symbol} token - The channel ID token
	 * @param {ChannelFlowControl} flowControl - The associatec channel flow control
	 */
	sendAckMessage (token, flowControl) {
		const _thys = this.#_;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized');
		}
		this.#sendAckMessage(channel.id, flowControl);
		_thys.afterWrite(); // (no deferred write)
	}

	/**
	 * Send an ACK message (private internal)
	 * @param {number} channelId - The channel ID
	 * @param {ChannelFlowControl} flowControl - The associatec channel flow control
	 */
	#sendAckMessage (channelId, flowControl) {
		for (;;) {
			const { base, ranges } = flowControl.getAckInfo();
			if (base === undefined) return;
			const header = {
				type: HDR_TYPE_ACK, channelId, baseSequence: base, ranges
			};
			this.#gateway.postMessage({ protocol: PROTOCOL, header });
			// (caller is responsible for afterWrite)
		}
	}

	/**
	 * Send a control or data message (optionally with byte data)
	 * @param {symbol} token - The channel ID token
	 * @param {Object} header - The message header
	 * @param {Function} loader - The data-loader function: loader(buffer)
	 * @param {ChannelFlowControl} flowControl - The associatec channel flow control
	 */
	sendByteMessage (token, header, loader, flowControl) {
		const _thys = this.#_;
		const channel = _thys.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized');
		}
		const buffer = this.#getPoolVRWB(header.dataSize);
		if (buffer) loader(buffer);
		const { type = HDR_TYPE_CHAN_DATA, flags = 0, sequence, messageType = 0 } = header;
		const channelId = channel.id, finalHeader = {
			type, flags, channelId, sequence, messageType
		};
		const transfer = buffer ? buffer.segments.map((buffer) => buffer.buffer) : [];
		this.#sendAckMessage(channelId, flowControl);
		this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data: buffer?.segments }, transfer);
		_thys.afterWrite(); // (no deferred write)
	}

	/**
	 * Send a control or data message with UTF-16 textual (string) data
	 * @param {symbol} token - The channel ID token
	 * @param {Object} header - The message header
	 * @param {string} data
	 */
	sendTextMessage (token, header, data, getAckInfo) {
		const channel = this.#_.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized');
		}
		const { type = HDR_TYPE_CHAN_DATA, flags = 0, sequence, messageType = 0 } = header;
		const channelId = channel.id, finalHeader = {
			type, flags, channelId, sequence, messageType
		};
		this.#sendAckMessage(channelId, getAckInfo());
		this.#gateway.postMessage({ protocol: PROTOCOL, header: finalHeader, data });
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
