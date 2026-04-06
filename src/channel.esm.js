/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

import { ChannelFlowControl } from './channel-flow-control.esm.js';
import {
	FLAG_EOM, HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA, DATA_HEADER_BYTES,
	TCC_CTLM_MESG_TYPE_REG_REQ, TCC_CTLM_MESG_TYPE_REG_RESP,
	TCC_DTAM_CHAN_CLOSE, TCC_DTAM_CHAN_CLOSED, StateError, addRoleId,
} from './protocol.esm.js';
import { AsyncAppEvent, Eventable } from '@eventable';
import { TaskQueue } from '@task-queue';
import { VirtualBuffer } from './virtual-buffer.esm.js';

const minChunkBytes = DATA_HEADER_BYTES + 1024;

export class Channel extends Eventable {
	static get STATE_OPEN () { return 'open'; }
	static get STATE_CLOSING () { return 'closing'; }
	static get STATE_LOCAL_CLOSING () { return 'localClosing'; }
	static get STATE_REMOTE_CLOSING () { return 'remoteClosing'; }
	static get STATE_CLOSED () { return 'closed'; }

	static __protected = Object.freeze({
		// Prototype protected methods

		/**
		 * Finalize channel closure on transport shutdown
		 * Called by ControlChannel/Con2Channel when transport is stopping
		 */
		async onShutDown () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			await thys.#finalizeClosure();
		},
	});

	#_;
	#_subs = new Set();

	#allReader = { waiting: false };
	#closingPromise = null;
	#controlChunks = [];        // { header, data }[] Assembly area for channel control messages
	#dataChunks = new Set();    // Set<{ activeType, header, data, eom, next, nextEOM }>
	#dechunk;                   // Default de-chunking behavior
	#discard = false;           // Discard input when closing
	#eomChunks = new Set();     // EOM subset of dataChunks
	#filteredReaders = new Map(); // Map<type, {waiting: boolean, resolve}>
	#forceAckBytes;             // ACK-bytes threshold to force early ACK
	#forceAckChunks;            // ACK-chunks threshold to force early ACK
	#ids;
	#lowReadBytes;
	#maxDataBytes;
	#mesgTypeRemapping = new Map(); // Map<highId, lowId> message-type id remapping
	#name;
	#nextMessageTypeId;         // Private field for message-type ID assignment
	#readyToAck = false;
	#sendAckNow;
	#state = Channel.STATE_OPEN;
	#typeChain = new Map();     // Typed chunk chains within dataChunks
	#writeQueue = new TaskQueue();

	/**
	 * Channel constructor
	 * @param {Object} config - Channel configuration
	 * @param {boolean} config.dechunk - Default read dechunk setting
	 * @param {number} config.id - Initial numeric channel id
	 * @param {number} config.localLimit - Local buffer limit
	 * @param {number} config.lowReadBytes - Unprocessed-read low-water mark
	 * @param {number} config.maxChunkBytes - Maximum chunk size
	 * @param {string} config.name - Channel name
	 * @param {number} config.nextMessageTypeId - Initial message-type ID for assignment
	 * @param {number} config.remoteLimit - Remote buffer limit
	 * @param {symbol} config.token - Unique channel auth token
	 * @param {Transport} config.transport - The associated transport
	 */
	constructor ({ ackBatchTime, dechunk = true, forceAckBytes, forceAckChunks, id, localLimit, lowReadBytes, maxChunkBytes, name, nextMessageTypeId, remoteLimit, token, transport }) {
		super();
		if (maxChunkBytes < minChunkBytes) throw new RangeError(`maxChunkBytes must be at least ${minChunkBytes}`);
		this.#dechunk = dechunk;
		this.#forceAckBytes = forceAckBytes ?? 16384; // # of ACK bytes
		this.#forceAckChunks = forceAckChunks ?? 5; // # of ACK chunks
		this.#ids = [id];
		this.#lowReadBytes = lowReadBytes ?? (16 * 1024);
		this.#maxDataBytes = maxChunkBytes - DATA_HEADER_BYTES;
		this.#name = name;
		this.#nextMessageTypeId = nextMessageTypeId;
		this.#sendAckNow = () => this.#sendAckMessage(true);

		this.#_ = Object.assign(Object.create(this.constructor.__protected), {
			__this: this,
			flowControl: new ChannelFlowControl(localLimit, remoteLimit, {
				channel: this, logger: transport.logger,
				ackBatchTime: ackBatchTime ?? 5, ackCallback: () => this.#sendAckMessage(),
				forceAckBytes: this.#forceAckBytes, forceAckChunks: this.#forceAckChunks,
				lowReadBytes: this.#lowReadBytes
			}),
			messageTypes: new Map(), // Map<number|string, {ids: number[], type: string, promise, resolve, reject}>
			token,
			transport,
		});
		this._sub_(this.#_subs);
	}

	/**
	 * Register one or more message types
	 * @param {string[]} rawTypes - The requested message-types
	 */
	async addMessageTypes (rawTypes) {
		// Reject if channel is closing or closed
		if (this.#state !== Channel.STATE_OPEN) {
			throw new StateError('Cannot register message types on closing or closed channel', {
				state: this.#state
			});
		}

		const types = Array.isArray(rawTypes) && rawTypes.filter((type) => typeof type === string && type !== '');
		if (!types?.length) {
			return Promise.resolve();
		}
		const { messageTypes } = this.#_;
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
			const type = HDR_TYPE_CHAN_CONTROL, messageType = TCC_CTLM_MESG_TYPE_REG_REQ[0];
			const data = JSON.stringify({ request: newTypes });
			await this.#write(messageType, data, { type });
		}

		return Promise.allSettled(promises);
	}

	/**
	 * Close the channel
	 * @param {Object} options
	 * @param {boolean} options.discard - Discard incoming data
	 * @returns {Promise<void>} Resolves when channel is fully closed
	 */
	async close ({ discard = false } = {}) {
		const state = this.#state;
		const { token, transport } = this.#_;

		// Allow switch to discard mode mid-closing.
		if (state !== Channel.STATE_OPEN && state !== Channel.STATE_CLOSED && discard && !this.#discard) {
			this.#discard = true;
			// Update the remote as well. This message will get echoed back to us if the remote
			// isn't already in discard mode, but won't have any further effect.
			if (state === Channel.STATE_CLOSING) {
				await transport.sendTccMessage(token, TCC_DTAM_CHAN_CLOSE[0], { discard: true });
			}
			await this.#discardExistingInput();
		}

		// If already closing or closed, just return the existing closing promise.
		if (state !== Channel.STATE_OPEN) {
			return this.#closingPromise.promise;
		}

		if (discard) this.#discard = true;

		// First request; initiate the closing process.
		this.#state = Channel.STATE_CLOSING;
		const closingPromise = this.#closingPromise = {};
		closingPromise.promise = new Promise((...r) => [closingPromise.resolve] = r);

		// Notify remote via the TCC.
		await transport.sendTccMessage(token, TCC_DTAM_CHAN_CLOSE[0], { discard: this.#discard });

		// Notify beforeClose listeners.
		await this.dispatchEvent('beforeClose', { discard: this.#discard });

		// If in discard mode, immediately ACK and discard all buffered input.
		if (this.#discard) await this.#discardExistingInput();

		// Wait for all in-flight writes to be ACK'd.
		await this.#_.flowControl.allWritesAcked();

		// Notify remote of our completion.
		await transport.sendTccMessage(this.#_.token, TCC_DTAM_CHAN_CLOSED[0]);

		// Update state based on whether we've received remote's chanClosed.
		if (this.#state === Channel.STATE_CLOSING) {
			this.#state = Channel.STATE_REMOTE_CLOSING;
			// Wait for remote's chanClosed
		} else if (this.#state === Channel.STATE_LOCAL_CLOSING) {
			// Both sides have sent chanClosed - fully closed
			await this.#finalizeClosure();
		}
		return closingPromise.promise; // Resolved in #finalizeClosure.
	}

	/**
	 * Discard all existing buffered input and ACK immediately
	 * Used when closing in discard mode
	 */
	async #discardExistingInput () {
		const flowControl = this.#_.flowControl;
		flowControl.setAckBatchTime(0);
		// Mark all buffered chunks as processed
		for (const chunk of this.#dataChunks) {
			flowControl.markProcessed(chunk.header.sequence);
		}

		// Clear all data structures
		this.#dataChunks.clear();
		this.#eomChunks.clear();
		this.#typeChain.clear();

		// Send ACKs immediately
		await this.#sendAckMessage(true);
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
			// Allows dispatching "real" event objects (e.g. with .preventDefault(), such as subclasses of AsyncAppEvent)
			await super.dispatchEvent(spec[0]);
		}
	}

	/**
	 * Finalize channel closure - transition to closed state and clean up
	 */
	async #finalizeClosure () {
		// Transition to closed state
		this.#state = Channel.STATE_CLOSED;

		// Reject any message-type registrations still pending
		for (const [_type, entry] of this.#_.messageTypes) {
			entry.reject?.('Closed');
		}

		// Reject any pending readers
		if (this.#allReader?.reject) this.#allReader.reject('Closed');
		for (const [_type, entry] of this.#filteredReaders) {
			if (entry.reject) entry.reject('Closed');
		}

		// Clear message type registrations
		const { messageTypes } = this.#_;
		messageTypes.clear();

		this.#_.flowControl.stop();

		// Dispatch closed event
		await this.dispatchEvent('closed');

		// Notify transport to null the channel record
		await this.#_.transport.nullChannel(this.#_.token);

		this.#closingPromise?.resolve();
	}

	/**
	 * Find a waiting reader for a specific (i.e. received) message-type
	 * @param {number} type - The message-type id
	 * @returns {{waiting: boolean, resolve}|undefined}
	 */
	#findReader (type) {
		const allReader = this.#allReader;
		if (allReader?.waiting) return allReader;

		const filtered = this.#filteredReaders.get(type);
		if (filtered?.waiting) return filtered;
	}

	// Distribute protected state object to subscribed sub-classes
	_get_ () {
		const guarded = this.#_, subs = this.#_subs;
		try {
			for (const sub of subs) {
				sub(guarded);
				subs.delete(sub);
			}
		} catch (_) { /**/ }
	}

	/**
	 * Return the message-type ids and name for a message type by name or id
	 * @param {string|number} type - The message type
	 * @returns {number|undefined} The message-type id
	 */
	getMessageType (type) {
		const { messageTypes } = this.#_;
		const entry = messageTypes.get(type);
		const { ids, name } = entry;
		return { ids: [...ids], name };
	}

	/**
	 * Return normalized message-type filter set
	 * @param {undefined|null|number|string|Array|Set} spec - ID specification
	 * @returns {IdSet|null}
	 */
	#getTypeIdSet (spec) {
		if (spec instanceof IdSet) return spec; // Already normalized
		if (spec == null) return null;
		const { messageTypes } = this.#_;
		const ids = new IdSet();
		const iterable = spec?.[Symbol.iterator];
		for (const value of iterable ? spec : [spec]) {
			switch (typeof value) {
			case 'number':
				ids.add(value); // Use numeric ids as-is
				break;
			case 'string':
			{
				// Try to map string names to even and/or odd ids as available
				const entry = messageTypes.get(value);
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
		const idSet = this.#getTypeIdSet(only);
		const readers = this.#filteredReaders;

		if (!idSet) {
			// Unfiltered - check for *any* readers
			if (this.#allReader.waiting) return true;
			for (const entry of readers.values()) {
				if (entry.waiting) return true;
			}
			return false;
		}

		// Filtered - check for *overlapping* readers
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
	get id () { return this.#ids[0]; } // The currently-active id
	get ids () { // Copy of all ids
		return [...this.#ids];
	}
	idsRW (token) { // Read/write access to ids
		return (token && (token === this.#_.token) && this.#ids);
	}

	/**
	 * Return the channel name
	 */
	get name () {
		return this.#name;
	}

	/**
	 * Handle remote message-type registration request
	 * @param {Object} request - The registration request object
	 * request: {
	 *   request: [ type1, type2, ... ]
	 * }
	 */
	async #onMesgTypeRegRequest (request) {
		const _thys = this.#_;
		const { messageTypes } = _thys;
		const accept = {}, reject = [];

		for (const name of request.request) {
			// Emit event for each type
			const event = new AsyncAppEvent('newMessageType', {
				cancelable: true,
				detail: { name }
			});
			await this.dispatchEvent(event);

			if (event.defaultPrevented) {
				// Rejected by handler
				reject.push(name);
			} else {
				// Check for existing registration
				const existing = messageTypes.get(name);
				let typeId;

				if (existing?.ids?.length) {
					// Reuse existing ID
					typeId = existing.ids[0];
				} else {
					// Assign new ID
					typeId = this.#nextMessageTypeId;
					this.#nextMessageTypeId += 2; // Increment by 2 for even/odd separation

					// Create/update record
					const record = { name, ids: [typeId] };
					messageTypes.set(name, record);
					messageTypes.set(typeId, record); // Bidirectional mapping
				}

				accept[name] = typeId;
			}
		}

		// Send response
		const response = { accept, reject };
		const type = HDR_TYPE_CHAN_CONTROL, messageType = TCC_CTLM_MESG_TYPE_REG_RESP[0];
		const data = JSON.stringify(response);
		return this.#write(messageType, data, { type });
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
		const { messageTypes } = this.#_;

		// Process accepted types
		if (response.accept) {
			for (const [name, id] of Object.entries(response.accept)) {
				let entry = messageTypes.get(name);

				if (entry) {
					// Add ID to existing entry (handles jitter settlement)
					if (!addRoleId(id, entry.ids)) {
						this.#_.transport.logger.error(`Invalid additional id ${id} for message type "${name}"`);
						this.close({ discard: true });
						return;
					}
					this.#settleMessageType(...entry.ids);
				} else {
					// Create new entry
					entry = { name, ids: [id] };
					messageTypes.set(name, entry);
				}

				// Create reverse mapping (ID to same record object)
				messageTypes.set(id, entry);

				// Resolve waiting promise if exists
				if (entry.resolve) {
					entry.resolve(id);
					delete entry.promise;
					delete entry.resolve;
					delete entry.reject;
				}
			}
		}

		// Process rejected types
		if (response.reject) {
			for (const name of response.reject) {
				const entry = messageTypes.get(name);
				if (entry?.reject) {
					entry.reject('Type rejected'); // Non-Error rejection (no stack trace overhead)
					messageTypes.delete(name);
				}
			}
		}
	}

	/**
	 * Handle remote chanClosed message (called by transport)
	 * @param {symbol} token - Transport verification token
	 */
	async onRemoteChanClosed (token) {
		if (!token || token !== this.#_.token) {
			throw new Error('Unauthorized');
		}

		// Update state based on current state
		if (this.#state === Channel.STATE_CLOSING) {
			// We're still working on our side - transition to localClosing
			this.#state = Channel.STATE_LOCAL_CLOSING;
		} else if (this.#state === Channel.STATE_REMOTE_CLOSING) {
			// We already sent chanClosed, remote just sent theirs - fully closed
			await this.#finalizeClosure();
		}
		// If state is OPEN or LOCAL_CLOSING, this is unexpected but we'll handle it gracefully
	}

	/**
	 * Parse JSON from an array of message chunks
	 * @param {{header, data:(string|VirtualBuffer)}[]} messages
	 * @returns {Object}
	 */
	#parseChunkedJSON (chunks) {
		// Collect any chunked string or buffer data, decoding the latter.
		const jsonText = chunks.reduce((acc, chunk) => {
			if (typeof chunk.data === 'string') { // string chunks
				acc ||= [];
				acc.push(chunk.data);
			}
			return acc;
		}, null)?.join('') ??
		chunks.reduce((acc, chunk) => {
			if (typeof chunk.data === 'object' && chunk.data !== null) { // buffer chunks
				acc ||= new VirtualBuffer();
				acc.append(chunk.data);
			}
			return acc;
		}, null)?.decode();
		const parsed = jsonText && JSON.parse(jsonText);
		return parsed || {};
	}

	/**
	 * Read a data message from the channel, possibly filtering for one or more specific message
	 * types, waiting if necessary for a suitable match
	 * @param {Object} options
	 * @param {boolean} options.dechunk - Dechunk (read messages instead of chunks)
	 * @param {boolean} options.decode - Auto-decode Uint8 data to text
	 * @param {undefined|number|string|Array|Set} options.only - Message-type(s) of reader(s) to check
	 * @param {number|undefined} options.timeout - Maximum time to wait (in msec)
	 * @returns
	 */
	async read ({ dechunk = true, decode = false, only, timeout } = {}) {
		const idSet = this.#getTypeIdSet(only);
		if (this.hasReader(idSet)) {
			throw new Error('Conflicting readers');
		}

		// If a matching message is already available, return it
		const ready = this.#readSync(idSet, { dechunk, decode });
		if (ready) return ready;

		// Nothing matching is ready; set up to wait
		const reader = {
			waiting: true, dechunk
		};
		const promise = new Promise((...r) => [reader.resolve, reader.reject] = r);

		if (typeof timeout === 'number' && timeout > 0) {
			reader.timer = setTimeout(() => reader.reject('Reader timeout'), timeout);
		}

		// Register reader for specific or any/all types, as appropriate
		if (!idSet) {
			this.#allReader = reader;
		} else {
			const readers = this.#filteredReaders;
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
		return this.#readSync(new IdSet([messageType]), { dechunk, decode });
	}

	/**
	 * If there are no conflicting readers, return a matching chunk or message available now (if any)
	 * @param {Object} options
	 * @param {Object} options.only
	 * @returns
	 */
	readSync (options = {}) {
		const idSet = this.#getTypeIdSet(options.only);
		if (this.hasReader(idSet)) {
			throw new Error('Conflicting readers');
		}
		return this.#readSync(idSet, options);
	}

	/**
	 * Post-validation common-code for reading chunks or messages
	 * @param {IdSet} idSet - Set of message types to consider
	 * @returns
	 */
	#readSync (idSet, { dechunk, decode, withHeaders }) {
		const dataChunks = this.#dataChunks, eomChunks = this.#eomChunks;
		const typeChain = this.#typeChain, selected = [];

		const selectChunk = (chunk) => { // Select an individual chunk (for dechunk: false)
			const type = chunk.activeType, chain = typeChain.get(type);
			selected.push(chunk);
			dataChunks.delete(chunk);
			if (chunk.eom) eomChunks.delete(chunk);
			if (chain.read !== chunk) throw new Error('Not reading from head of type-chain!');
			chain.read = chunk.next;
			if (!chain.read) chain.write = null;
			if (chunk.eom) {
				chain.readEOM = chunk.nextEOM;
				if (!chain.readEOM) chain.writeEOM = null;
			}
		};
		const selectMessageOfType = (type) => { // Select an entire message by type
			const chain = typeChain.get(type);
			for (let read = chain.read; read; read = read.next) {
				selected.push(read);
				dataChunks.delete(read);
				if (read.eom) {
					eomChunks.delete(read);
					chain.read = read.next;
					if (!chain.read) chain.write = null;
					chain.readEOM = read.nextEOM;
					if (!chain.readEOM) chain.writeEOM = null;
					return;
				}
			}
		};

		if (!idSet) { // No filter - select the first chunk or complete message, if any
			if (!dechunk && dataChunks.size) selectChunk(dataChunks.values().next().value);
			else if (dechunk && eomChunks.size) {
				const firstEOMChunk = eomChunks.values().next().value;
				selectMessageOfType(firstEOMChunk.activeType);
			}
		} else { // Select the first chunk or complete message matching the filter, if any
			let best = null;
			for (const type of idSet) {
				const chain = typeChain.get(type);
				if (!chain) continue;
				const candidate = dechunk ? chain.readEOM : chain.read;
				if (candidate && (!best || candidate.sequence < best.sequence)) best = candidate;
			}
			if (best) {
				if (dechunk) selectMessageOfType(best.activeType);
				else selectChunk(best);
			}
		}

		// Done if no matching chunks/messages
		if (!selected.length) return null;

		// Aggregate (non-decoded) data chunks
		const data = decode ? undefined : selected.reduce((acc, chunk) => {
			if (chunk.data instanceof VirtualBuffer) {
				if (selected.length === 1) return chunk.data;
				acc ||= new VirtualBuffer();
				acc.append(chunk.data);
			}
			return acc;
		}, undefined);

		// Aggregate text and decoded data chunks
		const text = selected.reduce((acc, chunk) => {
			if (typeof chunk.data === 'string') {
				acc ||= [];
				acc.push(chunk.data);
			} else if (chunk.data instanceof VirtualBuffer && decode) {
				acc ||= [];
				acc.push(chunk.data.decode());
			}
			return acc;
		}, undefined)?.join('');

		// Assemble the result object
		const dataSize = (text?.length ?? 0) * 2 + (data?.length ?? 0);
		const eom = dechunk || selected[0].eom;
		const messageTypeId = selected[0].activeType;
		const typeEntry = this.#_.messageTypes.get(messageTypeId);
		const messageType = typeEntry?.name ?? messageTypeId;
		const flowControl = this.#_.flowControl;

		const result = {
			messageType, messageTypeId, dataSize, text, data, eom,
			done: () => {
				for (const chunk of selected) {
					flowControl.markProcessed(chunk.header.sequence);
				}
			},
			process: async (callback) => {
				try { await callback(result); } // Process via callback
				finally { result.done(); } // Call done when done, no matter what
			}
		};

		if (withHeaders) {
			result.headers = Object.freeze(selected.map((chunk) => Object.freeze({ ...chunk.header })));
		}

		Object.freeze(result);
		return result;
	}

	/**
	 * Process remote ACK for locally-sent messages
	 */
	async #receiveAckMessage (header) {
		const { baseSequence, ranges } = header;
		const result = this.#_.flowControl.clearWriteAckInfo(baseSequence, ranges);
		if (result.duplicate) {
			// Emit PVE for result.duplicate duplicate ACKs
			this.#_.transport.logger.error('Received duplicate ACK');
			const event = new AsyncAppEvent('protocolViolation', { cancelable: true, detail: { duplicateAcks: result.duplicate }});
			await this.dispatchEvent(event);
			if (!event.defaultPrevented) {
				await this.close({ discard: true });
			}
		}
		if (result.premature) {
			// Emit PVE for result.premature premature ACKS
			this.#_.transport.logger.error('Received premature ACK');
			const event = new AsyncAppEvent('protocolViolation', { cancelable: true, detail: { prematureAcks: result.premature }});
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
		const logger = this.#_.transport.logger;
		const { dataSize, flags, headerSize, messageType, sequence } = header;
		const eom = header.eom = !!(flags & FLAG_EOM);
		switch (messageType) {
		case TCC_CTLM_MESG_TYPE_REG_REQ[0]: // Message-type registration request
			break;
		case TCC_CTLM_MESG_TYPE_REG_RESP[0]: // Message-type registration response
			break;
		default:
		 	logger.error(`Unknown control message (type ${messageType})`);
			this.close();
			return;
		}

		const controlChunks = this.#controlChunks;
		const flowControl = this.#_.flowControl;

		/*
		 * Accumulate control-message chunks until EOM.
		 * We can't detect an incomplete message if it's followed by another
		 * of the same type, but we can if the message-type changes.
		 */
		if (controlChunks.length && controlChunks[0].header.messageType !== messageType) {
			logger.error(`Incomplete control message (type ${controlChunks[0].header.messageType})`);
			this.close();
			return;
		}
		if (!flowControl.received(sequence, headerSize + dataSize)) {
			// Close channel on protocol violation
			this.close({ discard: true });
			return;
		}
		controlChunks.push({ header, data });
		if (!eom) return;

		/*
		 * Message-type registration requests and responses both require JSON-parsed text.
		 */
		try {
			const parsed = this.#parseChunkedJSON(controlChunks);

			switch (messageType) {
			case TCC_CTLM_MESG_TYPE_REG_REQ[0]: // Message-type registration request
				this.#onMesgTypeRegRequest(parsed);
				break;
			case TCC_CTLM_MESG_TYPE_REG_RESP[0]: // Message-type registration response
				this.#onMesgTypeRegResponse(parsed);
				break;
			}
		} finally {
			// Mark all chunks as processed
			for (const chunk of controlChunks) {
				flowControl.markProcessed(chunk.header.sequence);
			}

			// Clear chunks after processing
			controlChunks.length = 0;
		}
	}

	/**
	 * Process a channel data-message from the remote
	 * @param {Object} header
	 * @param {undefined|string|VirtualBuffer} data
	 */
	#receiveDataMessage (header, data) {
		const _thys = this.#_;
		const { flowControl } = _thys;
		const { headerSize, dataSize, sequence, messageType, flags } = header;
		const eom = header.eom = !!(flags & FLAG_EOM);

		if (!flowControl.received(sequence, headerSize + dataSize)) {
			// Close channel on protocol violation
			this.close({ discard: true });
			return;
		}
		if (this.#discard) {
			// If we're closing in discard mode, prepare to ACK and skip everything else
			flowControl.markProcessed(sequence);
			return;
		}

		const activeType = this.#mesgTypeRemapping.get(messageType) ?? messageType;
		const descriptor = { activeType, header, data, eom, next: null, nextEOM: null };
		const stored = this.#typeChain.get(activeType);
		const typed = stored ?? { read: null, readEOM: null, write: null, writeEOM: null };

		// Standard processing for all chunks
		this.#dataChunks.add(descriptor); // Add to received data chunks
		if (typed.write) { // Append to existing chain
			typed.write.next = descriptor;
			typed.write = descriptor;
		} else { // Start new chain
			typed.read = typed.write = descriptor;
		}
		if (!stored) this.#typeChain.set(activeType, typed);

		if (eom) { // Additional processing for EOM chunks
			this.#eomChunks.add(descriptor);
			if (typed.writeEOM) { // Append to existing EOM chain
				typed.writeEOM.nextEOM = descriptor;
				typed.writeEOM = descriptor;
			} else { // Start new EOM chain
				typed.readEOM = typed.writeEOM = descriptor;
			}
		}

		// Check for a waiting reader that will take this message type
		const reader = this.#findReader(messageType);
		if (reader && (eom || !reader.dechunk)) {
			// Found one; wake it up if eom or not de-chunking
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
		if (!token || token !== this.#_.token) {
			throw new Error('Unauthorized');
		}

		const transport = this.#_.transport;

		switch (header.type) {
		case HDR_TYPE_ACK:
			this.#receiveAckMessage(header);
			break;
		case HDR_TYPE_CHAN_CONTROL:
			this.#receiveControlMessage(header, data);
			break;
		case HDR_TYPE_CHAN_DATA:
			this.#receiveDataMessage(header, data);
			break;
		default:
		 	transport.logger.error(`Unknown header (type ${header.type})`);
			this.close();
			break;
		}
	}

	// Send (or schedule) an ACK message
	/* async */ #sendAckMessage (immediate = false) {
		if (immediate) {
			// Send ACK now
			this.#readyToAck = false;
			return this.#_.transport.sendAckMessage(this.#_.token, this.#_.flowControl);
		}
		if (!this.#readyToAck) {
			// We'll piggy-back on an existing write task if possible,
			// falling back to a dedicated task
			this.#readyToAck = true;
			return this.#writeQueue.add(this.#sendAckNow);
		}
	}

	// Update various state when a message-type-id settles to a lower value
	#settleMessageType (lower, higher) {
		if (this.#mesgTypeRemapping.has(higher)) return; // Already done?!
		this.#mesgTypeRemapping.set(higher, lower); // Add remapping entry

		for (const chunk of this.#dataChunks) { // Fix data-chunk descriptors
			if (chunk.activeType === higher) chunk.activeType = lower;
		}

		// Make sure an existing filtered reader is present under the new active type
		const filteredReaders = this.#filteredReaders, reader = filteredReaders.get(higher);
		if (reader) filteredReaders.set(lower, reader);
	}

	get state () { return this.#state; }

	// Base protected-state subscription stub
	_sub_ () { }

	/**
	 * Write a message (in one or more chunks) to the channel
	 * @param {number|string} messageType - The message type
	 * @param {string|function|Uint8Array|VirtualBuffer} source
	 * @param {Object} options
	 * @param {number} options.byteLength - Data size (for function source)
	 * @param {boolean} options.eom=true - Last chunk of message
	 * @param {Object} options.options - Additional options
	 */
	/* async */ write (messageType, source, options = {}) {
		// Reject if channel is closing or closed
		if (this.#state !== Channel.STATE_OPEN) {
			throw new StateError('Cannot write to closing or closed channel', {
				state: this.#state
			});
		}
		return this.#write(messageType, source, { ...options, type: HDR_TYPE_CHAN_DATA });
	}

	async #write (messageType, source, options = {}) {
		const _thys = this.#_;
		if (typeof messageType === 'string') {
			const { messageTypes } = _thys;
			const info = messageTypes.get(messageType);
			if (info?.ids.length) {
				messageType = info.ids[0];
			} else {
				throw new RangeError(`Unknown message type "${messageType}" for channel.write`);
			}
		}
		const transport = this.#_.transport;
		const maxDataBytes = this.#maxDataBytes;
		let offset = 0, remaining = 0, chunkSize;
		const standardBytesToReserve = () => {
			chunkSize = Math.min(remaining, maxDataBytes);
			return DATA_HEADER_BYTES + chunkSize;
		};
		const chunker = (() => { // Determine chunking strategy based on source type
			if (source instanceof Uint8Array) source = new VirtualBuffer(source); // Normalize to VirtualBuffer
			if (source instanceof VirtualBuffer) { // Chunks from VirtualBuffer (or normalized Uint8Array)
				remaining = source.length;
				return {
					get bufferSize () { return chunkSize; },
					bytesToReserve: standardBytesToReserve,
					nextChunk (buffer) {
						buffer.set(source.slice(offset, offset + chunkSize));
						offset += chunkSize;
						remaining -= chunkSize;
						return buffer;
					},
					get remaining () { return remaining; },
					get type () { return 'VB'; }
				};
			}
			if (source == null) return null; // No source/empty source
			if (typeof source === 'function') { // Chunks from function
				remaining = options.byteLength ?? 0;
				return {
					get bufferSize () { return chunkSize; },
					bytesToReserve: standardBytesToReserve,
					nextChunk (buffer) {
						source(offset, offset + chunkSize, buffer);
						offset += chunkSize;
						remaining -= chunkSize;
						return buffer;
					},
					get remaining () { return remaining; },
					get type () { return 'fn'; }
				};
			}
			if (typeof source === 'string' && !transport.needsEncodedText) { // Chunks from text (JS UTF-16)
				const maxDataChars = maxDataBytes >>> 1; // Two bytes per UTF-16
				remaining = source.length;
				return {
					get bufferSize () { return null; },
					bytesToReserve () {
						chunkSize = Math.min(remaining, maxDataChars);
						return chunkSize * 2 + DATA_HEADER_BYTES;
					},
					nextChunk () {
						chunkSize = Math.min(remaining, maxDataChars);
						const slice = source.slice(offset, offset + chunkSize);
						offset += chunkSize;
						remaining -= chunkSize;
						return slice;
					},
					get remaining () { return remaining; },
					get type () { return 'str'; }
				};
			}
			if (typeof source === 'string') { // Chunks of bytes from UTF-8-encoded text
				remaining = source.length;
				return {
					get bufferSize () { return chunkSize; },
					bytesToReserve () {
						chunkSize = Math.min(remaining * 3, maxDataBytes);
						return DATA_HEADER_BYTES + chunkSize;
					},
					nextChunk (buffer) {
						const { read, written } = buffer.encodeFrom(source.slice(offset));
						offset += read;
						remaining -= read;
						buffer.shrink(written);
						return buffer;
					},
					get remaining () { return remaining; },
					get type () { return 'enc'; }
				};
			}
			// undefined (default): unsupported source type
		})();
		if (chunker === undefined) {
			throw new TypeError('Unsupported source type for channel write');
		}

		const flowControl = this.#_.flowControl;
		const writeQueue = this.#writeQueue;
		const { type, eom = true, together = true } = options;
		const sendAChunk = async () => {
			if (this.#readyToAck) await this.#sendAckMessage(true);
			const bytesToReserve = chunker.bytesToReserve();
			await flowControl.writable(bytesToReserve);
			const header = { type, flags: 0, messageType };
			return await transport.sendChunk(this.#_.token, flowControl, header, chunker, { eom });
		};

		// Now send the chunks (as long as we're not closing in discard mode)
		if (together) { // Send all chunks together in a single channel task
			await writeQueue.add(async () => {
				while (!this.#discard) {
					const remainingAfter = await sendAChunk();
					if (remainingAfter <= 0) break;
				}
			});
		} else {
			// Send each chunk in a separate channel task
			while (!this.#discard) {
				const remaining = await writeQueue.add(sendAChunk);
				if (remaining <= 0) break;
			}
		}
	}
}

/*
 * IdSet - Private sub-class indicating a Set of message-type IDs that have already been normalized
 */
class IdSet extends Set {}
