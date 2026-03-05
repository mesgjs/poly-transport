/*
 * Transport Base Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Eventable } from '@eventable';
import { TaskQueue } from '@task-queue';
import { ControlChannel } from '../control-channel.esm.js';
import {
	CHANNEL_TCC, MIN_CHANNEL_ID, MIN_MESG_TYPE_ID
} from '../protocol.esm.js';

/**
 * Transport Base Class
 *
 * Abstract base class for all PolyTransport transport implementations.
 * Provides common functionality for channel management, event handling,
 * and lifecycle management.
 */

export class Transport extends Eventable {
	#starting; // Starting promise
	#state; // Private state (sub-classes must have one also)
	#stateSubs = new Set();

	static get ROLE_EVEN () { return 0; }
	static get ROLE_ODD () { return 1; }

	/**
	 * Create a new Transport instance
	 * @param {Object} options - Transport options
	 * @param {Object} options.logger - Logger instance (default: console)
	 * @param {BufferPool} options.pool - Buffer pool
	 */
	constructor (options = {}) {
		super();
		this.#state = {
			channelDefaults: {
				maxBufferBytes: 0,      // 0 = unlimited
				maxChunkBytes: 0,       // 0 = transport limit
				lowBufferBytes: 1024,   // low-water mark
			},
			channels: new Map(), // ids / name / token -> channel
			channelTokens: new Map(), // token <-> channel
			disconnected: false,
			id: crypto.randomUUID(),
			logger: options.logger || console,
			logSymbol: Symbol('log'),
			maxChunkBytes: options.maxChunkBytes ?? 16 * 1024,
			minChannelId: MIN_CHANNEL_ID,
			minMessageTypeId: MIN_MESG_TYPE_ID,
			pool: options.pool,
			role: undefined, // even/odd role not yet determined
			started: false,
			starting: null,
			stopped: false,
			stopping: null,
			tccSymbol: Symbol('TCC'),
			writeQueue: new TaskQueue(),
		};
		this._subState(this.#stateSubs);
	}

	/**
	 * Helper to add an even or odd role id (stored in ascending order, allowing one of each)
	 * @param {number} id Id candidate to be added
	 * @param {Array<number>} ids 0/1/2-element set of ids
	 * @returns {boolean} Success (true) or error (false)
	 */
	static addRoleId (id, ids) {
		if (!Array.isArray(ids) || typeof id !== 'number') {
			throw new TypeError('Invalid addRoleId parameter')
		}
		if (ids.length === 0) {
			ids[0] = id; // First id
			return true;
		}
		// There are 1 or 2 already
		if (id === ids[0] || id === ids[1]) {
			return true; // Existing id
		}
		if (ids.length > 1) {
			return false; // Too many!
		}
		// There's only 1 right now
		if (id % 2 === ids[0] % 2) {
			return false; // Only one id allowed per even/odd parity
		}
		if (id < ids[0]) {
			ids.unshift(id); // New id is smaller: insert
		} else {
			ids[1] = id; // New id is larger: append
		}
		return true;
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
	 * Get an existing channel by name or symbol (public interface)
	 * @param {string|symbol} name - Channel name
	 * @returns {Channel|undefined} The channel, or undefined if not found
	 */
	getChannel (name) {
		if (typeof name === 'string' || typeof name === 'symbol') {
			// NOTE: Public access by numeric id is NOT permitted
			return state.channels.get(name);
		}
	}

	/**
	 * Get channel defaults
	 * @returns {Object} Current channel defaults
	 */
	getChannelDefaults () {
		return { ...this.#state.channelDefaults };
	}

	/**
	 * Base-class method to distribute private state to subscribers
	 */
	_getState () {
		const state = this.#state, subs = this.#stateSubs;
		try {
			for (const sub of subs) {
				sub(state); // Attempt to distribute state
				subs.delete(sub); // Remove successfully-completed subscriptions
			}
		} catch (_) { }
	}

	/**
	 * Return the transport ID (UUID)
	 */
	get id () { return this.#state.id; }

	/**
	 * Check if transport is started
	 * @returns {boolean}
	 */
	get isStarted () {
		return this.#state.started;
	}

	/**
	 * Check if transport is stopped
	 * @returns {boolean}
	 */
	get isStopped () {
		return this.#state.stopped;
	}

	/**
	 * Returns the log channel id (symbol)
	 * Users only have access to the log channel if they have access to the transport object
	 * (E.g. not JSMAWS applets post-bootstrap)
	 */
	get logChannelId () {
		return this.#state.logSymbol;
	}

	/**
	 * Get logger instance
	 * @returns {Object}
	 */
	get logger () {
		return this.#state.logger;
	}

	/**
	 * Return transport-level maxChunkBytes
	 */
	get maxChunkBytes () {
		return this.#state.maxChunkBytes;
	}

	/**
	 * Does this transport require text encoding? (Default true)
	 */
	get needsEncodedText () { return true; }

	/**
	 * Calculate operating values and activate foundational channels upon receiving
	 * remote configuration
	 * @param {Object|AppAsyncEvent} event 
	 */
	async onRemoteConfig (state, config) {
		if (state !== this.#state) throw new Error('Unauthorized call');
		
		// Negotiate consensus on minimum ids
		const { minChannelId, minMessageTypeId } = state;
		const { minChannelId: minRmtChanId, minMessageTypeId: minRmtMesgTypeId } = config;
		if (minRmtChanId > minChannelId) state.minChannelId = minRmtChanId;
		if (minRmtMesgTypeId > minMessageTypeId) state.minMessageTypeId = minRmtMesgTypeId;

		// Compute even/odd role
		const { transportId } = state;
		const { transportId: rmtTranspId } = config;
		if (transportId < rmtTranspId) {
			state.role = Transport.ROLE_EVEN;
		} else if (transportId > rmtTranspId) {
			state.role = Transport.ROLE_ODD;
		} else {
			throw new Error('Received own transport ID in remote config');
		}

		// Always include the transport control channel (TCC)
		const { channels, channelTokens } = state;
		const token = Symbol('TCC');
		const tcc = new ControlChannel({ ...state.channelDefaults, token });
		channels.set(0, tcc);
		channels.set(tcc, 0);
		channelTokens.set(token, tcc);
		channelTokens.set(tcc, token);

		// Include console-content channel (C2C) if mutually enabled in config
		const { c2cEnabled } = state;
		const { c2cEnabled: rmtC2C } = config;
		if (c2cEnabled && rmtC2C) {
			//
		}

		this.#starting.resolve();
	}

	/**
	 * Forward a received message to the appropriate channel
	 * @param {Object} state - Private state for auth
	 * @param {Object} header - Message header
	 * @param {*} data - Optional message data
	 * @returns 
	 */
	async receiveMessage (state, header, data) {
		if (state !== this.#state) throw new Error('Unauthorized receiveMessage');
		if (state.stopped) return;

		const channelId = header.channelId, channel = state.channels.get(channelId);

		if (!channel) {
			await this.dispatchEvent('protocolViolation', {
				type: 'unknownChannelId',
				description: 'Unknown channel ID',
				channelId
			});
			await this.stop();
			return;
		}

		// Dispatch the message to the appropriate channel for processing
		const token = state.channelTokens.get(channel);
		channel.receiveMessage(token, header, data);
	}

	/**
	 * Request a new channel
	 * @param {string} Name - Channel name
	 * @param {Object} options - Request options
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<Channel>} The requested channel
	 */
	async requestChannel (name, options = {}) {
		const state = this.#state;
		const { started, stopped, channels } = state;
		if (!started) {
			throw new StateError('Transport not started');
		}
		if (stopped) {
			throw new StateError('Transport is stopped');
		}
		const tcc = channels.get(CHANNEL_TCC);
		const result = await tcc.requestChannel(name, options);
		// TO DO: Process result
	}

	async sendHandshake (state) {}

	/**
	 * Set default options for new channel requests
	 * @param {Object} options - Default channel options
	 * @param {number} options.maxBufferBytes - Max buffer size (0 = unlimited)
	 * @param {number} options.maxChunkBytes - Max chunk size (0 = transport limit)
	 * @param {number} options.maxMessageBytes - Max message size (0 = unlimited)
	 * @param {number} options.lowBufferBytes - Low-water mark for ACKs
	 */
	setChannelDefaults ({ maxBufferBytes, maxChunkBytes, maxMessageBytes, lowBufferBytes } = {}) {
		const state = this.#state;
		const defaults = state.channelDefaults;
		if (Number.isInteger(maxBufferBytes) && maxBufferBytes >= 0) {
			defaults.maxBufferBytes = maxBufferBytes;
		}
		if (Number.isInteger(maxChunkBytes) && maxChunkBytes >= 0) {
			defaults.maxChunkBytes = maxChunkBytes;
		}
		if (Number.isInteger(lowBufferBytes) && lowBufferBytes > 0) {
			defaults.lowBufferBytes = lowBufferBytes;
		}
	}

	/**
	 * Subscribe to private state (stub for base class)
	 */
	_subState (state) { }

	/**
	 * Common code to start the transport (begin reading and writing)
	 * @fires Transport#startReader
	 * @fires Transport#startWriter
	 * @fires Transport#sendHandshake
	 * @returns {Promise<void>} Promise resolving when the transport is started
	 */
	async start () {
		const state = this.#state;
		if (state.stopping) {
			throw new StateError('Transport is stopped');
		}
		if (state.starting) {
			// Already starting/started
			return state.starting.promise;
		}

		// Create the started promise, to be resolved when the transport is ready
		const starting = this.#starting = { promise: null };
		starting.promise = new Promise((...r) => [starting.resolve, starting.reject] = r);

		await this.startReader(state);
		await this.startWriter(state);
		await this.sendHandshake(state);
		return this.#starting.promise;
	}
	async startReader (state ) { }
	async startWriter (state ) { }

	/**
	 * Stop the transport and close all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>} Promise resolving when the transport is stopped
	 */
	async stop (state, options = {}) {
		if (state !== this.#state) {
			throw new Error('transport.stop missing sub-class')
		}
		if (state.stopped) {
			// Return existing promise if already stopping/stopped
			return state.stopped.promise;
		}

		const stopped = state.stopped = { promise: null };
		stopped.promise = new Promise((res) => stopped.resolve = res);

		const { discard = false, timeout } = options;

		// Emit beforeStopping event
		await this.dispatchEvent('beforeStopping', {});

		// Close all channels
		const channelClosePromises = [];
		for (const channel of state.channels.values()) {
			channelClosePromises.push(
				channel.close({ discard }).catch(err => {
					state.logger.error('Error closing channel:', err);
				})
			);
		}

		// Wait for all channels to close
		if (timeout) {
			let timer;
			await Promise.race([
				Promise.all(channelClosePromises),
				new Promise((_, reject) =>
					timer = setTimeout(() => reject(new TimeoutError('Transport shutdown timeout')), timeout)
				)
			]);
			clearTimeout(timer);
		} else {
			await Promise.all(channelClosePromises);
		}

		// Close the transport
		await this._stop();

		state.stopped = true;

		// Emit stopped event
		await this.dispatchEvent('stopped', {});
	}

	/**
	 * Register a channel
	 * @protected
	 * @param {string|number} idOrName - Channel identifier or name
	 * @param {Channel} channel - The channel instance
	 */
	_registerChannel (idOrName, channel) {
		const state = this.#state;
		state.channels.set(idOrName, channel);
	}

	// Abstract methods to be implemented by subclasses

	/**
	 * Send a message (subclass implementation)
	 * @protected
	 * @abstract
	 */
	sendMessage () {
		throw new Error('transport.sendMessage implementation is missing');
	}

	/**
	 * Start the transport (subclass implementation)
	 * @protected
	 * @abstract
	 */
	_start () {
		throw new Error('transport._start implementation is missing');
	}

	/**
	 * Stop the transport (subclass implementation)
	 * @protected
	 * @abstract
	 */
	_stop () {
		throw new Error('transport._stop implementation is missing');
	}

	/**
	 * Common portion of transport-specific writes from channels
	 * @param {symbol} token - Channel verification token
	 * @param {number} type - The message type
	 * @param {*} source - The data source
	 * @param {Object} options 
	 */
	sendChannelData (token, type, source, { updatableTimeout, ...options } = {}) {
		const state = this.#state;
		const { channelTokens } = state;
		const channel = channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized transport.write');
		}
		// TO DO:
		// Chunking
		// Conversion (maybe)
		// - Byte-stream transports convert strings to bytes
		// - Object-stream transports send strings as-is (UTF-16; length * 2 bytes)
		// Serialized sending of messages per chunk
	}
}

/**
 * State error
 */
export class StateError extends Error {
	constructor (message = 'Wrong state for request', details) {
		super(message);
		this.name = this.constructor.name;
		this.details = details;
	}
}


/**
 * Timeout error
 */
export class TimeoutError extends Error {
	constructor (message = 'Operation timed out', details) {
		super(message);
		this.name = this.constructor.name;
		this.details = details;
	}
}
