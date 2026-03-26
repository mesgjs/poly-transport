/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

import { ChannelFlowControl } from './channel-flow-control.esm.js';
import { Base, TimeoutError } from './transport/base.esm.js';
import {
	FLAG_EOM, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA, DATA_HEADER_BYTES,
	TCC_CTLM_MESG_TYPE_REG_REQ, TCC_CTLM_MESG_TYPE_REG_RESP,
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
	});

	#_;
	#_subs = new Set();

	#ackBatchTime;              // Standard ACK batching time (msec)
	#ackBatchTimer = null;
	#allReader = { waiting: false };
	#controlChunks = [];        // { header, data }[] Assembly area for channel control messages
	#dataChunks = new Set();    // Set<{ activeType, header, data, eom, next, nextEOM }>
	#dechunk;                   // Default de-chunking behavior
	#discard = false;           // Discard input when closing
	#eomChunks = new Set();     // EOM subset of dataChunks
	#filteredReaders = new Map(); // Map<type, {waiting: boolean, resolve}>
	#flowControl;
	#forceAckCount;             // ACK-count threshold to force early ACK
	#ids;
	#lowWaterMark;
	#maxDataBytes;
	#name;
	#nextMessageTypeId;         // Private field for message-type ID assignment
	#readyToAck = false;
	#sendAckNow;
	#state = Channel.STATE_OPEN;
	#token;
	#transport;
	#typeChain = new Map();     // Typed chunk chains within dataChunks
	#typeRemapping = new Map(); // Map<highId, lowId> message-type id remapping
	#writeQueue = new TaskQueue();

	/**
	 * Channel constructor
	 * @param {Object} config - Channel configuration
	 * @param {boolean} config.dechunk - Default read dechunk setting
	 * @param {number} config.id - Initial numeric channel id
	 * @param {number} config.localLimit - Local buffer limit
	 * @param {number} config.maxChunkBytes - Maximum chunk size
	 * @param {string} config.name - Channel name
	 * @param {number} config.nextMessageTypeId - Initial message-type ID for assignment
	 * @param {number} config.remoteLimit - Remote buffer limit
	 * @param {symbol} config.token - Unique channel auth token
	 * @param {Transport} config.transport - The associated transport
	 */
	constructor ({ ackBatchTime, dechunk = true, forceAckCount, id, localLimit, lowWaterMark, maxChunkBytes, name, nextMessageTypeId, remoteLimit, token, transport }) {
		if (maxChunkBytes < minChunkBytes) throw new RangeError(`maxChunkBytes must be at least ${minChunkBytes}`);
		this.#ackBatchTime = ackBatchTime ?? 5; // msec
		this.#dechunk = dechunk;
		this.#forceAckCount = forceAckCount ?? 5; // # of ACKs
		this.#ids = [id];
		this.#lowWaterMark = lowWaterMark ?? (16 * 1024);
		this.#maxDataBytes = maxChunkBytes - DATA_HEADER_BYTES;
		this.#name = name;
		this.#nextMessageTypeId = nextMessageTypeId;
		this.#sendAckNow = () => this.#sendAckMessage(true);
		this.#token = token;
		this.#transport = transport;
		this.#flowControl = new ChannelFlowControl(localLimit, remoteLimit, {
			ackBatchTime: this.#ackBatchTime, ackCallback: () => this.#sendAckMessage(),
			forceAckCount: this.#forceAckCount, lowWaterMark: this.#lowWaterMark
		});

		this.#_ = Object.assign(Object.create(this.constructor.__protected), {
			messageTypes: new Map(), // Map<number|string, {ids: number[], type: string, promise, resolve, reject}>
		});
		this._sub_(this.#_subs);
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
	 */
	async close ({ discard = false } = {}) {
		if (discard) this.#discard = true;
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
			// Allows dispatching "real" event objects (e.g. with .preventDefault(), such as subclasses of AsyncAppEvent)
			await super.dispatchEvent(spec[0]);
		}
	}

	/**
	 * Find a waiting reader for a specific (i.e. received) message-type
	 * @param {number} type - The message-type id
	 * @returns {{waiting: boolean, resolve}|undefined}
	 */
	#findReader (type) {
		const allReader = this.#allReader;
		if (allReader.waiting) return allReader;

		const filtered = this.#filteredReaders.get(type);
		if (filtered.waiting) return filtered;
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
	_getTypeIdSet (spec) {
		if (spec instanceof IdSet) return spec; // Already normalized
		if (spec == null) return null;
		const { messageTypes } = this.#_;
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
		const idSet = this._getTypeIdSet(only);
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
		return (token && (token === this.#token) && this.#ids);
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
		const { messageTypes, transport } = _thys;
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
					if (!Base.addRoleId(id, entry.ids)) {
						// Protocol violation - close channel
						this.close({ discard: true });
						return;
					}
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
					entry.reject(null); // Non-Error rejection (no stack trace overhead)
					messageTypes.delete(name);
				}
			}
		}
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
		const idSet = this._getTypeIdSet(only);
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
			reader.timer = setTimeout(() => reader.reject(new TimeoutError()), timeout);
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
		const idSet = this._getTypeIdSet(options.only);
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

		const result = {
			messageType, messageTypeId, dataSize, text, data, eom,
			done: () => {
				for (const chunk of selected) {
					this.#flowControl.markProcessed(chunk.header.sequence);
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
		const result = this.#flowControl.clearWriteAckInfo(baseSequence, ranges);
		if (result.duplicate) {
			// Emit PVE for result.duplicate duplicate ACKs
			const event = new AsyncAppEvent('protocolViolation', { cancelable: true, detail: { duplicateAcks: result.duplicate }});
			await this.dispatchEvent(event);
			if (!event.defaultPrevented) {
				await this.close({ discard: true });
			}
		}
		if (result.premature) {
			// Emit PVE for result.premature premature ACKS
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
		const { dataSize, eom, headerSize, messageType, sequence } = header;
		switch (messageType) {
		case TCC_CTLM_MESG_TYPE_REG_REQ[0]: // Message-type registration request
			break;
		case TCC_CTLM_MESG_TYPE_REG_RESP[0]: // Message-type registration response
			break;
		default:
			throw new ProtocolViolationError('Unknown channel-control message-type', { messageType });
		}

		const _thys = this.#_;
		const { controlChunks, flowControl } = _thys;

		/*
		 * Accumulate control-message chunks until EOM.
		 * We can't detect an incomplete message if it's followed by another
		 * of the same type, but we can if the message-type changes.
		 */
		if (controlChunks.length && controlChunks[0].header.messageType !== messageType) {
			throw new ProtocolViolationError('Incomplete channel-control message', { messageType: controlChunks[0].header.messageType });
		}
		flowControl.received(sequence, headerSize + dataSize);
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
		const { dataChunks, eomChunks, typedChain, typeRemapping } = _thys;
		const { messageType, eom } = header;
		const activeType = typeRemapping.get(messageType) ?? messageType;
		const descriptor = { activeType, header, data, eom, next: null, nextEOM: null };
		const stored = typedChain.get(activeType);
		const typed = stored ?? { read: null, readEOM: null, write: null, writeEOM: null };

		// Standard processing for all chunks
		dataChunks.add(descriptor); // Add to received data chunks
		if (typed.write) { // Append to existing chain
			typed.write.next = descriptor;
			typed.write = descriptor;
		} else { // Start new chain
			typed.read = typed.write = descriptor;
		}
		if (!stored) typedChain.set(activeType, typed);

		if (eom) { // Additional processing for EOM chunks
			eomChunks.add(descriptor);
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
		 	this.#transport.logger.error(`Unknown header type ${header.type}`);
			this.close();
			break;
		}
	}

	// Send (or schedule) an ACK message
	/* async */ #sendAckMessage (immediate = false) {
		if (immediate) {
			// Remove dedicated task and send ACK now
			this.#writeQueue.cancel(this.#sendAckNow, { resolve: null });
			return this.#transport.sendAckMessage(this.#token, this.#flowControl);
		}
		if (!this.#readyToAck) {
			// We'll piggy-back on an existing write task if possible,
			// falling back to a dedicated task
			this.#readyToAck = true;
			return this.#writeQueue.add(this.#sendAckNow);
		}
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
		const { flowControl, maxDataBytes, token, transport, writeQueue } = _thys;
		let offset = 0, remaining = 0, chunkSize;
		const standardTotalSize = () => {
			chunkSize = Math.min(remaining, maxDataBytes);
			return DATA_HEADER_BYTES + chunksize;
		};
		const chunker = (() => { // Determine chunking strategy based on source type
			if (source instanceof Uint8Array) source = new VirtualBuffer(source); // Normalize to VirtualBuffer
			if (source instanceof VirtualBuffer) { // Chunks from VirtualBuffer (or normalized Uint8Array)
				remaining = source.length;
				return {
					get nextBufferSize () { return chunkSize; },
					nextChunk (buffer) {
						buffer.set(source.slice(offset, offset + chunkSize));
						offset += chunkSize;
						remaining -= chunkSize;
						return buffer;
					},
					get remaining () { return remaining; },
					totalSize: standardTotalSize
				};
			}
			if (source == null) return null; // No source/empty source
			if (typeof source === 'function') { // Chunks from function
				remaining = options.byteLength ?? 0;
				return {
					get nextBufferSize () { return chunkSize; },
					nextChunk (buffer) {
						source(offset, offset + chunkSize, buffer);
						offset += chunkSize;
						remaining -= chunkSize;
						return buffer;
					},
					get remaining () { return remaining; },
					totalSize: standardTotalSize,
				};
			}
			if (typeof source === 'string' && !transport.needsEncodedText) { // Chunks from text (JS UTF-16)
				const maxDataChars = maxDataBytes >>> 1; // Two bytes per UTF-16
				remaining = source.length;
				return {
					get nextBufferSize () { return 0; },
					nextChunk () {
						chunkSize = Math.min(remaining, maxDataChars);
						const slice = source.slice(offset, offset + chunkSize);
						offset += chunkSize;
						remaining -= chunkSize;
						return slice;
					},
					get remaining () { return remaining; },
					totalSize () {
						chunkSize = Math.min(remaining, maxDataChars);
						return chunkSize * 2 + DATA_HEADER_BYTES;
					}
				};
			}
			if (typeof source === 'string') { // Chunks of bytes from UTF-8-encoded text
				remaining = source.length;
				return {
					get nextBufferSize () { return chunkSize; },
					nextChunk (buffer) {
						const { read, written } = buffer.encodeFrom(source.slice(offset));
						offset += read;
						remaining -= read;
						buffer.shrink(written);
						return buffer;
					},
					get remaining () { return remaining; },
					totalSize () {
						chunkSize = Math.min(remaining * 3, maxDataBytes);
						return DATA_HEADER_BYTES + chunkSize;
					}
				};
			}
			// undefined (default): unsupported source type
		})();
		if (chunker === undefined) {
			throw new TypeError('Unsupported source type for channel write');
		}

		const { type, eom = true, together = true } = options;
		const sendAChunk = async () => {
			if (this.#readyToAck) this.#sendAckMessage(true);
			const totalSize = chunker.totalSize();
			await flowControl.writable(totalSize);
			const sequence = flowControl.nextWriteSeq;
			const header = { type, flags: 0, sequence, messageType };
			await transport.sendChunk(token, header, chunker);
			flowControl.sent(totalSize);
		};
		if (together) { // Send all chunks together in a single channel task
			return writeQueue.add(async () => {
				for (;;) {
					await sendAChunk();
					if (remaining <= 0) break;
				}
			});
		}
		// Send each chunk in a separate channel task
		for (;;) {
			await writeQueue.add(sendAChunk);
			if (remaining <= 0) break;
		}
	}
}

/*
 * IdSet - Private sub-class indicating a Set of message-type IDs that have already been normalized
 */
class IdSet extends Set {}
