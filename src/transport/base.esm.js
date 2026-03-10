/*
 * Transport Base Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Eventable } from '@eventable';
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
	static get ROLE_EVEN () { return 0; }
	static get ROLE_ODD () { return 1; }

	static get STATE_CREATED () { return 0; }
	static get STATE_STARTING () { return 1; }
	static get STATE_ACTIVE () { return 2; }
	static get STATE_STOPPING () { return 3; }
	static get STATE_STOPPED () { return 4; }

	static __protected = Object.freeze({ // `protected` prototype
		// Base stubs
		afterWrite () { },
		startReader () { },
		startWriter () { },
		stop () { },

		/**
		* Calculate operating values and activate foundational channels upon receiving
		* remote configuration
		* @param {object} config 
		*/
		/* async */ onRemoteConfig (config) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			
			// Negotiate consensus on minimum ids
			const { minChannelId, minMessageTypeId } = _thys;
			const { minChannelId: minRmtChanId, minMessageTypeId: minRmtMesgTypeId } = config;
			if (minRmtChanId > minChannelId) _thys.minChannelId = minRmtChanId;
			if (minRmtMesgTypeId > minMessageTypeId) _thys.minMessageTypeId = minRmtMesgTypeId;

			// Compute even/odd role
			const { transportId } = _thys;
			const { transportId: rmtTranspId } = config;
			if (transportId < rmtTranspId) {
				_thys.role = Transport.ROLE_EVEN;
			} else if (transportId > rmtTranspId) {
				_thys.role = Transport.ROLE_ODD;
			} else {
				throw new Error('Received own transport ID in remote config');
			}

			// Always include the transport control channel (TCC)
			const { channels, channelTokens, lowBufferBytes, maxChunkBytes } = _thys;
			const token = Symbol('TCC');
			const tcc = new ControlChannel({ token, lowBufferBytes, maxChunkBytes });
			channels.set(0, tcc);
			channels.set(tcc, 0);
			channelTokens.set(token, tcc);
			channelTokens.set(tcc, token);

			// Include console-content channel (C2C) if mutually enabled in config
			const { c2cEnabled } = _thys;
			const { c2cEnabled: rmtC2C } = config;
			if (c2cEnabled && rmtC2C) {
				// TO DO
			}

			_thys.started.resolve();
		},

		/**
		* Forward a received message to the appropriate channel
		* @param {Object} state - Private state for auth
		* @param {Object} header - Message header
		* @param {*} data - Optional message data
		* @returns 
		*/
		async receiveMessage (header, data) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			if (_thys.state != Transport.STATE_ACTIVE) return;

			const channelId = header.channelId, channel = _thys.channels.get(channelId);

			if (!channel) {
				await thys.dispatchEvent('protocolViolation', {
					type: 'unknownChannelId',
					description: 'Unknown channel ID',
					channelId
				});
				await thys.stop();
				return;
			}

			// Dispatch the message to the appropriate channel for processing
			const token = _thys.channelTokens.get(channel);
			channel.receiveMessage(token, header, data);
		}
	});

	#_; // Base-class view of protected state (sub-classes must have one also)
	#_subs = new Set(); // Protected-state subscriptions (setter functions)

	/**
	 * Create a new Transport instance
	 * @param {Object} options - Transport options
	 * @param {Object} options.logger - Logger instance (default: console)
	 * @param {BufferPool} options.pool - Buffer pool
	 */
	constructor (options = {}) {
		super();
		Object.assign(this.#_ = Object.create(this.constructor.__protected), {
			__this: this,
			bufferPool: options.bufferPool,
			channels: new Map(), // ids / name / token -> channel
			channelTokens: new Map(), // token <-> channel
			disconnected: false,
			id: crypto.randomUUID(),
			logger: options.logger || console,
			logSymbol: Symbol('log'),
			lowBufferBytes: options.lowBufferBytes ?? 16 * 1024,
			maxChunkBytes: options.maxChunkBytes ?? 16 * 1024,
			minChannelId: MIN_CHANNEL_ID,
			minMessageTypeId: MIN_MESG_TYPE_ID,
			role: undefined, // even/odd role not yet determined
			started: null, // startup promise
			status: Transport.STATE_CREATED,
			stopped: null, // shutdown promise
			tccSymbol: Symbol('TCC'),
		});
		this._sub_(this.#_subs);
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
			return this.#_.channels.get(name);
		}
	}

	/**
	 * Base-class method to distribute private state to subscribers
	 */
	_get_ () {
		const state = this.#_, subs = this.#_subs;
		try {
			for (const sub of subs) {
				sub(state); // Attempt to distribute protected state
				subs.delete(sub); // Remove successfully-completed subscriptions
			}
		} catch (_) { /**/ }
	}

	/**
	 * Return the transport ID (UUID)
	 */
	get id () { return this.#_.id; }

	/**
	 * Returns the log channel id (symbol)
	 * Users only have access to the log channel if they have access to the transport object
	 * (E.g. not JSMAWS applets post-bootstrap)
	 */
	get logChannelId () {
		return this.#_.logSymbol;
	}

	/**
	 * Get logger instance
	 * @returns {Object}
	 */
	get logger () {
		return this.#_.logger;
	}

	/**
	 * Return transport-level maxChunkBytes
	 */
	get maxChunkBytes () {
		return this.#_.maxChunkBytes;
	}

	/**
	 * Does this transport require text encoding? (Default true)
	 */
	get needsEncodedText () { return true; }

	/**
	 * Request a new channel
	 * @param {string} Name - Channel name
	 * @param {Object} options - Request options
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<Channel>} The requested channel
	 */
	async requestChannel (name, options = {}) {
		const _thys = this.#_;
		const { channels, status } = _thys;
		if (status !== Transport.STATE_ACTIVE) throw new StateError('Transport is not active');
		const tcc = channels.get(CHANNEL_TCC);
		const result = await tcc.requestChannel(name, options);
		// TO DO: Process result
	}

	/**
	 * Common code to start the transport (begin reading and writing)
	 * @returns {Promise<void>} Promise resolving when the transport is started
	 */
	async start () {
		const _thys = this.#_;
		switch (_thys.state) {
		case Transport.STATE_STARTING: // Already starting/active - returning starting promise
		case Transport.STATE_ACTIVE:
			return _thys.started.promise;
		case Transport.STATE_STOPPING: // Too late - no longer available
		case Transport.STATE_STOPPED:
			throw new StateError('Transport is unavailable');
		}

		// Create the started promise, to be resolved when the transport is ready
		_thys.state = Transport.STATE_STARTING;
		const started = _thys.started = { promise: null };
		const promise = started.promise = new Promise((...r) => [started.resolve, started.reject] = r);
		promise.then(() => _thys.state = Transport.STATE_ACTIVE, () => { });

		_thys.startReader();
		_thys.startWriter();
		await _thys.sendHandshake();
		return promise;
	}

	get state () { return this.#_.state; }
	get stateString () {
		return ['created', 'starting', 'active', 'stopping', 'stopped'][this.#_.state];
	}

	/**
	 * Stop the transport and close all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>} Promise resolving when the transport is stopped
	 */
	async stop (_thys, options = {}) {
		if (_thys !== this.#_) throw new Error('stop not called from sub-class')
		switch (_thys.state) {
		case Transport.STATE_STOPPING: // Already stopping/stopped - return stopping promise
		case Transport.STATE_STOPPED:
			return _thys.stopped.promise;
		}

		_thys.state = Transport.STATE_STOPPING;
		const stopped = _thys.stopped = { promise: null };
		stopped.promise = new Promise((res) => stopped.resolve = res);

		const { discard = false, timeout } = options;

		// Emit beforeStopping event
		await this.dispatchEvent('beforeStopping', {});

		// Close all channels
		const channelClosePromises = [];
		for (const channel of _thys.channels.values()) {
			channelClosePromises.push(
				channel.close({ discard }).catch(err => {
					_thys.logger.error('Error closing channel:', err);
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
		await _thys.stop();

		_thys.state = Transport.STATE_STOPPED;

		// Emit stopped event
		await this.dispatchEvent('stopped', {});
	}

	// Subscribe to protected state (base stub)
	_sub_ () { }
}

/**
 * State error
 */
export class StateError extends Error {
	constructor (message = 'Wrong state for request', details) {
		super(message);
		this.details = details;
	}

	get name () { return this.constructor.name; }
}


/**
 * Timeout error
 */
export class TimeoutError extends Error {
	constructor (message = 'Operation timed out', details) {
		super(message);
		this.details = details;
	}

	get name () { return this.constructor.name; }
}
