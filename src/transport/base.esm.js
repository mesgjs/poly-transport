// Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung

import { Eventable } from '@eventable';

/**
 * Transport Base Class
 *
 * Abstract base class for all PolyTransport transport implementations.
 * Provides common functionality for channel management, event handling,
 * and lifecycle management.
 */

export class Transport extends Eventable {
	get EVEN_ROLE () { return 0; }
	get ODD_ROLE () { return 1; }

	#id = crypto.randomUUID();
	#channels = new Map();
	#channelDefaults = {
		maxBufferBytes: 0,      // 0 = unlimited
		maxChunkBytes: 0,       // 0 = transport limit
		maxMessageBytes: 0,     // 0 = unlimited
		lowBufferBytes: 0,      // 0 = no low-water mark
	};
	#started = false;
	#stopped = false;
	#logger = null;

	/**
	 * Create a new Transport instance
	 * @param {Object} options - Transport options
	 * @param {Object} options.logger - Logger instance (default: console)
	 */
	constructor (options = {}) {
		super();
		this.#logger = options.logger || console;
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
	 * Set default options for new channel requests
	 * @param {Object} options - Default channel options
	 * @param {number} options.maxBufferBytes - Max buffer size (0 = unlimited)
	 * @param {number} options.maxChunkBytes - Max chunk size (0 = transport limit)
	 * @param {number} options.maxMessageBytes - Max message size (0 = unlimited)
	 * @param {number} options.lowBufferBytes - Low-water mark for ACKs
	 */
	setChannelDefaults (options = {}) {
		if (options.maxBufferBytes !== undefined) {
			this.#channelDefaults.maxBufferBytes = options.maxBufferBytes;
		}
		if (options.maxChunkBytes !== undefined) {
			this.#channelDefaults.maxChunkBytes = options.maxChunkBytes;
		}
		if (options.maxMessageBytes !== undefined) {
			this.#channelDefaults.maxMessageBytes = options.maxMessageBytes;
		}
		if (options.lowBufferBytes !== undefined) {
			this.#channelDefaults.lowBufferBytes = options.lowBufferBytes;
		}
	}

	/**
	 * Get channel defaults
	 * @returns {Object} Current channel defaults
	 */
	getChannelDefaults () {
		return { ...this.#channelDefaults };
	}

	/**
	 * Start the transport (begin reading and writing)
	 * @returns {Promise<void>}
	 */
	async start () {
		if (this.#stopped) {
			throw new StateError('Transport is stopped');
		}
		if (this.#started) {
			throw new StateError('Transport already started');
		}

		this.#started = true;
		await this._start();

		// TO DO:
		// * Handshake
		// * Role determination
	}

	/**
	 * Stop the transport and close all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>}
	 */
	async stop (options = {}) {
		if (this.#stopped) {
			return;
		}

		const { discard = false, timeout } = options;

		// Emit beforeStopping event
		await this._dispatchEvent('beforeStopping', {});

		// Close all channels
		const channelClosePromises = [];
		for (const channel of this.#channels.values()) {
			channelClosePromises.push(
				channel.close({ discard }).catch(err => {
					this.#logger.error('Error closing channel:', err);
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

		this.#stopped = true;

		// Emit stopped event
		await this._dispatchEvent('stopped', {});
	}

	/**
	 * Request a new channel
	 * @param {string|number} idOrName - Channel identifier or name
	 * @param {Object} options - Request options
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<Channel>} The requested channel
	 */
	async requestChannel (idOrName, options = {}) {
		if (!this.#started) {
			throw new StateError('Transport not started');
		}
		if (this.#stopped) {
			throw new StateError('Transport is stopped');
		}
		throw new Error(`Transport.requestChannel is not yet implemented`);
	}

	/**
	 * Get a channel by ID or name
	 * @param {string|number} idOrName - Channel identifier or name
	 * @returns {Channel|undefined} The channel, or undefined if not found
	 */
	getChannel (idOrName) {
		return this.#channels.get(idOrName);
	}

	/**
	 * Get all channels
	 * @returns {Map<string|number, Channel>} Map of all channels
	 */
	get channels () {
		return new Map(this.#channels);
	}

	/**
	 * Return the transport ID (UUID)
	 */
	get id () { return this.#id; }

	/**
	 * Check if transport is started
	 * @returns {boolean}
	 */
	get isStarted () {
		return this.#started;
	}

	/**
	 * Check if transport is stopped
	 * @returns {boolean}
	 */
	get isStopped () {
		return this.#stopped;
	}

	/**
	 * Get logger instance
	 * @returns {Object}
	 */
	get logger () {
		return this.#logger;
	}

	/**
	 * Register a channel
	 * @protected
	 * @param {string|number} idOrName - Channel identifier or name
	 * @param {Channel} channel - The channel instance
	 */
	_registerChannel (idOrName, channel) {
		this.#channels.set(idOrName, channel);
	}

	/**
	 * Unregister a channel
	 * @protected
	 * @param {string|number} idOrName - Channel identifier or name
	 */
	_unregisterChannel (idOrName) {
		this.#channels.delete(idOrName);
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
			// Allows dispatching "real" event objects (e.g. with .preventDefault(), such as subclass of AppAsyncEvent)
			await this.dispatchEvent(spec[0]);
		}
	}

	// Abstract methods to be implemented by subclasses

	/**
	 * Start the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _start () {
		throw new Error('Transport._start() must be implemented by subclass');
	}

	/**
	 * Stop the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _stop () {
		throw new Error('Transport._stop() must be implemented by subclass');
	}

	/**
	 * Send a message (subclass implementation)
	 * @protected
	 * @abstract
	 * @param {number} channelId - Channel ID
	 * @param {Object} message - Message to send
	 * @returns {Promise<void>}
	 */
	async _sendMessage (channelId, message) {
		throw new Error('_sendMessage() must be implemented by subclass');
	}

	/**
	 * Handle incoming message (subclass implementation)
	 * @protected
	 * @abstract
	 * @param {Object} message - Incoming message
	 */
	_handleIncomingMessage (message) {
		throw new Error('_handleIncomingMessage() must be implemented by subclass');
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
