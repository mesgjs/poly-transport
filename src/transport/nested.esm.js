/*
 * Nested (PTOC) Transport Class
 *
 * PolyTransport-over-Channel: a byte-stream transport that runs over a dedicated
 * message type on a parent PolyTransport channel.
 *
 * Usage:
 *   // Parent transport and channel must already be set up
 *   const [parentA, parentB] = await makeTransportPair();
 *   const [chanA, chanB] = await makeConnectedChannel(parentA, parentB, 'ptoc');
 *
 *   // Message type must be pre-negotiated on the channel (if string)
 *   await chanA.addMessageTypes(['ptoc-data']);
 *
 *   const nestedA = new NestedTransport({ channel: chanA, messageType: 'ptoc-data' });
 *   const nestedB = new NestedTransport({ channel: chanB, messageType: 'ptoc-data' });
 *   await Promise.all([nestedA.start(), nestedB.start()]);
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ByteTransport } from './byte.esm.js';
import { Transport, StateError } from './base.esm.js';
import { Channel } from '../channel.esm.js';

export class NestedTransport extends ByteTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Start the byte reader.
		 * Calls super.startReader() (which starts the protocol parser / #byteReader),
		 * then launches the channel reader that feeds raw bytes into receiveBytes().
		 */
		startReader () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			super.startReader(); // Starts ByteTransport's #byteReader (protocol parser)
			thys.#channelReader(); // Runs the actual channel I/O reader
		},

		/**
		 * Transport-specific stop: drain output buffer, clear write timer.
		 * Does NOT close the parent channel - caller manages channel lifecycle.
		 * Called by Transport base class #finalizeStop() and #onDisconnect().
		 */
		async stop () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Let ByteTransport drain the output buffer and clear the write timer
			await super.stop();
			// Note: We do NOT close the parent channel here.
			// The parent channel's lifetime is independent of the PTOC transport.
		},

		/**
		 * Write committed bytes from the output ring buffer to the parent channel.
		 * Writes with eom: false - PTOC traffic is a raw byte stream, not message-delimited.
		 * Called by scheduleWrite() when there is committed data to send.
		 */
		async writeBytes () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;

			// Loop to drain all committed data, including any newly committed
			// while we were awaiting channel.write() in a previous iteration.
			while (outputBuffer.committed > 0) {
				const committed = outputBuffer.committed;
				const buffers = outputBuffer.getBuffers(committed);

				try {
					const channel = thys.#channel;
					if (!channel) break;
					for (const buf of buffers) {
						// Write with eom: false - PTOC is a raw byte stream
						// console.log('nested write', thys.idTail, buf);
						await channel.write(thys.#messageType, buf, { eom: false });
					}
				} catch (err) {
					// Write failed - connection lost or channel closing
					// StateError is expected when the parent channel is closing/closed during shutdown
					if (err instanceof StateError) {
						thys.logger.debug('NestedTransport: write error', err);
					} else {
						thys.logger.error('NestedTransport: write error', err);
					}
					_thys.onDisconnect();
					return;
				}

				outputBuffer.release(committed);
			}

			_thys.afterWrite();
		},
	}, super.__protected));

	#_; // NestedTransport-level view of shared protected state
	#channel; // Parent channel
	#messageType; // Dedicated message type for PTOC traffic

	/**
	 * @param {object} options
	 * @param {Channel} options.channel - Pre-opened parent channel (caller manages lifecycle)
	 * @param {number|string} options.messageType - Dedicated message type for PTOC traffic.
	 *   If a string, it must already be registered on the channel via addMessageTypes().
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		const { channel, messageType } = options;
		if (!(channel instanceof Channel)) throw new TypeError('NestedTransport: options.channel is required');
		if (typeof messageType !== 'number' && typeof messageType !== 'string') {
			throw new TypeError('NestedTransport: string or numeric options.messageType is required');
		}
		if (typeof messageType === 'string' && !channel.getMessageType(messageType)) {
			throw new RangeError(`NestedTransport: message type "${messageType}" is not registered`);
		}
		this.#channel = channel;
		this.#messageType = messageType;

		// Listen for parent channel lifecycle events
		channel.addEventListener('beforeClose', () => {
			// Parent channel is about to close - initiate graceful PTOC stop
			this.stop().catch((err) => {
				this.logger.error('NestedTransport: error stopping on channel beforeClose', err);
			});
		});

		channel.addEventListener('closed', () => {
			// Parent channel has closed - PTOC must disconnect immediately
			super.stop({ disconnected: true }).catch((err) => {
				this.logger.error('NestedTransport: error disconnecting on channel closed', err);
			});
		});

		channel.addEventListener('disconnected', () => {
			// Parent channel was abruptly disconnected - PTOC must disconnect immediately
			super.stop({ disconnected: true }).catch((err) => {
				this.logger.error('NestedTransport: error disconnecting on channel disconnected', err);
			});
		});
	}

	/**
	 * Run the channel I/O reader loop.
	 * Reads binary chunks from the parent channel and feeds them to receiveBytes().
	 * Runs until the channel closes normally (graceful stop) or an error occurs (disconnect).
	 */
	async #channelReader () {
		const _thys = this.#_;
		const channel = this.#channel;
		const messageType = this.#messageType;
		const { bufferPool } = _thys;

		try {
			while (true) { // Read until closed by transport or channel
				const message = await channel.read({ only: messageType, dechunk: false });
				if (!message) break;

				message.process(() => {
					// Feed binary data into the PTOC input buffer
					if (message.data) {
						// Copy data before calling message.done() - the VirtualBuffer segments are
						// backed by pool buffers that may be released (zeroed) after message.done().
						// Use toPool() if a buffer pool is available (efficient reuse), otherwise
						// fall back to toUint8Array() (allocates a new buffer).
						const copiedData = bufferPool
							? message.data.toPool(bufferPool)
							: message.data.toUint8Array();
						// console.log('nested read', this.idTail, copiedData);
						_thys.receiveBytes(copiedData);
					// } else {
						// this.logger.debug('NestedTransport: read without data on', this.idTail);
					}
				});
			}
		} finally {
			const state = _thys.state;
			if (state !== Transport.STATE_STOPPED && state !== Transport.STATE_REMOTE_STOPPING) {
				_thys.onDisconnect();
			}
		}
	}

	/**
	 * Override stop() to redirect user-initiated disconnected stops to graceful stops.
	 *
	 * When a user calls ptocTransport.stop({ disconnected: true }), the underlying
	 * channel is still alive, so a graceful stop is appropriate.
	 *
	 * Only parent channel events (which call super.stop({ disconnected: true }) directly,
	 * bypassing this override) trigger actual disconnected stops.
	 *
	 * @param {object} options
	 * @param {boolean} options.disconnected - If true, redirect to graceful stop
	 */
	async stop (options = {}) {
		/*
		 * Unlike most other transports, there's no obvious sign if one PTOC
		 * endpoint "ghosts" the other, so stop based on host-channel events
		 * instead of the user-supplied options.
		 */
		return super.stop({ ...options, disconnected: false });
	}

	/**
	 * Subscribe to protected state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
