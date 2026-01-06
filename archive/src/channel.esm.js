// Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung

import { FlowController, TimeoutError } from './flow-control.esm.js';
import { VirtualBuffer } from './buffer-manager.esm.js';

export class UnsupportedOperationError extends Error {
	constructor (message = 'Unsupported operation') {
		super(message);
		this.name = 'UnsupportedOperationError';
	}
}

export class ChannelClosedError extends Error {
	constructor (message = 'Channel is closed') {
		super(message);
		this.name = 'ChannelClosedError';
	}
}

class AwaitableEvent {
	constructor (type, props = {}) {
		this.type = type;
		this.defaultPrevented = false;
		Object.assign(this, props);
	}

	preventDefault () {
		this.defaultPrevented = true;
	}
}

const normalizeOnly = (only) => {
	if (only === undefined || only === null) {
		return null;
	}
	if (typeof only === 'string' || typeof only === 'number') {
		return new Set([only]);
	}
	if (Array.isArray(only)) {
		return new Set(only);
	}
	if (only instanceof Set) {
		return only;
	}
	throw new TypeError('only must be a string, number, array, or Set');
};

const chunkType = (chunk) => (chunk.typeName ?? chunk.typeId);

const isChunkMatch = (chunk, onlySet) => {
	if (!onlySet) {
		return true;
	}
	return onlySet.has(chunkType(chunk));
};

const toVirtualBuffer = (data) => {
	if (data instanceof VirtualBuffer) {
		return data;
	}
	if (data instanceof Uint8Array) {
		const vb = new VirtualBuffer();
		vb.append(data);
		return vb;
	}
	throw new TypeError('data must be a Uint8Array or VirtualBuffer');
};

/**
 * Channel - a single established channel direction.
 *
 * A "read" channel direction receives user chunks and sends ACKs.
 * A "write" channel direction sends user chunks and receives ACKs.
 */
export class Channel {
	constructor (options = {}) {
		const {
			direction,
			name = null,
			localChannelId,
			// Required for write-direction channels.
			remoteChannelId = null,
			// Receive-side budgets (what we accepted).
			maxBufferSize = 0,
			lowBufferSize = 0,
			maxMessageSize = 0,
			maxChunkSize = 0,
			// Send-side constraints (what remote accepted).
			remoteMaxBufferSize = 0,
			remoteMaxMessageSize = 0,
			remoteMaxChunkSize = 0,
			// Transport callbacks.
			sendData = null,
			sendControl = null,
			sendAck = null,
			logger = console
		} = options;

		if (direction !== 'read' && direction !== 'write') {
			throw new RangeError("direction must be 'read' or 'write'");
		}
		if (name !== null && typeof name !== 'string') {
			throw new TypeError('name must be a string or null');
		}
		if (!Number.isInteger(localChannelId) || localChannelId < 0) {
			throw new RangeError('localChannelId must be a non-negative integer');
		}
		if (direction === 'write') {
			if (!Number.isInteger(remoteChannelId) || remoteChannelId < 0) {
				throw new RangeError('remoteChannelId must be a non-negative integer for write channels');
			}
		}
		if (!Number.isInteger(maxBufferSize) || maxBufferSize < 0) {
			throw new RangeError('maxBufferSize must be a non-negative integer');
		}
		if (!Number.isInteger(lowBufferSize) || lowBufferSize < 0) {
			throw new RangeError('lowBufferSize must be a non-negative integer');
		}
		if (!Number.isInteger(maxMessageSize) || maxMessageSize < 0) {
			throw new RangeError('maxMessageSize must be a non-negative integer');
		}
		if (!Number.isInteger(maxChunkSize) || maxChunkSize < 0) {
			throw new RangeError('maxChunkSize must be a non-negative integer');
		}
		if (!Number.isInteger(remoteMaxBufferSize) || remoteMaxBufferSize < 0) {
			throw new RangeError('remoteMaxBufferSize must be a non-negative integer');
		}
		if (!Number.isInteger(remoteMaxMessageSize) || remoteMaxMessageSize < 0) {
			throw new RangeError('remoteMaxMessageSize must be a non-negative integer');
		}
		if (!Number.isInteger(remoteMaxChunkSize) || remoteMaxChunkSize < 0) {
			throw new RangeError('remoteMaxChunkSize must be a non-negative integer');
		}

		this.direction = direction;
		this.name = name;
		this.localChannelId = localChannelId;
		this.remoteChannelId = remoteChannelId;
		this.maxBufferSize = maxBufferSize;
		this.lowBufferSize = lowBufferSize;
		this.maxMessageSize = maxMessageSize;
		this.maxChunkSize = maxChunkSize;
		this.remoteMaxBufferSize = remoteMaxBufferSize;
		this.remoteMaxMessageSize = remoteMaxMessageSize;
		this.remoteMaxChunkSize = remoteMaxChunkSize;
		this.logger = logger;

		this._sendData = (typeof sendData === 'function') ? sendData : null;
		this._sendControl = (typeof sendControl === 'function') ? sendControl : null;
		this._sendAck = (typeof sendAck === 'function') ? sendAck : null;

		this.state = 'open';
		this._listeners = new Map(); // event -> Set<fn>

		this._remoteMsgTypeByName = new Map();
		this._pendingMsgTypeByName = new Map(); // name -> { resolve, reject, timer, promise }
		this._localMsgTypeNameById = new Map();

		if (direction === 'write') {
			this._sendFlow = new FlowController({
				channelId: localChannelId,
				remoteMaxBufferSize
			});
			this._recvFlow = null;
			this._readQueue = null;
			this._readWaiters = null;
		} else {
			this._sendFlow = null;
			this._recvFlow = new FlowController({
				channelId: localChannelId,
				maxBufferSize,
				lowBufferSize
			});
			this._readQueue = [];
			this._readWaiters = [];
		}
	}

	addEventListener (type, handler) {
		if (typeof type !== 'string') {
			throw new TypeError('type must be a string');
		}
		if (typeof handler !== 'function') {
			throw new TypeError('handler must be a function');
		}
		let set = this._listeners.get(type);
		if (!set) {
			set = new Set();
			this._listeners.set(type, set);
		}
		set.add(handler);
	}

	removeEventListener (type, handler) {
		const set = this._listeners.get(type);
		if (!set) {
			return;
		}
		set.delete(handler);
		if (set.size === 0) {
			this._listeners.delete(type);
		}
	}

	async _dispatchEvent (type, event) {
		const set = this._listeners.get(type);
		if (!set || set.size === 0) {
			return event;
		}
		for (const handler of set) {
			await handler(event);
		}
		return event;
	}

	_getTypeForInboundId (typeId) {
		const name = this._localMsgTypeNameById.get(typeId);
		if (name !== undefined) {
			return { typeName: name, typeId };
		}
		return { typeName: null, typeId };
	}

	async addMessageType (type, { timeout = 0 } = {}) {
		if (this.direction !== 'write') {
			throw new UnsupportedOperationError('addMessageType is only valid on write channels');
		}
		if (typeof type !== 'string') {
			throw new TypeError('type must be a string');
		}
		if (!Number.isInteger(timeout) || timeout < 0) {
			throw new RangeError('timeout must be a non-negative integer');
		}
		if (this._remoteMsgTypeByName.has(type)) {
			return this._remoteMsgTypeByName.get(type);
		}
		if (this._pendingMsgTypeByName.has(type)) {
			return await this._pendingMsgTypeByName.get(type).promise;
		}
		if (!this._sendControl) {
			throw new UnsupportedOperationError('Channel cannot addMessageType without sendControl callback');
		}
		if (this.state !== 'open') {
			throw new ChannelClosedError('Channel is not open');
		}

		const { promise, resolve, reject } = Promise.withResolvers();
		const entry = { resolve, reject, timer: null, promise };
		if (timeout > 0) {
			entry.timer = setTimeout(() => {
				this._pendingMsgTypeByName.delete(type);
				reject(new TimeoutError('Timed out waiting for message-type registration'));
			}, timeout);
		}
		this._pendingMsgTypeByName.set(type, entry);

		await this._sendControl({
			kind: 'messageTypeRegisterRequest',
			channel: this,
			type
		});

		return await promise;
	}

	/**
	 * Transport hook: complete a prior addMessageType() call.
	 */
	_onMessageTypeRegistered (type, remoteTypeId) {
		const entry = this._pendingMsgTypeByName.get(type);
		if (!entry) {
			return;
		}
		this._pendingMsgTypeByName.delete(type);
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = null;
		}
		this._remoteMsgTypeByName.set(type, remoteTypeId);
		entry.resolve(remoteTypeId);
	}

	/**
	 * Transport hook: register an inbound string message type to a local numeric id.
	 */
	_registerLocalMessageType (name, localTypeId) {
		this._localMsgTypeNameById.set(localTypeId, name);
	}

	/**
	 * Write data to the channel, automatically chunking if necessary.
	 * 
	 * Per 2026-01-02-A requirements:
	 * - If data exceeds remoteMaxChunkSize, it's automatically split into chunks
	 * - All chunks except the final one have eom=false
	 * - Only the final chunk has eom=true (if eom was true in the call)
	 * - Message type is consistent across all chunks
	 * - Each chunk is sent atomically, but chunks from different writes may interleave
	 * 
	 * @param {number|string} type - Message type (numeric or registered string)
	 * @param {Uint8Array|VirtualBuffer} data - Data to write
	 * @param {Object} options - Write options
	 * @param {boolean} options.eom - End of message flag (default: true)
	 * @param {number} options.timeout - Timeout in milliseconds (default: 0)
	 */
	async write (type, data, { eom = true, timeout = 0 } = {}) {
		if (this.direction !== 'write') {
			throw new UnsupportedOperationError('write is only valid on write channels');
		}
		if (this.state !== 'open') {
			throw new ChannelClosedError('Channel is not open');
		}
		if (typeof eom !== 'boolean') {
			throw new TypeError('eom must be a boolean');
		}
		if (!Number.isInteger(timeout) || timeout < 0) {
			throw new RangeError('timeout must be a non-negative integer');
		}
		if (!(data instanceof Uint8Array) && !(data instanceof VirtualBuffer)) {
			throw new TypeError('data must be a Uint8Array or VirtualBuffer');
		}

		// Resolve message type
		let messageTypeId;
		let messageTypeName = null;
		if (typeof type === 'number') {
			messageTypeId = type;
		} else if (typeof type === 'string') {
			messageTypeName = type;
			messageTypeId = this._remoteMsgTypeByName.get(type);
			if (messageTypeId === undefined) {
				throw new Error(`Message type '${type}' is not registered for outbound use`);
			}
		} else {
			throw new TypeError('type must be a number or string');
		}

		if (!this._sendData) {
			throw new UnsupportedOperationError('Channel cannot write without sendData callback');
		}

		const vb = toVirtualBuffer(data);
		const totalSize = vb.length;

		// Check if chunking is needed
		if (this.remoteMaxChunkSize === 0 || totalSize <= this.remoteMaxChunkSize) {
			// Single chunk - send as-is
			const sequence = await this._sendFlow.reserveSend(totalSize, { timeout });
			await this._sendData({
				kind: 'data',
				channel: this,
				channelId: this.remoteChannelId,
				sequence,
				messageTypeId,
				messageTypeName,
				eom,
				data: vb
			});
		} else {
			// Multi-chunk - split data
			let offset = 0;
			while (offset < totalSize) {
				const chunkSize = Math.min(this.remoteMaxChunkSize, totalSize - offset);
				const isLastChunk = (offset + chunkSize >= totalSize);
				const chunkEom = isLastChunk ? eom : false;

				// Extract chunk data
				const chunkData = vb.slice(offset, offset + chunkSize);

				// Reserve flow control credits and send
				const sequence = await this._sendFlow.reserveSend(chunkSize, { timeout });
				await this._sendData({
					kind: 'data',
					channel: this,
					channelId: this.remoteChannelId,
					sequence,
					messageTypeId,
					messageTypeName,
					eom: chunkEom,
					data: chunkData
				});

				offset += chunkSize;
			}
		}
	}

	processAck ({ baseSequence, ranges }) {
		if (this.direction !== 'write') {
			throw new UnsupportedOperationError('processAck is only valid on write channels');
		}
		return this._sendFlow.processAck({ baseSequence, ranges });
	}

	async _maybeSendAck () {
		if (this.direction !== 'read') {
			return;
		}
		if (!this._sendAck) {
			return;
		}
		const ack = this._recvFlow.createAck(255);
		if (!ack) {
			return;
		}
		await this._sendAck({
			kind: 'ack',
			channel: this,
			...ack
		});
	}

	/**
	 * Transport hook: accept an incoming chunk.
	 */
	async _onReceiveChunk ({ sequence, messageType, eom = false, data }) {
		if (this.direction !== 'read') {
			throw new UnsupportedOperationError('_onReceiveChunk is only valid on read channels');
		}
		if (this.state !== 'open') {
			return;
		}

		const vb = toVirtualBuffer(data);
		this._recvFlow.onReceiveChunk({ sequence, size: vb.length });
		const t = this._getTypeForInboundId(messageType);
		const chunk = {
			sequence,
			typeId: t.typeId,
			typeName: t.typeName,
			eom,
			data: vb
		};
		this._readQueue.push(chunk);

		await this._dispatchEvent('newChunk', new AwaitableEvent('newChunk', { channel: this, chunk }));
		this._wakeMatchingWaiters(chunk);
	}

	/**
	 * Wake waiting readers whose filter matches the newly arrived chunk.
	 * Only waiters whose filter matches the chunk type are considered.
	 * Non-matching waiters remain in the queue.
	 *
	 * This supports concurrent filtered reads: multiple readers with different
	 * type filters can wait simultaneously without interfering with each other.
	 *
	 * @param {Object} chunk - The newly arrived chunk
	 */
	_wakeMatchingWaiters (chunk) {
		if (this.direction !== 'read') {
			return;
		}

		// Iterate through all waiters (not just the first)
		let i = 0;
		while (i < this._readWaiters.length) {
			const w = this._readWaiters[i];

			// Check if this waiter's filter matches the new chunk
			if (!isChunkMatch(chunk, w.onlySet)) {
				i++; // Skip this waiter, try next
				continue;
			}

			// Try to satisfy this waiter
			const result = this._readSyncInternal(w.onlySet);

			if (result !== null) {
				// Waiter satisfied - remove it
				this._readWaiters.splice(i, 1);
				if (w.timer) {
					clearTimeout(w.timer);
					w.timer = null;
				}
				w.resolve(result);
				// Don't increment i - we removed an element
			} else {
				// Waiter not satisfied yet - keep it and try next
				i++;
			}
		}
	}

	/**
	 * Synchronously read the first matching chunk from the queue.
	 * 
	 * This method supports out-of-order chunk consumption: if a filter is
	 * provided, it will skip non-matching chunks and return the first match.
	 * This allows multiple concurrent readers with different type filters to
	 * operate independently without interfering with each other.
	 * 
	 * When a chunk is consumed:
	 * 1. It's removed from the read queue
	 * 2. Flow control is notified (which may generate an ACK with skip ranges)
	 * 3. An ACK may be sent if the low-water mark is reached
	 * 
	 * @param {Set|null} onlySet - Set of message types to match, or null for any
	 * @returns {Object|null} Chunk data or null if no match found
	 */
	_readSyncInternal (onlySet) {
		// Scan the queue for the first matching chunk
		for (let i = 0; i < this._readQueue.length; i++) {
			const chunk = this._readQueue[i];
			if (!isChunkMatch(chunk, onlySet)) {
				continue; // Skip non-matching chunks (out-of-order consumption)
			}
			// Found a match - remove it and notify flow control
			this._readQueue.splice(i, 1);
			this._recvFlow.onConsumeChunk(chunk.sequence); // May create skip ranges in ACK
			this._maybeSendAck(); // Send ACK if low-water mark reached
			return {
				sequence: chunk.sequence,
				type: chunkType(chunk),
				eom: chunk.eom,
				data: chunk.data
			};
		}
		return null; // No matching chunk found
	}

	/**
	 * Synchronously read a chunk from the channel.
	 * 
	 * Returns immediately with a matching chunk if available, or null if not.
	 * Does not wait for data to arrive.
	 * 
	 * @param {Object} options - Read options
	 * @param {string|number|Array|Set} options.only - Filter by message type(s)
	 * @returns {Object|null} Chunk data or null if no match available
	 */
	readSync ({ only } = {}) {
		if (this.direction !== 'read') {
			throw new UnsupportedOperationError('readSync is only valid on read channels');
		}
		if (this.state !== 'open') {
			return null;
		}
		const onlySet = normalizeOnly(only);
		return this._readSyncInternal(onlySet);
	}

	/**
	 * Asynchronously read a chunk from the channel.
	 * 
	 * Returns immediately if a matching chunk is available, otherwise waits
	 * for a matching chunk to arrive (or timeout).
	 * 
	 * Multiple concurrent reads with different filters are supported and will
	 * not interfere with each other.
	 * 
	 * @param {Object} options - Read options
	 * @param {number} options.timeout - Timeout in milliseconds (0 = no timeout)
	 * @param {string|number|Array|Set} options.only - Filter by message type(s)
	 * @returns {Promise<Object|null>} Chunk data, or null if channel closed
	 * @throws {TimeoutError} If timeout expires before data arrives
	 */
	async read ({ timeout = 0, only } = {}) {
		if (this.direction !== 'read') {
			throw new UnsupportedOperationError('read is only valid on read channels');
		}
		if (this.state !== 'open') {
			return null;
		}
		if (!Number.isInteger(timeout) || timeout < 0) {
			throw new RangeError('timeout must be a non-negative integer');
		}

		const onlySet = normalizeOnly(only);
		const immediate = this._readSyncInternal(onlySet);
		if (immediate !== null) {
			return immediate;
		}

		return await new Promise((resolve, reject) => {
			const w = { onlySet, resolve, reject, timer: null };
			if (timeout > 0) {
				w.timer = setTimeout(() => {
					const idx = this._readWaiters.indexOf(w);
					if (idx >= 0) {
						this._readWaiters.splice(idx, 1);
					}
					reject(new TimeoutError('Timed out waiting for chunk'));
				}, timeout);
			}
			this._readWaiters.push(w);
		});
	}

	/**
	 * Clear chunks from the read queue.
	 * 
	 * Can clear all chunks, chunks matching a filter, or a specific chunk by sequence.
	 * Cleared chunks are acknowledged to the sender.
	 * 
	 * @param {Object} options - Clear options
	 * @param {number|null} options.chunk - Specific chunk sequence to clear, or null for all
	 * @param {string|number|Array|Set|null} options.only - Filter by message type(s)
	 */
	clear ({ chunk = null, only = null } = {}) {
		if (this.direction !== 'read') {
			throw new UnsupportedOperationError('clear is only valid on read channels');
		}
		const onlySet = normalizeOnly(only);
		if (chunk !== null && (!Number.isInteger(chunk) || chunk <= 0)) {
			throw new RangeError('chunk must be a positive integer');
		}

		const kept = [];
		for (const c of this._readQueue) {
			if (chunk !== null && c.sequence !== chunk) {
				kept.push(c);
				continue;
			}
			if (!isChunkMatch(c, onlySet)) {
				kept.push(c);
				continue;
			}
			this._recvFlow.onConsumeChunk(c.sequence);
		}
		this._readQueue = kept;
		this._maybeSendAck();
	}

	/**
	 * Close the channel.
	 * 
	 * Transitions through 'closing' to 'closed' state, dispatching events at each stage.
	 * Waiting readers are resolved with null (EOF) rather than rejected with an error.
	 * 
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - If true, discard all pending read data
	 */
	async close ({ discard = false } = {}) {
		if (typeof discard !== 'boolean') {
			throw new TypeError('discard must be a boolean');
		}
		if (this.state !== 'open') {
			return;
		}

		await this._dispatchEvent('beforeClosing', new AwaitableEvent('beforeClosing', { channel: this, direction: this.direction }));

		this.state = 'closing';
		if (this.direction === 'read' && discard) {
			this.clear();
		}
		this.state = 'closed';

		await this._dispatchEvent('closed', new AwaitableEvent('closed', { channel: this, direction: this.direction }));

		this._wakeWaitersOnClose();
	}

	/**
	 * Wake all waiting readers when the channel closes.
	 * Returns null to indicate EOF rather than rejecting with an error.
	 *
	 * This allows readers to distinguish between:
	 * - Timeout (TimeoutError thrown)
	 * - Clean EOF (null returned, state = 'closing' or 'closed')
	 * - Error condition (other errors thrown)
	 */
	_wakeWaitersOnClose () {
		if (this.direction !== 'read') {
			return;
		}
		if (this.state === 'open') {
			return;
		}
		if (this._readWaiters.length === 0) {
			return;
		}

		// Resolve all waiters with null to indicate EOF
		for (const w of this._readWaiters) {
			if (w.timer) {
				clearTimeout(w.timer);
				w.timer = null;
			}
			w.resolve(null); // EOF, not an error
		}
		this._readWaiters = [];
	}
}
