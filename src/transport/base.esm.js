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
	#channels = new Map();
	#channelDefaults = {
		maxBufferBytes: 0,      // 0 = unlimited
		maxChunkBytes: 0,       // 0 = transport limit
		maxMessageBytes: 0,     // 0 = unlimited
		lowBufferBytes: 0,      // 0 = no low-water mark
	};
	#started = false;
	#closed = false;
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
		if (this.#closed) {
			throw new Error('Transport is closed');
		}
		if (this.#started) {
			throw new Error('Transport already started');
		}

		this.#started = true;
		await this._start();
	}

	/**
	 * Close the transport and all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>}
	 */
	async close (options = {}) {
		if (this.#closed) {
			return;
		}

		const { discard = false, timeout } = options;

		// Emit beforeClosing event
		await this._dispatchEvent('beforeClosing', {});

		// Close all channels
		const channelClosePromises = [];
		for (const channel of this.#channels.values()) {
			channelClosePromises.push(
				channel.close({ discard, timeout }).catch(err => {
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
					timer = setTimeout(() => reject(new Error('Close timeout')), timeout)
				)
			]);
			clearTimeout(timer);
		} else {
			await Promise.all(channelClosePromises);
		}

		// Close the transport
		await this._close();

		this.#closed = true;

		// Emit closed event
		await this._dispatchEvent('closed', {});
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
			throw new Error('Transport not started');
		}
		if (this.#closed) {
			throw new Error('Transport is closed');
		}

		// Subclass implements the actual request logic
		return await this._requestChannel(idOrName, options);
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
	 * Check if transport is started
	 * @returns {boolean}
	 */
	get isStarted () {
		return this.#started;
	}

	/**
	 * Check if transport is closed
	 * @returns {boolean}
	 */
	get isClosed () {
		return this.#closed;
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
	 * @param {string} type - Event type
	 * @param {Object} detail - Event detail
	 * @returns {Promise<void>}
	 */
	async _dispatchEvent (type, detail) {
		// Eventable expects an event object with type property
		await this.dispatchEvent({ type, detail });
	}

	// Abstract methods to be implemented by subclasses

	/**
	 * Start the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _start () {
		throw new Error('_start() must be implemented by subclass');
	}

	/**
	 * Close the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _close () {
		throw new Error('_close() must be implemented by subclass');
	}

	/**
	 * Request a channel (subclass implementation)
	 * @protected
	 * @abstract
	 * @param {string|number} idOrName - Channel identifier or name
	 * @param {Object} options - Request options
	 * @returns {Promise<Channel>}
	 */
	async _requestChannel (idOrName, options) {
		throw new Error('_requestChannel() must be implemented by subclass');
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
 * Custom error for timeout scenarios
 */
export class TimeoutError extends Error {
	constructor (message = 'Operation timed out') {
		super(message);
		this.name = 'TimeoutError';
	}
}

/**
 * Custom error for duplicate reader scenarios
 */
export class DuplicateReaderError extends Error {
	constructor (message = 'Duplicate reader detected') {
		super(message);
		this.name = 'DuplicateReaderError';
	}
}

/**
 * Custom error for unsupported operations
 */
export class UnsupportedOperationError extends Error {
	constructor (message = 'Unsupported operation') {
		super(message);
		this.name = 'UnsupportedOperationError';
	}
}
