/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

import { ChannelFlowControl } from './channel-flow-control.esm.js';
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

	constructor ({ id, name, transport, transportToken, localMaxBufferBytes, remoteMaxBufferBytes }) {
		this._setState({
			allReader: {
				waiting: false
			},
			discard: false,
			filteredReaders: new Map(),
			flowControl: new ChannelFlowControl(localMaxBufferBytes, remoteMaxBufferBytes),
			ids: [id],
			name,
			messageTypes: new Map(),
			receivedMessages: new Set(),
			state: Channel.STATE_OPEN,
			transport,
			transportToken,
			writerQueue: new TaskQueue(),
		});
	}

	/**
	 * Register a new message-type string
	 * @param {string} type - The new message-type
	 */
	async addMessageType (type) {
		if (typeof type !== 'string' || type === '') {
			throw new TypeError('addMessageType requires non-empty string type');
		}
		// TO DO: IMPLEMENT
	}

	/**
	 * Close the channel
	 * @param {Object} options
	 * @param {boolean} options.discard - Discard incoming data
	 */
	async close ({ discard = false } = {}) {
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
	 * The idsRW form takes a transport auth token and provides direct, raw access for id updates
	 */
	get ids () {
		const state = this.#state;
		return [...state.ids];
	}
	idsRW (token) {
		const state = this.#state;
		return (token && (token === state.transportToken) && state.ids);
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
		const { transport, transportToken: token } = state;
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
		if (!token || token !== state.transportToken) {
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
	 * @param {*} param2 
	 */
	async write (type, source, { byteLength, eom = true, timeout } = {}) {
		// TO DO: IMPLEMENT
	}
}

/*
 * IdSet - A custom Set used to indicate that a list of message types have already been normalized
 */
class IdSet extends Set {}
