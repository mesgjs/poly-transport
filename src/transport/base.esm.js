// Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung

import { Eventable } from '@eventable';
import {
	GREET_CONFIG_PREFIX, GREET_CONFIG_SUFFIX, START_BYTE_STREAM,
	HDR_TYPE_ACK, HDR_TYPE_CHAN_CONTROL, HDR_TYPE_CHAN_DATA,
	decodeAckHeaderFrom, decodeChannelHeaderFrom, encAddlToTotal
} from './protocol.esm.js';
import { VirtualRWBuffer } from './virtual-buffer.esm.js';

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
				maxMessageBytes: 0,     // 0 = unlimited
				lowBufferBytes: 1024,   // low-water mark
			},
			channels: new Map(),
			id: crypto.randomUUID(),
			inputBuffer: new VirtualRWBuffer(),
			logger: options.logger || console,
			logSymbol: Symbol('log'),
			pool: options.pool,
			readerTimer: null,
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
	 * Byte-stream transport reader task
	 * Handles:
	 * Line-based greeting + configuration and switch-to-byte-stream
	 * Message-based ACK and channel messages
	 */
	async #byteReader () {
		const state = this.#state;
		const input = state.inputBuffer;
		const newLine = 10, stx = 2;
		let firstConfig = true;
		let offset = 0;

		// Line-based config/handshake loop
		while (!state.stopped) {
			if (offset === input.length) {
				await this.ensureBytes(offset + 1);
			}

			const nextByte = input.getUint8(offset);

			if (nextByte === stx && offset > 0) {
				const line = input.decode({ end: offset });
				input.release(offset);
				offset = 0;
				await this._dispatchEvent('outOfBandData', { data: line });
				continue;
			}

			if (nextByte === newLine) {
				const line = input.decode({ end: offset });
				input.release(offset);
				offset = 0;

				if (line === START_BYTE_STREAM) break;
				if (line.startswith(GREET_CONFIG_PREFIX) && line.endsWith(GREET_CONFIG_SUFFIX) && firstConfig) {
					try {
						const config = JSON.parse(line.slice(GREET_CONFIG_PREFIX.length, -GREET_CONFIG_SUFFIX.length));
						firstConfig = false;
						await this.onRemoteConfig(config);
					} catch (_e) { /**/ }
				} else {
					await this._dispatchEvent('outOfBandData', { data: line });
				}
				continue;
			}

			++offset;
		}

		// Byte-stream-based message loop
		while (!state.stopped) {
			// Read a message header
			if (input.length < 2) {
				await this.ensureBytes(2);
			}
			const type = input.getUint8(0);
			const encAddl = input.getUint8(1);
			const totalHeaderSize = encAddlToTotal(encAddl);
			if (input.length < totalHeaderSize) {
				await this.ensureBytes(totalHeaderSize);
			}

			let header;
			let data = null;

			switch (type) {
			case HDR_TYPE_ACK:
				header = decodeAckHeaderFrom(input);
				break;
			case HDR_TYPE_CHAN_CONTROL:
			case HDR_TYPE_CHAN_DATA:
			{
				header = decodeChannelHeaderFrom(input);
				break;
			}
			default:
			 	// TO DO: Replace/update this placeholder code
				// Protocol violation: unknown header type
				await this._dispatchEvent('protocolViolation', {});
				continue;
			}

			input.release(totalHeaderSize, state.pool);
			const dataSize = header.dataSize ?? 0;
			if (dataSize > 0 && !state.stopped) {
				if (dataSize > input.length) {
					await this.ensureBytes(dataSize);
				}
				data = input.slice(0, dataSize).toPool(state.pool);
				input.release(dataSize, state.pool);
			}

			if (state.stopped) break;

			const channelId = header.channelId;
			const channel = this.getChannel(channelId, state);

			if (!channel) {
			 	// TO DO: Replace/update this placeholder code
				// Protocol violation: unknown channel id
				await this._dispatchEvent('protocolViolation', {});
				continue;
			}

			// Dispatch the message to the appropriate channel for processing
			channel.receiveMessage(this, header, data);
		}
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
		if (Number.isInteger(maxMessageBytes) && maxMessageBytes >= 0) {
			defaults.maxMessageBytes = maxMessageBytes;
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

		this._startReader();

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

	/*
	 * Start the reading task
	 * This version starts the default byte-stream reader
	 * Other (e.g. non-byte-stream) transports should override as required
	 */
	_startReader () {
		const state = this.#state;
		if (!state.readerTimer) {
			state.readerTimer = setTimeout(() => this.#byteReader(), 0);
		}
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
	 * @param {number} channelId - Channel ID
	 * @param {Object} message - Message to send
	 * @returns {Promise<void>}
	 */
	async _sendMessage (channelId, message) {
		// TO DO:
		// Should (almost certainly) be a public method (called by channel)
		// Should (probably) accept (headerObject, data)
		// Base should probably implement byte-stream-style encode + send
		// Worker subclass can override to use postMessage
		throw new Error('transport._sendMessage() must be implemented by subclass');
	}

	/**
	 * Start the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _start () {
		throw new Error('transport._start() must be implemented by subclass');
	}

	/**
	 * Stop the transport (subclass implementation)
	 * @protected
	 * @abstract
	 * @returns {Promise<void>}
	 */
	async _stop () {
		throw new Error('transport._stop() must be implemented by subclass');
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
