/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

import { ChannelFlowControl } from './channel-flow-control.esm.js';
import { StateError, TimeoutError } from './transport/base.esm.js';
import {
	FLAG_EOM, HDR_TYPE_CHAN_CONTROL, MAX_DATA_HEADER_BYTES, TCC_CTLM_MESG_TYPE_REG_REQ
} from './protocol.esm.js';
import { AppAsyncEvent, Eventable } from '@eventable';
import { TaskQueue } from '@task-queue';
import { VirtualBuffer } from './virtual-buffer.esm.js';

export class Channel extends Eventable {
	static get STATE_OPEN () { return 'open'; }
	static get STATE_CLOSING () { return 'closing'; }
	static get STATE_LOCAL_CLOSING () { return 'localClosing'; }
	static get STATE_REMOTE_CLOSING () { return 'remoteClosing'; }
	static get STATE_CLOSED () { return 'closed'; }

	#stateSubs = new Set();
	#state;

	/**
	 * Channel constructor
	 * @param {Object} config - Channel configuration
	 * @param {number} config.id - Initial numeric channel id
	 * @param {string} config.name - Channel name
	 * @param {Transport} config.transport - The associated transport
	 * @param {symbol} config.token - Unique channel auth token
	 * @param {number} config.localLimit - Local buffer limit
	 * @param {number} config.remoteLimit - Remote buffer limit
	 */
	constructor ({ id, name, transport, token, localLimit, remoteLimit, maxDataBytes }) {
		this.#state = {
			allReader: {
				waiting: false
			},
			controlMessages: [], // Accumulated control-message chunks
			dataMessages: new Set(),
			discard: false, // Discard input when closing
			filteredReaders: new Map(), // Map<type, {waiting: boolean, resolve}>
			flowControl: new ChannelFlowControl(localLimit, remoteLimit),
			ids: [id],
			maxDataBytes,
			messageTypes: new Map(), // Map<number|string, {ids: number[], type: string, promise, resolve, reject}>
			name,
			state: Channel.STATE_OPEN,
			transport,
			token,
			writeQueue: new TaskQueue(),
		};
		this._subState(this.#stateSubs);
	}

	/**
	 * Register one or more message types
	 * @param {string[]} rawTypes - The requested message-types
	 */
	async addMessageTypes (rawTypes) {
		const types = Array.isArray(rawTypes) && rawTypes.filter((type) => typeof type === string && type !== '');
		if (!types?.length) {
			return Promise.resolve();
		}
		const state = this.#state, { messageTypes } = state;
		const newTypes = [], promises = [];

		// Check the current status of each type
		for (const type of types) {
			let entry = messageTypes.get(type);
			// Ignore types that already have assigned ids
			if (Number.isInteger(entry?.ids[0])) continue;

			// Wait on existing request if already pending
			if (entry?.promise) {
				promises.push(entry.promise);
				continue;
			}

			// Register first-time requests
			newTypes.push(type);
			entry = { ids: [], type };
			const promise = entry.promise = new Promise((...r) => [entry.resolve, entry.reject] = r);
			promises.push(promise);
			messageTypes.set(type, entry);
		}

		if (newTypes.length) {
			// Send message requesting remote registration of new types
			const { transport, token } = state;
			const data = JSON.stringify({
				request: newTypes
			});
			await transport.sendMessage(token, {
				channelId: state.ids[0],
				eom: true,
				messageType: TCC_CTLM_MESG_TYPE_REG_REQ[0],
				type: HDR_TYPE_CHAN_CONTROL,
			}, data);
		}

		return Promise.all(promises);
	}

	/**
	 * Close the channel
	 * @param {Object} options
	 * @param {boolean} options.discard - Discard incoming data
	 */
	async close ({ discard = false } = {}) {
		const state = this.#state;
		if (discard) state.discard = true;
		// TO DO: IMPLEMENT
	}

	/**
	 * Dispatch an event and await all handlers
	 * @protected
	 * @returns {Promise<void>}
	 */
	async dispatchEvent (...spec) {
		if (typeof spec[0] === 'string') {
			// Eventable expects an event object with type property
			const [type, detail = null] = spec;
			await super.dispatchEvent({ type, detail });
		} else if (typeof spec[0] === 'object') {
			// Allows dispatching "real" event objects (e.g. with .preventDefault(), such as subclasses of AppAsyncEvent)
			await super.dispatchEvent(spec[0]);
		}
	}

	/**
	 * Find a waiting reader for a specific (i.e. received) message-type
	 * @param {number} type - The message-type id
	 * @returns {{waiting: boolean, resolve}|undefined}
	 */
	#findReader (type) {
		const state = this.#state;

		const allReader = state.allReader;
		if (allReader.waiting) return allReader;

		const filtered = state.filteredReaders.get(type);
		if (filtered.waiting) return filtered;
	}

	/**
	 * Return the message-type ids and name for a message type by name or id
	 * @param {string|number} type - The message type
	 * @returns {number|undefined} The message-type id
	 */
	getMessageType (type) {
		const state = this.#state, { messageTypes } = state;;
		const entry = messageTypes.get(type);
		const { ids, name } = entry;
		return { ids, name };
	}

	_getState () {
		const state = this.#state, subs = this.#stateSubs;
		try {
			for (const sub of subs) {
				sub(state);
				subs.delete(sub);
			}
		} catch (_) { /**/ }
	}

	/**
	 * Return normalized message-type filter set
	 * @param {undefined|null|number|string|Array|Set} spec - ID specification
	 * @returns {IdSet|null}
	 */
	_getTypeIdSet (spec) {
		if (spec instanceof IdSet || spec === null) return spec; // Already normalized
		if (spec === undefined) return null;
		const state = this.#state;
		const types = state.messageTypes;
		const ids = new IdSet();
		const iterable = spec?.prototype[Symbol.iterator];
		for (const value of iterable ? spec : [spec]) {
			switch (typeof value) {
			case 'number':
				ids.add(value); // Use numeric ids as-is
				break;
			case 'string':
			{
				// Try to map string names to even and/or odd ids as available
				const entry = types.get(value);
				if (typeof entry?.ids[0] === 'number') {
					ids.add(entry.ids[0]);
					if (entry.ids[1]) {
						ids.add(entry.ids[1]);
					}
				}
			}
			}
		}
		return ids;
	}

	/**
	 * Determine if the channel has a conflicting reader
	 * @param {undefined|null|number|string|Array|Set} only - Message-type(s) of reader(s) to check
	 * @returns {boolean}
	 */
	hasReader (only = null) {
		const state = this.#state;
		const idSet = this._getTypeIdSet(only);

		if (!idSet) {
			// Unfiltered - check for *any* readers
			if (state.allReader.waiting) return true;
			for (const entry of state.filteredReaders.values()) {
				if (entry.waiting) return true;
			}
			return false;
		}

		// Filtered - check for *overlapping* readers
		const readers = state.filteredReaders;
		for (const type of idSet) {
			const reader = readers.get(type);
			if (reader?.waiting) return true;
		}
		return false;
	}

	/**
	 * Return the channel even and/or odd ids
	 * The idsRW form takes a channel auth token and provides direct, raw access for id updates
	 */
	get ids () {
		const state = this.#state;
		return [...state.ids];
	}
	idsRW (token) {
		const state = this.#state;
		return (token && (token === state.token) && state.ids);
	}

	/**
	 * Return the channel name
	 */
	get name () {
		return this.#state.name;
	}

	/**
	 * Handle remote message-type registration request
	 * @param {Object} request - The registration request object
	 * request: {
	 *   request: [ type1, type2, ... ]
	 * }
	 */
	async #onMesgTypeRegRequest (request) {
		// TO DO:
		// Emit event for each message-type
		// Accept (with current or generated id) each not-default-prevented event
		// Reject types that were default-prevented
		// Send response with results
	}

	/**
	 * Handle remote response to local message-type registration request
	 * @param {Object} response - The registration response object
	 * response: {
	 *   accept: { type1: id1, type2: id2, ... },
	 *   reject: [ type3, type4, ... ],
	 * }
	 */
	#onMesgTypeRegResponse (response) {
		// TO DO:
		// Add ids for accepted message-types
		// Resolve waiters
	}

	/**
	 * Parse JSON from an array of message chunks
	 * @param {{header, data:(string|VirtualBuffer)}[]} messages 
	 * @returns {Object}
	 */
	#parseMessageJSON (messages) {
		// Collect any chunked string or buffer data, decoding the latter.
		const jsonText = messages.reduce((acc, [_, data]) => {
			if (typeof data === 'string') { // string chunks
				acc ||= [];
				acc.push(data);
			}
			return acc;
		}, null)?.join('') ??
		messages.reduce((acc, [_, data]) => {
			if (typeof data === 'object' && data !== null) { // buffer chunks
				acc ||= new VirtualBuffer();
				acc.append(data);
			}
			return acc;
		}, null)?.decode();
		const parsed = jsonText && JSON.parse(jsonText);
		return parsed;
	}

	/**
	 * Read a data message from the channel, possibly filtering for one or more specific message
	 * types, waiting if necessary for a suitable match
	 * @param {Object} options
	 * @param {undefined|number|string|Array|Set} options.only - Message-type(s) of reader(s) to check
	 * @param {number|undefined} options.timeout - Maximum time to wait (in msec)
	 * @returns
	 */
	async read ({ only, timeout } = {}) {
		const idSet = this._getTypeIdSet(only);
		if (this.hasReader(idSet)) {
			throw new Error('Conflicting readers');
		}

		// If a matching message is already available, return it
		const ready = this.#readSync(idSet);
		if (ready) return ready;

		// Nothing matching is ready; set up to wait
		const reader = {
			waiting: true
		};
		const promise = new Promise((...r) => [reader.resolve, reader.reject] = r);

		if (typeof timeout === 'number' && timeout > 0) {
			reader.timer = setTimeout(() => reader.reject(new TimeoutError()), timeout);
		}

		// Register reader for specific or any/all types, as appropriate
		const state = this.#state;
		if (!idSet) {
			state.allReader = reader;
		} else {
			const readers = state.filteredReaders;
			for (const type of idSet) {
				readers.set(type, reader);
			}
		}

		// Wait for the promise to resolve, indicating a matching message has become available
		let messageType;
		try {
			messageType = await promise;
		}
		finally {
			if (reader.timer) clearTimeout(reader.timer); // Cancel timeout if still active
			reader.waiting = false; // Expire reader registration(s)
		}
		return this.#readSync(new IdSet([messageType]));
	}

	/**
	 * If there are no conflicting readers, return a matching message (if any) now
	 * @param {Object} options
	 * @param {Object} options.only
	 * @returns
	 */
	readSync ({ only } = {}) {
		const idSet = this._getTypeIdSet(only);
		if (this.hasReader(idSet)) {
			throw new Error('Conflicting readers');
		}
		return this.#readSync(idSet);
	}

	/**
	 * Post-validation common-code for reading a message
	 * @param {IdSet} idSet - Set of message types to consider
	 * @returns
	 */
	#readSync (idSet) {
		const state = this.#state;
		let message = null;

		if (!idSet) {
			// No filter - select the first message, if any
			message = state.dataMessages.values().next().value;
		} else {
			// Select the first message matching the filter, if any
			for (const current of state.dataMessages) {
				if (idSet.has(current.header.messageType)) {
					message = current;
					break;
				}
			}
		}

		// Done if no matching messages
		if (!message) return null;

		state.dataMessages.delete(message);

		const { eom, dataSize, sequence, messageType: typeId } = message.header;
		const typeEntry = state.messageTypes.get(typeId);
		const messageType = typeEntry?.name || typeId;
		const result = {
			data: null,
			done: () => {
				state.flowControl.markProcessed(sequence);
			},
			header: {
				eom,
				dataSize,
				messageType, // Name if registered, otherwise id
				sequence
			},
			process: async (callback) => {
				try {
					// Do whatever with the message
					await callback(result);
				}
				finally {
					// Call done when done, no matter what
					result.done();
				}
			}
		};

		if (typeof message.data === 'string') {
			result.data = message.data;
		} else if (message.data && dataSize > 0) {
			result.data = new VirtualBuffer(message.data);
		}

		Object.freeze(result.header);
		Object.freeze(result);
		return result;
	}

	/**
	 * Process remote ACK for locally-sent messages
	 */
	async #receiveAckMessage (header) {
		const state = this.#state, { flowControl } = state;
		const { baseSequence, ranges } = header;
		const result = flowControl.clearWriteAckInfo(baseSequence, ranges);
		if (result.duplicate) {
			// Emit PVE for result.duplicate duplicate ACKs
			const event = new AppAsyncEvent('protocolViolation', { cancelable: true, detail: { duplicateAcks: result.duplicate }});
			await this.dispatchEvent(event);
			if (!event.defaultPrevented) {
				await this.close({ discard: true });
			}
		}
		if (result.premature) {
			// Emit PVE for result.premature premature ACKS
			const event = new AppAsyncEvent('protocolViolation', { cancelable: true, detail: { prematureAcks: result.premature }});
			await this.dispatchEvent(event);
			if (!event.defaultPrevented) {
				await this.close({ discard: true });
			}
		}
	}

	/**
	 * Process a channel control-message from the remote
	 * @param {Object} header
	 * @param {*} data
	 */
	#receiveControlMessage (header, data) {
		const { dataSize, eom, headerSize, messageType, sequence } = header;
		switch (messageType) {
		case TCC_CTLM_MESG_TYPE_REG_REQ[0]: // Message-type registration request
			break;
		case TCC_CTLM_MESG_TYPE_REG_RESP[0]: // Message-type registration response
			break;
		default:
			throw new ProtocolViolationError('Unknown channel-control message-type', { messageType });
		}

		const state = this.#state, { controlMessages: messages, flowControl } = state;

		/*
		 * Accumulate control-message chunks until EOM.
		 * We can't detect an incomplete message if it's followed by another
		 * of the same type, but we can if the message-type changes.
		 */
		if (messages.length && messages[0][0].messageType !== messageType) {
			throw new ProtocolViolationError('Incomplete channel-control message', { messageType: messages[0][0].messageType });
		}
		flowControl.received(sequence, headerSize + dataSize);
		messages.push([header, data]);
		if (!eom) return;

		/*
		 * Message-type registration requests and responses both require JSON-parsed text.
		 */
		const parsed = this.#parseMessageJSON(messages);

		switch (messageType) {
		case TCC_CTLM_MESG_TYPE_REG_REQ[0]: // Message-type registration request
			this.#onMesgTypeRegRequest(parsed);
			break;
		case TCC_CTLM_MESG_TYPE_REG_RESP[0]: // Message-type registration response
			this.#onMesgTypeRegResponse(parsed);
			break;
		}
	}

	/**
	 * Process a channel data-message from the remote
	 * @param {Object} header
	 * @param {*} data
	 */
	#receiveDataMessage (header, data) {
		const state = this.#state;
		const messages = state.receivedMessages;

		messages.add({ header, data }); // Add to received messages

		// Check for a waiting reader that will take this message type
		const { messageType } = header;
		const reader = this.#findReader(messageType);
		if (reader) {
			// Found one; wake it up
			reader.resolve(messageType);
		}
	}

	/**
	 * Receive and process a message from the transport
	 * @param {symbol} token - Transport verification token
	 * @param {Object} header - The decoded message header
	 * @param {VirtualRWBuffer} data - Optional message data
	 */
	receiveMessage (token, header, data) {
		const state = this.#state;
		if (!token || token !== state.token) {
			throw new Error('Unauthorized receiveMessage');
		}

		switch (header.type) {
		case HDR_TYPE_ACK:
			this.#receiveAckMessage(header);
			break;
		case HDR_TYPE_CHAN_CONTROL:
			this.#receiveControlMessage(header, data);
		case HDR_TYPE_CHAN_DATA:
			this.#receiveDataMessage(header, data);
			break;
		default:
			throw new TypeError('Unknown message type');
		}
	}

	/* async */ #sendAcks () {
		const state = this.#state;
		const { flowControl, token, transport } = state;
		if (!flowControl.ackable) return;
		const { base, ranges } = flowControl.getAckInfo();
		return transport.sendAckMessage(token, base, ranges);
	}

	// Implement in every sub-class to subscribe to state
	_subState () { }

	/**
	 * Write a message (in one or more chunks) to the channel
	 * @param {number|string} type - The message type
	 * @param {string|function|Uint8Array|VirtualBuffer} source
	 * @param {Object} options
	 * @param {number} options.byteLength - Data size (for function source)
	 * @param {boolean} options.eom=true - Last chunk of message
	 * @param {Object} options.options - Additional options
	 */
	/* async */ write (type, source, options = {}) {
		const state = this.#state;
		if (typeof type === 'string') {
			const { messageTypes } = state;
			const info = messageTypes.get(type);
			if (info?.ids.length) {
				type = info.ids[0];
			} else {
				throw new RangeError(`Unknown message type "${type}" for channel.write`);
			}
		}
		const { transport } = state;
		if (typeof source === 'string') {
			if (transport.needsEncodedText) {
				return this.#writeEncodedText(type, source, options);
			}
			return this.#writeRawText(type, source, options);
		}
		if (typeof source === 'function' || source instanceof Uint8Array || source instanceof VirtualBuffer) {
			return this.#writeBuffer(type, source, options);
		}
	}

	/**
	 * Write buffer-or-function-sourced data
	 * @param {number} type - The message-type id
	 * @param {function|Uint8Array|VirtualBuffer} source - The data source
	 * @param {Object} options 
	 */
	async #writeBuffer (type, source, options) {
		const state = this.#state;
		const { flowControl, maxDataBytes, writeQueue, transport, token } = state;
		const { eom } = options;
		const fnSrc = typeof source === 'function';
		if (source instanceof Uint8Array) {
			// Normalize source to VirtualBuffer
			source = new VirtualBuffer(source);
		}
		let offset = 0, remaining = fnSrc ? options.byteLength : source.length;
		if (!Number.isInteger(remaining) || remaining < 1) remaining = 0;
		while (true) {
			// Process the next chunk of data
			const dataSize = Math.min(remaining, maxDataBytes);
			const totalSize = dataSize + MAX_DATA_HEADER_BYTES;
			const flags = (eom && dataSize === remaining) ? FLAG_EOM : 0;
			const bufferLoader = fnSrc ? (buffer) => source(offset, dataSize, buffer) : (buffer) => buffer.set(source.slice(offset, offset + dataSize));
			await writeQueue.add(async () => {
				await flowControl.writable(totalSize); // Wait for channel sending budget
				await this.#sendAcks();
				const sequence = flowControl.nextWriteSeq;
				const header = { dataSize, flags, sequence, messageType: type };
				await transport.sendByteMessage(token, header, bufferLoader);
				flowControl.sent(totalSize);
			});
			offset += dataSize;
			remaining -= dataSize;
			if (remaining <= 0) break;
		}
	}

	/**
	 * Write UTF-8-encoded text
	 * @param {number} type - The message-type id
	 * @param {string} source - The (UTF-16) string data
	 * @param {Object} options 
	 */
	async #writeEncodedText (type, source, options) {
		const state = this.#state;
		const { flowControl, maxDataBytes, writeQueue, transport, token } = state;
		const { eom } = options;
		let offset = 0, remaining = source.length;
		while (true) {
			// Process the next chunk of text
			const dataSize = Math.min(remaining * 3, maxDataBytes);
			const totalSize = dataSize + MAX_DATA_HEADER_BYTES;
			await writeQueue.add(async () => {
				await flowControl.writable(totalSize); // Wait for channel sending budget
				await this.#sendAcks();
				const sequence = flowControl.nextWriteSeq;
				const header = { dataSize, flags: 0, sequence, messageType: type };
				await transport.sendByteMessage(token, header, (buffer) => {
					const { read, written } = buffer.encodeFrom(offset ? source.slice(offset) : source);
					offset += read;
					remaining -= read;
					if (eom && remaining <= 0) header.flags |= FLAG_EOM;
					flowControl.sent(written + MAX_DATA_HEADER_BYTES);
				});
			});
			if (remaining <= 0) break;
		}
	}

	/**
	 * Write raw text
	 * @param {number} type - The message-type id
	 * @param {string} source - The (UTF-16) string data
	 * @param {Object} options 
	 */
	async #writeRawText (type, source, options) {
		const state = this.#state;
		const { flowControl, maxDataBytes, writeQueue, transport, token } = state;
		const maxDataChars = maxDataBytes >>> 1;
		const { eom } = options;
		let offset = 0, remaining = source.length;
		while (true) {
			// Process the next chunk of text
			const dataLen = Math.min(remaining, maxDataChars), dataSize = dataLen < 1;
			const totalSize = dataSize + MAX_DATA_HEADER_BYTES;
			const flags = (eom && dataSize === remaining) ? FLAG_EOM : 0;
			const data = (!offset && dataLen === remaining) ? source : source.slice(offset, offset + dataLen);
			await writeQueue.add(async () => {
				await flowControl.writable(totalSize); // Wait for channel sending budget (in *bytes*)
				await this.#sendAcks();
				const sequence = flowControl.nextWriteSeq;
				const header = { dataSize, flags, sequence, messageType: type };
				await transport.sendTextMessage(token, header, data);
				flowControl.sent(totalSize);
			});
			offset += dataLen;
			remaining -= dataLen;
			if (remaining <= 0) break;
		}
	}
}

/*
 * IdSet - Private sub-class indicating a Set of message-type IDs that have already been normalized
 */
class IdSet extends Set {}
