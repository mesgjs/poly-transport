/*
 * Transport Base Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { Con2Channel } from '../con2-channel.esm.js';
import { ControlChannel } from '../control-channel.esm.js';
import { ChannelFlowControl } from '../channel-flow-control.esm.js';
import {
	CHANNEL_TCC, CHANNEL_C2C, MIN_CHANNEL_ID, MIN_MESG_TYPE_ID,
	toEven, toOdd
} from '../protocol.esm.js';
import { Eventable } from '@eventable';

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
		startByteStream () { },
		startReader () { },
		startWriter () { },
		stop () { },

		/**
		* Calculate operating values and activate foundational channels upon receiving
		* remote configuration
		* @param {object} config 
		*/
		async onRemoteConfig (config) {
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
			const { channels, channelTokens } = _thys;
			const tccLowBuffer = _thys.tcc?.lowBufferBytes ?? _thys.lowBufferBytes;
			const tccMaxChunk = _thys.tcc?.maxChunkBytes ?? _thys.maxChunkBytes;
			const tccToken = Symbol('TCC');
			const tcc = new ControlChannel({ token: tccToken, lowBufferBytes: tccLowBuffer, maxChunkBytes: tccMaxChunk });
			channels.set(CHANNEL_TCC, tcc);
			channels.set(tcc, CHANNEL_TCC);
			channelTokens.set(tccToken, tcc);
			channelTokens.set(tcc, tccToken);

			// Include console-content channel (C2C) if mutually enabled in config
			const { c2cSymbol } = _thys;
			const { c2cEnabled: rmtC2C } = config;
			if (typeof c2cSymbol === 'symbol' && rmtC2C) {
				const c2cLowBuffer = _thys.c2c?.lowBufferBytes ?? _thys.lowBufferBytes;
				const c2cMaxChunk = _thys.c2c?.maxChunkBytes ?? _thys.maxChunkBytes;
				const c2cToken = Symbol('c2c');
				const c2c = new ControlChannel({ token: c2cToken, lowBufferBytes: c2cLowBuffer, maxChunkBytes: c2cMaxChunk });
				channels.set(CHANNEL_C2C, c2c);
				channels.set(c2cSymbol, c2c);
				channels.set(c2c, CHANNEL_C2C);
				channelTokens.set(c2cToken, c2c);
				channelTokens.set(c2c, c2cToken);
			}

			await _thys.startByteStream();
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
	#logger;

	/**
	 * Create a new Transport instance
	 * @param {Object} options - Transport options
	 * @param {BufferPool} options.bufferPool - Buffer pool
	 * @param {Object} options.c2c - Console-content channel options
	 * @param {number} options.c2c.lowBufferBytes - C2C ACK threshold
	 * @param {number} options.c2c.maxChunkBytes - C2C maximum chunk size
	 * @param {boolean} options.c2cSymbol - C2C symbol if locally enabled
	 * @param {Object} options.logger - Logger instance (default: console)
	 * @param {number} options.lowBufferBytes - ACK threshold
	 * @param {number} options.maxChunkBytes - Maximum chunk size
	 * @param {number} options.tcc.lowBufferBytes - TCC ACK threshold
	 * @param {number} options.tcc.maxChunkBytes - TCC maximum chunk size
	 */
	constructor (options = {}) {
		super();
		Object.assign(this.#_ = Object.create(this.constructor.__protected), {
			__this: this,
			bufferPool: options.bufferPool,
			c2c: options.c2c ?? {},
			c2cSymbol: options.c2cSymbol,
			channels: new Map(), // ids / name / token -> channel
			channelTokens: new Map(), // token <-> channel
			disconnected: false,
			id: crypto.randomUUID(),
			logSymbol: Symbol('log'),
			lowBufferBytes: options.lowBufferBytes ?? 16 * 1024,
			maxChunkBytes: options.maxChunkBytes ?? 16 * 1024,
			minChannelId: MIN_CHANNEL_ID,
			minMessageTypeId: MIN_MESG_TYPE_ID,
			pendingChannelRequests: new Map(), // name -> { channelPromise, channelResolve, channelReject, responsePromise, options }
			role: undefined, // even/odd role not yet determined
			started: null, // startup promise
			status: Transport.STATE_CREATED,
			stopped: null, // shutdown promise
			tcc: options.tcc ?? {},
			tccSymbol: Symbol('TCC'),
		});
		this.#logger = options.logger || console;
		this._sub_(this.#_subs);
	}

	/**
	 * Helper to add an even or odd role id (stored in ascending order, allowing one of each)
	 * @param {number} id Id candidate to be added
	 * @param {number[]} ids 0/1/2-element set of ids
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
	 * Create and register a new channel
	 * @protected
	 * @param {string} name - Channel name
	 * @param {number} id - Channel ID
	 * @param {Object} options - Channel options
	 * @returns {Channel} The created channel
	 */
	#createChannel (name, id, options) {
		const _thys = this.#_;
		const { channels, channelTokens, pendingChannelRequests, minMessageTypeId, role } = _thys;

		// Calculate initial nextMessageTypeId based on role
		// Even role: use even ID (e.g., 1024)
		// Odd role: use odd ID (e.g., 1025)
		const nextMessageTypeId = (role === Transport.ROLE_EVEN)
			? toEven(minMessageTypeId) : toOdd(minMessageTypeId);

		const token = Symbol(`channel-${name}`);
		const newChannel = new Channel({
			id,
			name,
			transport: this,
			token,
			localLimit: options.localLimit,
			remoteLimit: options.remoteLimit,
			maxChunkBytes: options.maxChunkBytes,
			nextMessageTypeId
		});

		// Register channel in maps
		channels.set(name, newChannel);
		channels.set(id, newChannel);
		channels.set(newChannel, id);
		channelTokens.set(token, newChannel);
		channelTokens.set(newChannel, token);

		// Remove pending request if exists
		pendingChannelRequests.delete(name);

		return newChannel;
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
		return this.#logger;
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
	 * 
	 */
	async onChannelRequest (token, message) {
		//
	}

	/**
	 * Request a new channel
	 * @param {string} name - Channel name
	 * @param {Object} options - Channel options
	 * @param {number} options.maxBufferBytes - Local maximum buffer size
	 * @param {number} options.maxChunkBytes - Local maximum chunk size
	 * @param {number} options.lowBufferBytes - Local low-water mark for ACKs
	 * @returns {Promise<Channel>} The requested channel
	 */
	async requestChannel (name, options = {}) {
		const _thys = this.#_;
		const { channels, state, pendingChannelRequests } = _thys;

		// Validate transport state
		if (state !== Transport.STATE_ACTIVE) {
			throw new StateError('Transport is not active');
		}

		// Check if channel already exists and is open
		const existing = channels.get(name);
		if (existing && existing.state === 'open') {
			return existing;
		}

		// Check if request already pending - return existing channel promise
		const pending = pendingChannelRequests.get(name);
		if (pending) {
			return pending.channelPromise;
		}

		// Merge options with defaults
		const channelOptions = {
			maxBufferBytes: options.maxBufferBytes ?? _thys.maxBufferBytes,
			maxChunkBytes: options.maxChunkBytes ?? _thys.maxChunkBytes,
			lowBufferBytes: options.lowBufferBytes ?? _thys.lowBufferBytes
		};

		// Create TWO promises:
		// 1. channelPromise - resolves when channel is ready (either direction)
		// 2. responsePromise - resolves when remote response arrives
		const request = { options: channelOptions };
		request.channelPromise = new Promise((resolve, reject) => {
			request.channelResolve = resolve;
			request.channelReject = reject;
		});
		request.responsePromise = new Promise((resolve, reject) => {
			request.responseResolve = resolve;
			request.responseReject = reject;
		});
		pendingChannelRequests.set(name, request);

		// Send request via TCC
		const tcc = channels.get(CHANNEL_TCC);
		await tcc.requestChannel(name, channelOptions, request.responsePromise, request.responseResolve, request.responseReject);

		// Handle response when it arrives
		request.responsePromise.then((channelInfo) => {
			// Response accepted - create or update channel
			const { remoteLimits } = channelInfo;
			const existingChannel = channels.get(name);

			if (existingChannel) {
				// Channel was created by accepting remote request while we waited
				// Add the second role ID
				const token = _thys.channelTokens.get(existingChannel);
				const ids = existingChannel.idsRW(token);
				if (ids && !Transport.addRoleId(channelInfo.id, ids)) {
					const error = new Error('Failed to add role ID - duplicate or invalid');
					request.channelReject(error);
					throw error;
				}
				// Register new ID in channels map
				channels.set(channelInfo.id, existingChannel);
				// Channel promise resolved at creation
			} else {
				// Channel doesn't exist yet - create it now
				const newChannel = this.#createChannel(name, channelInfo.id, {
					localLimit: channelOptions.maxBufferBytes,
					remoteLimit: remoteLimits.maxBufferBytes,
					maxChunkBytes: Math.min(channelOptions.maxChunkBytes, remoteLimits.maxChunkBytes)
				});

				// Resolve channel promise
				request.channelResolve(newChannel);
			}
		}).catch((error) => {
			// Response rejected - reject channel promise
			request.channelReject(error);
			// Remove pending request
			pendingChannelRequests.delete(name);
		});

		return request.channelPromise;
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
