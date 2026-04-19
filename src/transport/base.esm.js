/*
 * Transport Base Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Eventable } from '@eventable';
import { ChannelFlowControl } from '../channel-flow-control.esm.js';
import {
	CHANNEL_TCC, CHANNEL_C2C, MIN_CHANNEL_ID, MIN_MESG_TYPE_ID,
	TCC_DTAM_CHAN_REQUEST, TCC_DTAM_CHAN_RESPONSE,
	TCC_DTAM_CHAN_CLOSE, TCC_DTAM_CHAN_CLOSED,
	TCC_DTAM_TRAN_STOP, TCC_DTAM_TRAN_STOPPED,
	TCC_CTLM_MESG_TYPE_REG_REQ, TCC_CTLM_MESG_TYPE_REG_RESP,
	StateError, toEven, toOdd, addRoleId
} from '../protocol.esm.js';
import { Channel } from '../channel.esm.js';
import { ControlChannel } from '../control-channel.esm.js';
import { Con2Channel } from '../con2-channel.esm.js';
import { VirtualBuffer } from '../virtual-buffer.esm.js';
import { PromiseTracer } from '../promise-tracer.esm.js';
export { StateError };

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
	static get STATE_LOCAL_STOPPING () { return 4; }
	static get STATE_REMOTE_STOPPING () { return 5; }
	static get STATE_STOPPED () { return 6; }
	static get STATE_DISCONNECTED () { return 7; }

	static __protected = Object.freeze({ // `protected` prototype
		// Base stubs
		afterWrite () { },
		startByteStream () { },
		startReader () { },
		startWriter () { },
		stop () { },

		/**
		 * Called by subclasses when they detect a connection drop.
		 * Default implementation calls stop({ disconnected: true }).
		 */
		async onDisconnect () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			await thys.stop({ disconnected: true });
		},

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
			const { minChannelId: minRemoteChannelId, minMessageTypeId: minRemoteMessageTypeId } = config;
			if (minRemoteChannelId > minChannelId) _thys.minChannelId = minRemoteChannelId;
			if (minRemoteMessageTypeId > minMessageTypeId) _thys.minMessageTypeId = minRemoteMessageTypeId;

			// Compute even/odd role
			const { id } = _thys;
			const { transportId: remoteId } = config;
			if (id < remoteId) {
				_thys.role = Transport.ROLE_EVEN;
			} else if (id > remoteId) {
				_thys.role = Transport.ROLE_ODD;
			} else {
				_thys.state = Transport.STATE_CREATED;
				_thys.started.reject(new Error('Received own transport ID in remote config'));
				return;
			}

			// Initialize nextChannelId based on role
			const { role } = _thys;
			_thys.nextChannelId = (role === Transport.ROLE_EVEN)
				? toEven(minChannelId)
				: toOdd(minChannelId);

			// Always include the transport control channel (TCC)
			// Note: TCC/C2C names are for debugging only (they're NOT indexed)
			const { channels, channelTokens } = _thys;
			const tccLowBuffer = _thys.tccOptions?.lowBufferBytes ?? _thys.lowBufferBytes;
			const tccMaxChunk = _thys.tccOptions?.maxChunkBytes ?? _thys.maxChunkBytes;
			const tccToken = Symbol('TCC');
			const tcc = new ControlChannel({ id: CHANNEL_TCC, name: '[TCC]', token: tccToken, localLimit: 0, remoteLimit: 0, lowBufferBytes: tccLowBuffer, maxChunkBytes: tccMaxChunk, transport: thys });
			channels.set(CHANNEL_TCC, tcc);
			channelTokens.set(tccToken, tcc);
			channelTokens.set(tcc, tccToken);

			// Include console-content channel (C2C) if mutually enabled in config
			const { c2cSymbol } = _thys;
			const { c2cEnabled: remoteC2C } = config;
			if (typeof c2cSymbol === 'symbol' && remoteC2C) {
				const c2cLowBuffer = _thys.c2cOptions?.lowBufferBytes ?? _thys.lowBufferBytes;
				const c2cMaxChunk = _thys.c2cOptions?.maxChunkBytes ?? _thys.maxChunkBytes;
				const c2cToken = Symbol('C2C');
				const c2c = new Con2Channel({ id: CHANNEL_C2C, name: '[C2C]', token: c2cToken, localLimit: 0, remoteLimit: 0, lowBufferBytes: c2cLowBuffer, maxChunkBytes: c2cMaxChunk, transport: thys });
				channels.set(CHANNEL_C2C, c2c);
				channels.set(c2cSymbol, c2c);
				channelTokens.set(c2cToken, c2c);
				channelTokens.set(c2c, c2cToken);
			}

			_thys.state = Transport.STATE_ACTIVE;

			await _thys.startByteStream();

			// Start TCC reader loop (moved from ControlChannel)
			thys.#tccReader();

			_thys.started.resolve();
		},

		/**
		* Forward a received message to the appropriate channel
		* @param {Object} state - Private state for auth
		* @param {Object} header - Message header
		* @param {undefined|string|Uint8Array[]} data - Optional message data
		* @returns 
		*/
		async receiveMessage (header, data) {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			if (_thys.state === Transport.STATE_STOPPED || _thys.state === Transport.STATE_DISCONNECTED) return;
			// console.log(`(${thys.role}) receiveMessage`, header, data);

			const channelId = header.channelId, channel = _thys.channels.get(channelId);

			if (!channel) {
				const message = `Unknown channel ID ${channelId}`;
				thys.logger.error(message);
				await thys.stop();
				return;
			}

			if (channel.state === Channel.STATE_CLOSED || channel.state === Channel.STATE_DISCONNECTED) {
				const message = `Received message for closed channel ID ${channelId} ${channel?.name}`;
				thys.logger.error(message);
				thys.logger.error(JSON.stringify(header));
				await thys.stop();
				return;
			}

			// Dispatch the message to the appropriate channel for processing
			const token = _thys.channelTokens.get(channel);
			if (Array.isArray(data)) data = new VirtualBuffer(data);
			channel.receiveMessage(token, header, data);
		}
	});

	#_; // Base-class view of protected state (sub-classes must have one also)
	#_subs = new Set(); // Protected-state subscriptions (setter functions)
	#logger;
	#promiseTracer; // Optional PromiseTracer instance for tracing long-lived waits

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
	 * @param {PromiseTracer} options.promiseTracer - Promise tracer for monitoring long-lived waits
	 * @param {number} options.tcc.lowBufferBytes - TCC ACK threshold
	 * @param {number} options.tcc.maxChunkBytes - TCC maximum chunk size
	 */
	constructor (options = {}) {
		super();
		this.#_ = Object.assign(Object.create(this.constructor.__protected), {
			__this: this,
			bufferPool: options.bufferPool,
			c2cOptions: options.c2c ?? {},
			c2cSymbol: options.c2cSymbol,
			channels: new Map(), // ids / name -> channel
			channelTokens: new Map(), // token <-> channel
			id: crypto.randomUUID(),
			lowBufferBytes: options.lowBufferBytes ?? 16 * 1024,
			maxBufferBytes: options.maxBufferBytes ?? 0, // 0 = unlimited
			maxChunkBytes: options.maxChunkBytes ?? 16 * 1024,
			minChannelId: MIN_CHANNEL_ID,
			minMessageTypeId: MIN_MESG_TYPE_ID,
			pendingChannelRequests: new Map(), // name -> { promise, resolve, reject, options }
			role: undefined, // even/odd role not yet determined
			started: null, // startup promise
			state: Transport.STATE_CREATED,
			stopped: null, // shutdown promise
			tccOptions: options.tcc ?? {},
		});
		this.#logger = options.logger || console;
		this.#promiseTracer = options.promiseTracer ?? null;
		this._sub_(this.#_subs);
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
		const { channels, channelTokens, minMessageTypeId, role } = _thys;

		// Calculate initial nextMessageTypeId based on role
		// Even role: use even ID (e.g., 1024)
		// Odd role: use odd ID (e.g., 1025)
		const nextMessageTypeId = (role === Transport.ROLE_EVEN)
			? toEven(minMessageTypeId) : toOdd(minMessageTypeId);

		const token = options.token ?? Symbol(`channel-${name}`);
		const newChannel = new Channel({
			id,
			name,
			transport: this,
			token,
			localLimit: options.localLimit,
			remoteLimit: options.remoteLimit,
			maxChunkBytes: options.maxChunkBytes,
			nextMessageTypeId,
			promiseTracer: this.#promiseTracer
		});

		// Register channel in maps
		channels.set(name, newChannel);
		channels.set(id, newChannel);
		channelTokens.set(token, newChannel);
		channelTokens.set(newChannel, token);

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
	 * Finalize transport stop - transition to STOPPED state, resolve promise, emit event
	 * @private
	 */
	async #finalizeStop () {
		const _thys = this.#_;

		// Disconnect TCC and C2C channels (bypasses the no-op close() override)
		const { channels, channelTokens } = _thys;
		for (const channelId of [CHANNEL_TCC, CHANNEL_C2C]) {
			const channel = channels.get(channelId);
			if (channel && typeof channel.close === 'function') {
				const token = channelTokens.get(channel);
				if (token) {
					await channel.close({ disconnected: token }).catch((err) => this.logger.error(err));
				}
			}
		}

		if (_thys.state === Transport.STATE_DISCONNECTED) return;
		_thys.state = Transport.STATE_STOPPED;

		// Clear write batch timer (must happen after tranStopped is scheduled)
		await _thys.stop();
		_thys.bufferPool?.stop();

		// Stop promise tracer
		this.#promiseTracer?.stop();

		_thys.stopped?.resolve();
		await this.dispatchEvent('stopped', {});
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
	 * Return the transport ID (UUID)
	 */
	get id () { return this.#_.id; }

	/**
	 * Return the last characters of the transport ID (for compact logging)
	 */
	get idTail () { return this.#_.id.slice(-6); }

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
	 * Null a channel record for reopening support
	 * @param {symbol} token - Channel token
	 */
	async nullChannel (token) {
		const _thys = this.#_;
		const { channels, channelTokens } = _thys;

		// Get channel by token
		const channel = channelTokens.get(token);
		if (!channel) return;

		const channelIds = channel.ids, channelName = channel.name;

		// Create nulled record
		const nulledRecord = {
			name: channelName,
			id: channelIds[0],
			token,
			state: Channel.STATE_CLOSED
		};

		// Remove channel object from maps
		channelTokens.delete(token);
		channelTokens.delete(channel);

		// Keep name and (first) ID mapping pointing to nulled record
		channels.set(channelName, nulledRecord);
		channels.set(channelIds[0], nulledRecord);
		if (channelIds[1] !== undefined) channels.delete(channelIds[1]);
	}

	/**
	 * Handle incoming channel close message
	 * @private
	 * @param {Object} request - Parsed request: { channelId, discard }
	 */
	async #onChannelClose (request) {
		const { channelId, discard } = request;
		const _thys = this.#_;
		const { channels } = _thys;

		// Find channel by ID
		const channel = channels.get(channelId);
		if (!channel || typeof channel.close !== 'function') {
			// Unknown channel or nulled record - protocol violation, stop transport
			this.#logger.error(`Received chanClose for unknown or closed channel ${channelId}`);
			await this.stop();
			return;
		}

		// Fire and forget - don't block TCC reader
		channel.close({ discard }).catch((err) => {
			this.#logger.error('Error closing channel:', err);
		});
	}

	/**
	 * Handle incoming channel closed message
	 * @private
	 * @param {Object} request - Parsed request: { channelId }
	 */
	async #onChannelClosed (request) {
		const { channelId } = request;
		const _thys = this.#_;
		const { channels, channelTokens } = _thys;

		// Find channel by ID
		const channel = channels.get(channelId);
		if (!channel || typeof channel.onRemoteChanClosed !== 'function') {
			// Unknown channel or nulled record - protocol violation, stop transport
			this.#logger.error(`Received chanClosed for unknown or closed channel ${channelId}`);
			await this.stop();
			return;
		}

		// Get token and call channel's onRemoteChanClosed (fire and forget)
		const token = channelTokens.get(channel);
		channel.onRemoteChanClosed(token).catch((err) => {
			this.#logger.error('Error handling chanClosed:', err);
		});
	}

	/**
	 * Handle incoming channel request (remote request from other side)
	 * @private
	 * @param {Object} request - Parsed request: { channelName, maxBufferBytes, maxChunkBytes }
	 */
	async #onChannelRequest (request) {
		const { channelName, maxBufferBytes, maxChunkBytes } = request;
		const _thys = this.#_;
		const { channels, pendingChannelRequests } = _thys;

		// 1. Check if channel already exists
		const existing = channels.get(channelName);
		if (existing && existing.state === Channel.STATE_OPEN) {
			// Channel already exists - send rejection
			const response = JSON.stringify({
				name: channelName,
				accepted: false
			});
			const tcc = channels.get(CHANNEL_TCC);
			await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);
			return;
		}

		// 2. Emit 'newChannel' event with accept/reject methods
		// accept(options) - any handler calling accept() wins; options are merged across calls
		// reject() - compatibility no-op; channel is created if any handler calls accept()
		let accepted = false;
		const acceptOptions = {};
		let channelResolve;
		const channelPromise = new Promise ((res) => channelResolve = res);
		const event = Object.freeze({
			type: 'newChannel',
			detail: Object.freeze({ channelName, remoteLimits: Object.freeze({ maxBufferBytes, maxChunkBytes }) }),
			accept: (options = {}) => {
				accepted = true;
				Object.assign(acceptOptions, options);
				return channelPromise;
			},
			reject: () => { } // Compatibility no-op: channel is created if any handler calls accept()
		});
		await this.dispatchEvent(event);

		// 3. Check if channel was added while waiting for event handlers
		const existingAfterEvent = channels.get(channelName);

		// 4. Send response based on event handlers
		const tcc = channels.get(CHANNEL_TCC);
		if (accepted) {
			let channel, channelId;

			if (existingAfterEvent && existingAfterEvent.state !== Channel.STATE_CLOSED) {
				// Channel was created while waiting - use its existing ID
				channel = existingAfterEvent;
				channelId = channel.id;
			} else { // Need to (re)create channel
				if (existingAfterEvent) {
					// Reopen closed channel with original, active ID
					channelId = existingAfterEvent.id;
				} else {
					// Create (first-time) channel with new ID
					channelId = _thys.nextChannelId;
					_thys.nextChannelId += 2; // Increment by 2 for even/odd separation
				}

				// Merge acceptOptions with transport defaults
				const localLimit = acceptOptions.maxBufferBytes ?? _thys.maxBufferBytes;
				const chunkLimit = acceptOptions.maxChunkBytes
					? Math.min(acceptOptions.maxChunkBytes, _thys.maxChunkBytes, maxChunkBytes)
					: Math.min(_thys.maxChunkBytes, maxChunkBytes);
				channel = this.#createChannel(channelName, channelId, {
					localLimit,
					remoteLimit: maxBufferBytes,
					maxChunkBytes: chunkLimit
				});
			}

			// Send acceptance response
			const localMaxBufferBytes = acceptOptions.maxBufferBytes ?? _thys.maxBufferBytes;
			const localMaxChunkBytes = acceptOptions.maxChunkBytes
				? Math.min(acceptOptions.maxChunkBytes, _thys.maxChunkBytes)
				: _thys.maxChunkBytes;
			const response = JSON.stringify({
				name: channelName,
				accepted: true,
				id: channelId,
				maxBufferBytes: localMaxBufferBytes,
				maxChunkBytes: localMaxChunkBytes
			});
			if (this.state !== Transport.STATE_DISCONNECTED) await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);

			// Resolve the channelPromise so accept() callers get the channel (but only *after* sending request response)
			channelResolve(channel);

			// Resolve local pending request if exists
			// NOTE: Remote request = remote approval, so channel is ready now
			const pending = pendingChannelRequests.get(channelName);
			if (pending) {
				pending.resolve(channel);
				// DON'T delete pending request yet - we still need to receive response to OUR request
				// The pending request tracks OUR outgoing request lifecycle, not channel availability
			}
		} else {
			channelResolve(null); // Resolve unused .accept promise

			// Send rejection response
			const response = JSON.stringify({
				name: channelName,
				accepted: false
			});
			if (this.state !== Transport.STATE_DISCONNECTED) await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);

			// DON'T reject local pending request here!
			// "First accept or last reject" rule: Even if we reject the remote request,
			// the remote might still accept OUR request (messages are in-order, so they
			// will see our request before our reject response).
			// We must wait for the response to OUR request to complete the lifecycle.
		}
	}

	/**
	 * Handle incoming channel response (response to our local request)
	 * @private
	 * @param {Object} response - Parsed response: { name, accepted, id?, maxBufferBytes?, maxChunkBytes? }
	 */
	async #onChannelResponse (response) {
		const { name, accepted, id, maxBufferBytes, maxChunkBytes } = response;
		const _thys = this.#_;
		const { channels, channelTokens, pendingChannelRequests } = _thys;

		// 1. Lookup pending request
		const pending = pendingChannelRequests.get(name);
		if (!pending) {
			// No pending request - protocol violation
			this.logger.error(`Unexpected response (channel ${name})`);
			await this.stop();
			return;
		}

		// 2. Handle response
		if (accepted) {
			// Check if channel already exists (created by accepting remote request)
			const existing = channels.get(name);
			if (existing && existing?.state === Channel.STATE_CLOSED) {
				// Reopening nulled channel; reuse same id and token
				const { id, token } = existing;
				const channel = this.#createChannel(name, id, {
					localLimit: pending.options.maxBufferBytes,
					remoteLimit: maxBufferBytes,
					maxChunkBytes: Math.min(pending.options.maxChunkBytes, maxChunkBytes),
					token
				});
				pending.resolve(channel);
			} else if (existing) {
				// Channel was created by accepting remote request while we waited
				// Add the second role ID (perform ID switch if remote ID is lower)
				const token = channelTokens.get(existing);
				const ids = existing.idsRW(token);
				if (ids && !addRoleId(id, ids)) {
					const error = new Error('Failed to add role ID - duplicate or invalid');
					pending.reject(error);
				} else {
					// Register new ID in channels map
					channels.set(id, existing);
					// NOTE: Promise already resolved when we accepted remote request
					// This response just adds the second ID
				}
			} else {
				// Channel doesn't exist yet - create it now
				const channel = this.#createChannel(name, id, {
					localLimit: pending.options.maxBufferBytes,
					remoteLimit: maxBufferBytes,
					maxChunkBytes: Math.min(pending.options.maxChunkBytes, maxChunkBytes)
				});
				// Resolve promise with new channel
				pending.resolve(channel);
			}
		} else {
			// Request rejected by remote
			// Check if channel already exists (we accepted their request, they rejected ours)
			const existing = channels.get(name);
			if (existing) {
				// "First accept" rule: Channel exists because we accepted their request
				// Even though they rejected ours, the channel is valid and promise already resolved
				// Just clean up - don't reject the promise
			} else {
				// No channel exists - both sides rejected or we rejected and they rejected
				pending.reject(new Error('Channel request rejected by remote'));
			}
		}

		// 3. Clean up pending request (NOW we can delete it - response received)
		pendingChannelRequests.delete(name);
	}

	/**
	 * Immediately disconnect the transport (abrupt, non-negotiated shutdown).
	 * Called when stop({ disconnected: true }) is invoked.
	 * Does NOT send any TCC messages. Does NOT wait for remote responses.
	 * @private
	 */
	async #onDisconnect () {
		const _thys = this.#_;

		// Already in a terminal state: no-op
		if (_thys.state === Transport.STATE_STOPPED || _thys.state === Transport.STATE_DISCONNECTED) {
			return _thys.stopped?.promise;
		}

		// Transition to disconnected state
		_thys.state = Transport.STATE_DISCONNECTED;

		if (!_thys.stopped) {
			// No stopped promise yet - create one
			const stopped = _thys.stopped = { promise: null };
			stopped.promise = new Promise((res) => stopped.resolve = res);
		}

		// Reject all pending channel requests
		for (const [_name, request] of _thys.pendingChannelRequests) {
			if (request.reject) request.reject('Disconnected');
		}
		_thys.pendingChannelRequests.clear();

		// Disconnect all regular channels via close({ disconnected: token })
		const { channels, channelTokens } = _thys;
		for (const [channel, token] of channelTokens) {
			if (!(channel instanceof Channel)) continue;
			if (channel.id === CHANNEL_TCC || channel.id === CHANNEL_C2C) continue;
			channel.close({ disconnected: token }).catch(() => { });
		}

		// Disconnect TCC and C2C
		for (const channelId of [CHANNEL_TCC, CHANNEL_C2C]) {
			const channel = channels.get(channelId);
			if (channel && typeof channel.close === 'function') {
				const token = channelTokens.get(channel);
				if (token) channel.close({ disconnected: token }).catch(() => { });
			}
		}

		// Subclass cleanup (wake I/O waiters, clear timers — no I/O)
		await _thys.stop();

		_thys.bufferPool?.stop();

		// Stop promise tracer
		this.#promiseTracer?.stop();

		// Resolve stopped promise
		_thys.stopped.resolve();

		// Emit events
		await this.dispatchEvent('disconnected', {});
		await this.dispatchEvent('stopped', {});

		return _thys.stopped.promise;
	}

	/**
	 * Handle incoming tranStop message (remote is initiating stop)
	 * Initiates local stop if not already stopping.
	 * @private
	 * @param {Object} request - Parsed request
	 */
	async #onTransportStop (request) {
		const _thys = this.#_;
		if (_thys.state === Transport.STATE_ACTIVE) {
			// Remote initiated stop first - initiate our own stop (fire-and-forget)
			this.stop().catch((err) => {
				this.#logger.error('Error stopping transport after remote tranStop:', err);
			});
		}
		// All other states: already stopping or stopped - no action needed
	}

	/**
	 * Handle incoming tranStopped message (remote has completed its stop)
	 * @private
	 * @param {Object} request - Parsed request
	 */
	async #onTransportStopped (request) {
		const _thys = this.#_;
		const state = _thys.state;

		if (state === Transport.STATE_STOPPING) {
			// Remote is done, we're still working - transition to LOCAL_STOPPING
			_thys.state = Transport.STATE_LOCAL_STOPPING;
		} else if (state === Transport.STATE_REMOTE_STOPPING) {
			// Both sides done - finalize
			await this.#finalizeStop();
		}
		// LOCAL_STOPPING or other states: no-op
	}

	/**
	 * Get the promise tracer instance (if any)
	 * @returns {PromiseTracer|null}
	 */
	get promiseTracer () { return this.#promiseTracer; }

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

		// 1. Validate transport state
		if (state !== Transport.STATE_ACTIVE) {
			throw new StateError(`Transport is not active (${this.stateString})`);
		}

		// 2. Check if channel already exists and is open
		const existing = channels.get(name);
		if (existing && existing.state === Channel.STATE_OPEN) {
			return existing;
		}

		// 2b. Check if channel was disconnected (not reopenable)
		if (existing && existing.state === Channel.STATE_DISCONNECTED) {
			throw new StateError(`Channel "${name}" was disconnected and cannot be reopened`);
		}

		// 3. Check if request already pending - return existing promise
		const pending = pendingChannelRequests.get(name);
		if (pending) {
			return pending.promise;
		}

		// 4. Merge options with defaults
		const channelOptions = {
			maxBufferBytes: options.maxBufferBytes ?? _thys.maxBufferBytes,
			maxChunkBytes: options.maxChunkBytes ?? _thys.maxChunkBytes,
			lowBufferBytes: options.lowBufferBytes ?? _thys.lowBufferBytes
		};

		// 5. Create promise and store in #pendingChannelRequests
		const request = { options: channelOptions };
		request.promise = new Promise((resolve, reject) => [request.resolve, request.reject] = [resolve, reject]);
		pendingChannelRequests.set(name, request);

		// 5b. Trace promise if tracer is enabled
		this.#promiseTracer?.trace(request.promise, `Transport ${this.idTail} (${this.role}) requesting channel "${name}"`);

		// 6. Send control message via TCC
		const tcc = channels.get(CHANNEL_TCC);
		const requestData = JSON.stringify({
			channelName: name,
			maxBufferBytes: channelOptions.maxBufferBytes,
			maxChunkBytes: channelOptions.maxChunkBytes
		});
		await tcc.write(TCC_DTAM_CHAN_REQUEST[0], requestData);

		// 7. Return promise
		// NOTE: Promise resolves as soon as channel is ready (or rejected)
		// This can happen locally (accepting remote request) before remote response arrives
		return request.promise;
	}

	get role () { return this.#_.role; }

	/**
	 * Send a TCC message on behalf of a channel (e.g. chanClose, chanClosed)
	 * @param {symbol} token - Channel token (for authorization and ID lookup)
	 * @param {number} messageType - TCC message type id (must be TCC_DTAM_CHAN_CLOSE or TCC_DTAM_CHAN_CLOSED)
	 * @param {Object} options - Additional message fields (e.g. { discard })
	 */
	async sendTccMessage (token, messageType, options = {}) {
		// Validate message type
		if (messageType !== TCC_DTAM_CHAN_CLOSE[0] && messageType !== TCC_DTAM_CHAN_CLOSED[0]) {
			throw new RangeError(`Invalid TCC message type for sendTccMessage: ${messageType}`);
		}

		const _thys = this.#_;
		const { channels, channelTokens } = _thys;

		// Verify token and look up channel
		const channel = channelTokens.get(token);
		if (!channel) throw new Error('Unauthorized: unknown channel token');

		// Format and send message via TCC
		const tcc = channels.get(CHANNEL_TCC);
		const data = JSON.stringify({ channelId: channel.id, ...options });
		await tcc.write(messageType, data);
	}

	/**
	 * Send a transport-level TCC message (tranStop or tranStopped)
	 * @param {number} messageType - TCC_DTAM_TRAN_STOP[0] or TCC_DTAM_TRAN_STOPPED[0]
	 * @param {Object} options - Additional message fields
	 */
	async #sendTransportTccMessage (messageType, options = {}) {
		const _thys = this.#_;
		const tcc = _thys.channels.get(CHANNEL_TCC);
		const data = JSON.stringify(options);
		await tcc.write(messageType, data);
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
		case Transport.STATE_LOCAL_STOPPING:
		case Transport.STATE_REMOTE_STOPPING:
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
		return ['created', 'starting', 'active', 'stopping', 'localStopping', 'remoteStopping', 'stopped', 'disconnected'][this.#_.state];
	}

	/**
	 * Stop the transport and close all channels
	 * @param {Object} options - Close options
	 * @param {boolean} options.discard - Discard pending data (default: false)
	 * @param {boolean} options.disconnected - Trigger immediate disconnected shutdown (default: false)
	 * @param {number} options.timeout - Timeout in milliseconds
	 * @returns {Promise<void>} Promise resolving when the transport is stopped
	 */
	async stop (options = {}) {
		const _thys = this.#_;
		const { disconnected = false } = options;

		// Disconnected path: immediate, non-negotiated shutdown
		if (disconnected) {
			return this.#onDisconnect();
		}

		switch (_thys.state) {
		case Transport.STATE_STOPPING: // Already stopping - return stopping promise
		case Transport.STATE_LOCAL_STOPPING:
		case Transport.STATE_REMOTE_STOPPING:
		case Transport.STATE_STOPPED: // Already in terminal state
		case Transport.STATE_DISCONNECTED:
			return _thys.stopped?.promise;
		}

		_thys.state = Transport.STATE_STOPPING;
		const stopped = _thys.stopped = { promise: null };
		stopped.promise = new Promise((res) => stopped.resolve = res);

		const { discard = false, timeout } = options;

		// Emit beforeStopping event
		await this.dispatchEvent('beforeStopping', {});

		// Reject pending channel requests
		for (const [_name, request] of _thys.pendingChannelRequests) {
			if (request.reject) request.reject('Transport stopping');
		}

		// Notify remote that we are stopping (only if TCC exists, i.e. handshake completed)
		const tcc = _thys.channels.get(CHANNEL_TCC);
		if (tcc) await this.#sendTransportTccMessage(TCC_DTAM_TRAN_STOP[0]);

		// Close all regular channels
		const channelClosePromises = [];
		for (const [channel] of _thys.channelTokens) {
			if (!(channel instanceof Channel) || channel.id === CHANNEL_TCC || channel.id === CHANNEL_C2C) continue;
			channelClosePromises.push(channel.close({ discard }).catch(err => {
				this.#logger.error('Error closing channel:', err);
			}));
		}

		// Wait for all channels to close
		if (timeout) {
			let timer;
			await Promise.race([
				Promise.all(channelClosePromises),
				new Promise((resolve, reject) => timer = setTimeout(() => {
					if (_thys.state === Transport.STATE_DISCONNECTED) {
						// #onDisconnect can't take over the main promise if we reject here
						resolve();
					} else {
						// Allow a new .stop after a timeout to get a fresh promise
						_thys.stopped = null;
						reject('Transport shutdown timeout');
					}
				}, timeout))
			]);
			clearTimeout(timer);
		} else {
			await Promise.all(channelClosePromises);
		}

		if (_thys.state !== Transport.STATE_DISCONNECTED) {
			// Notify remote that our side is fully stopped (last write before clearing timer)
			if (tcc) await this.#sendTransportTccMessage(TCC_DTAM_TRAN_STOPPED[0]);

			if (!tcc || _thys.state === Transport.STATE_LOCAL_STOPPING) {
				// Either there's no TCC (because the handshake never completed)
				// or the remote already sent tranStopped - both sides done
				await this.#finalizeStop();
			} else {
				// Waiting for remote's tranStopped
				_thys.state = Transport.STATE_REMOTE_STOPPING;
			}
		}
		return stopped.promise;
	}

	// Subscribe to protected state (base stub)
	_sub_ () { }

	/**
	 * Execute the control-channel reader loop
	 * Reads TCC messages (de-chunked by default), parses JSON, handles messages
	 *
	 * NOTE: No manual chunk accumulation needed - Channel de-chunks by default
	 *
	 * @private
	 */
	async #tccReader () {
		const _thys = this.#_;
		const tcc = _thys.channels.get(CHANNEL_TCC);
		const { logger } = this;

		for (;;) {
			try {
				// Read complete message (de-chunked by default, decoded to text)
				const message = await tcc.read({ decode: true });
				if (!message) break; // Channel closed

				const { messageTypeId, text } = message;

				let skipAck = false;
				try {
					// Parse JSON data (already complete message thanks to default de-chunking)
					const parsed = text?.length ? JSON.parse(text) : {};

					// Handle control messages
					switch (messageTypeId) {
					case TCC_DTAM_CHAN_REQUEST[0]:
						await this.#onChannelRequest(parsed);
						break;
					case TCC_DTAM_CHAN_RESPONSE[0]:
						await this.#onChannelResponse(parsed);
						break;
					case TCC_DTAM_CHAN_CLOSE[0]:
						await this.#onChannelClose(parsed);
						break;
					case TCC_DTAM_CHAN_CLOSED[0]:
						await this.#onChannelClosed(parsed);
						break;
					case TCC_DTAM_TRAN_STOP[0]:
						await this.#onTransportStop(parsed);
						skipAck = true;
						break;
					case TCC_DTAM_TRAN_STOPPED[0]:
						await this.#onTransportStopped(parsed);
						skipAck = true; // tranStopped is the final message; no need to ACK
						break;
					case TCC_CTLM_MESG_TYPE_REG_REQ[0]:
						// Message-type registration currently unsupported on TCC
						break;
					case TCC_CTLM_MESG_TYPE_REG_RESP[0]:
						break;
					default:
						// Unknown message type - protocol violation
						logger.error(`Unknown TCC message type ${messageTypeId}; stopping transport`);
						await this.stop();
					}
				} finally {
					// Mark message as processed (enables backpressure) unless skipping ACK
					if (!skipAck) message.done();
				}
			} catch (err) {
				// Channel closed or error - exit reader loop
				if (err instanceof Error) logger.error('TCC reader error:', err);
				break;
			}
		}
	}
}
