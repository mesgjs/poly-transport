/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

import { ChannelFlowControl } from './channel-flow-control.esm.js';
import { HDR_TYPE_CHAN_CONTROL, TCC_CTLM_MESG_TYPE_REG_REQ } from './protocol.esm.js';
import { StateError, TimeoutError } from './transport/base.esm.js';
import { TaskQueue } from '@task-queue';

const noop = () => {};

export class Channel {
	get STATE_OPEN () { return 0; }
	get STATE_CLOSING () { return 1; }
	get STATE_LOCAL_CLOSING () { return 2; }
	get STATE_REMOTE_CLOSING () { return 3; }
	get STATE_CLOSED () { return 4; }

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
	constructor ({ id, name, transport, token, localLimit, remoteLimit }) {
		this._setState({
			allReader: {
				waiting: false
			},
			controlData: null, // Accumulated control-message data (VirtualBuffer or string[])
			discard: false, // Discard input when closing
			disconnected: false, // Connection lost
			filteredReaders: new Map(), // Map<type, {waiting: boolean, resolve}>
			flowControl: new ChannelFlowControl(localLimit, remoteLimit),
			ids: [id],
			name,
			messageTypes: new Map(), // Map<number|string, {ids: number[], type: string, promise, resolve, reject}>
			receivedMessages: new Set(),
			state: Channel.STATE_OPEN,
			transport,
			token,
			writerQueue: new TaskQueue(),
		});
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

			// Handle first-time requests
			newTypes.push(type);
			entry = { ids: [], type };
			const promise = entry.promise = new Promise((...r) => [entry.resolve, entry.reject] = r);
			promises.push(promise);
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
	async close ({ discard = false, disconnected = false } = {}) {
		const state = this.#state;
		if (discard) state.discard = true;
		if (disconnected) state.disconnected = true;
		// TO DO: IMPLEMENT
	}

	/**
	 * Find a waiting reader for a message-type
	 * @param {number} type - The message-type id
	 * @returns {Object|undefined}
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

	/**
	 * Return normalized message-type filter set
	 * @param {undefined|number|string|Array|Set} spec - ID specification
	 * @returns {IdSet}
	 */
	_getTypeIdSet (spec) {
		if (spec instanceof IdSet) return spec; // Already normalized
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
	 * @param {undefined|number|string|Array|Set} only - Message-type(s) of reader(s) to check
	 * @returns {boolean}
	 */
	hasReader (only = undefined) {
		const state = this.#state;
		const idSet = this._getTypeIdSet(only);

		if (!idSet.length) {
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
		const state = this.#state;
		return state.name;
	}

	/**
	 * Read a message from the channel, possibly filtering for one or more specific message
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
		if (!idSet.length) {
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
	 * @param {*} idSet
	 * @returns
	 */
	#readSync (idSet) {
		const state = this.#state;
		let message = null;

		if (!idSet.size) {
			// No filter - select the first message, if any
			message = state.receivedMessages.values().next().value;
		} else {
			// Select the first message matching the filter, if any
			for (const current of state.receivedMessages) {
				if (idSet.has(current.header.messageType)) {
					message = current;
					break;
				}
			}
		}

		// Done if no matching messages
		if (message === null) return null;

		state.receivedMessages.delete(message);

		const { eom, dataSize, sequence, messageType: typeId } = message.header;
		const typeEntry = state.messageTypes.get(typeId);
		const messageType = typeEntry?.name || typeId;
		const result = {
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

		if (message.data) {
			/*
			 * Message with data
			 * Attach the data; the user must signal when done
			 */
			result.data = new VirtualBuffer(message.data);
			result.done = () => {
				state.flowControl.recordConsumed(sequence);
			};
		} else {
			// No data; user (or `.process`) can still call done, but there's nothing to do
			result.done = noop;
		}

		Object.freeze(result.header);
		Object.freeze(result);
		return result;
	}

	/**
	 * Process an ACK-message from the remote
	 */
	#receiveAckMessage (header) {
		const state = this.#state;
		const flow = state.flowControl;
		const { baseSequence, ranges } = header;
		const freed = flow.processAck(baseSequence, ranges);
		const { transport, token } = state;
		// TO DO: FINISH IMPLEMENTATION
		// transport.someMethod(token, freed);
	}

	/**
	 * Process a channel control-message from the remote
	 * @param {Object} header
	 * @param {*} data
	 */
	#receiveControlMessage (header, data) {
		const { messageType } = header;
		switch (messageType) {
		case TCC_CTLM_MESG_TYPE_REG_REQ: // Message-type registration request
			break;
		case TCC_CTLM_MESG_TYPE_REG_RESP: // Message-type registration response
			break;
		default:
			throw new ProtocolViolationError('Unknown channel-control message-type', { messageType });
		}
		// TO DO: FINISH IMPLEMENTATION
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

	// Implement in every sub-class to thread the state
	_setState (state) {
		if (!this.#state) {
			this.#state = state;
			// super._setState(state);
		}
	}

	/**
	 *
	 * @param {number|string} type - The message type
	 * @param {*} source
	 * @param {*} options
	 */
	async write (type, source, { byteLength, eom = true, timeout } = {}) {
		// TO DO: IMPLEMENT
	}
}

/*
 * IdSet - A custom Set used to indicate that a list of message types have already been normalized
 */
class IdSet extends Set {}
