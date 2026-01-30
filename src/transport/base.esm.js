/*
 * Transport Base Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Eventable } from '@eventable';

/**
 * Transport Base Class
 *
 * Abstract base class for all PolyTransport transport implementations.
 * Provides common functionality for channel management, event handling,
 * and lifecycle management.
 */

export class Transport extends Eventable {
	#state; // Private state (sub-classes must have one also)

	get EVEN_ROLE () { return 0; }
	get ODD_ROLE () { return 1; }

	/**
	 * Create a new Transport instance
	 * @param {Object} options - Transport options
	 * @param {Object} options.logger - Logger instance (default: console)
	 * @param {BufferPool} options.pool - Buffer pool
	 */
	constructor (options = {}) {
		super();
		this._setState({
			channelDefaults: {
				maxBufferBytes: 0,      // 0 = unlimited
				maxChunkBytes: 0,       // 0 = transport limit
				lowBufferBytes: 1024,   // low-water mark
			},
			channels: new Map(), // ids / name / token -> channel
			channelTokens: new Map(), // token <-> channel
			id: crypto.randomUUID(),
			logger: options.logger || console,
			logSymbol: Symbol('log'),
			maxChunkBytes: options.maxChunkBytes ?? 16 * 1024,
			pool: options.pool,
			started: false,
			stoppped: false,
			tccSymbol: Symbol('TCC'),
		});
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
	async _dispatchEvent (...spec) {
		if (typeof spec[0] === 'string') {
			// Eventable expects an event object with type property
			const [type, detail] = spec;
			await this.dispatchEvent({ type, detail });
		} else if (typeof spec[0] === 'object') {
			// Allows dispatching "real" event objects (e.g. with .preventDefault(), such as subclasses of AppAsyncEvent)
			await this.dispatchEvent(spec[0]);
		}
	}

	/**
	 * Get a channel by ID or name
	 * @param {string|number|symbol} idOrName - Channel identifier or name
	 * @param {Object|undefined} auth - Optional authentication token (private state)
	 * @returns {Channel|undefined} The channel, or undefined if not found
	 */
	getChannel (idOrName, auth = undefined) {
		const state = this.#state;
		if (typeof idOrName === 'number' && auth !== state) {
			// Public access by name or symbol only (not channel number)
			return;
		}
		return state.channels.get(idOrName);
	}

	/**
	 * Get channel defaults
	 * @returns {Object} Current channel defaults
	 */
	getChannelDefaults () {
		return { ...this.#state.channelDefaults };
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
		const state = this.#state;
		return state.maxChunkBytes;
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
		if (!state.started) {
			throw new StateError('Transport not started');
		}
		if (state.stopped) {
			throw new StateError('Transport is stopped');
		}
		// TO DO:
		// Base class: Generate request header object
		// Subclasses: Send req obj (worker) or encode + send (byte-streams)
		throw new Error(`Transport.requestChannel is not yet implemented`);
	}

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
	 * Thread the private state up through sub-classes
	 * Called from the base-class constructor
	 * Every sub-class MUST implement this
	 * @param {Object} state - The private state object
	 */
	_setState (state) {
		if (!this.#state) {
			this.#state = state;
			// All sub-classes must pass the state up via super
			// super._setState(state);
		}
	}

	/**
	 * Start the transport (begin reading and writing)
	 * @returns {Promise<void>}
	 */
	async start () {
		const state = this.#state;
		if (state.stopped) {
			throw new StateError('Transport is stopped');
		}
		if (state.started) {
			throw new StateError('Transport already started');
		}

		state.started = true;
		await this._start(state);

		// TO DO:
		// * Send our local configuration
		// * Start our reader task
		//   * line-based config/handshake loop
		//   * byte-stream-based message loop
		// * Reader triggers `onRemoteConfig` upon receipt of remote configuration
		//   * calculates operating "min" values
		//   * activates foundational channels
		//   * sends our start-byte-stream sequence to switch remote reader mode
	}

	/**
	 * Stop the transport and close all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>}
	 */
	async stop (options = {}) {
		const state = this.#state;
		if (state.stopped) {
			return;
		}

		const { discard = false, timeout } = options;

		// Emit beforeStopping event
		await this._dispatchEvent('beforeStopping', {});

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
		await this._dispatchEvent('stopped', {});
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
