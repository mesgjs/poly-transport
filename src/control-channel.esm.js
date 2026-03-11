/*
 * ControlChannel - Channel sub-class implementing the transport control channel (TCC)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from './channel.esm.js';
import {
	// Foundational transport-control-channel types
	TCC_DTAM_TRAN_STOP,
	TCC_DTAM_CHAN_REQUEST,
	TCC_DTAM_CHAN_RESPONSE,
	TCC_CTLM_MESG_TYPE_REG_REQ,
	TCC_CTLM_MESG_TYPE_REG_RESP
} from './protocol.esm.js';

export class ControlChannel extends Channel {
	#_;
	#pendingRequests = new Map(); // channelName -> { responsePromise, responseResolve, responseReject, options }

	constructor (options) {
		super(options);
		this._get_();
		this.#preloadMessageTypes();
		this.#startResponseReader();
	}

	/**
	 * Start the response reader loop
	 * Continuously reads TCC data messages and dispatches to handlers
	 */
	async #startResponseReader () {
		while (true) {
			try {
				const message = await this.read();
				if (!message) break; // Channel closed

				const { header } = message;
				const { messageType } = header;

				// Dispatch based on message type
				switch (messageType) {
				case TCC_DTAM_CHAN_RESPONSE[0]:
					await this.#onChannelResponse(message);
					break;
				// Add other TCC message handlers here as needed
				default:
					// Unknown message type - mark as processed
					message.done();
				}
			} catch (err) {
				// Channel closed or error - exit reader loop
				break;
			}
		}
	}

	/**
	 * Handle channel response message
	 * @param {Object} message - Message from read()
	 */
	async #onChannelResponse (message) {
		try {
			// Parse JSON response
			const response = JSON.parse(message.data);
			const { name, accepted, id, maxBufferBytes, maxChunkBytes } = response;

			// Get pending request
			const pending = this.#pendingRequests.get(name);
			if (!pending) {
				// No pending request - protocol violation
				throw new Error(`Unexpected channel response for "${name}"`);
			}

			// Remove pending request
			this.#pendingRequests.delete(name);

			if (accepted) {
				// Resolve response promise with channel info
				pending.responseResolve({
					name,
					id,
					remoteLimits: {
						maxBufferBytes,
						maxChunkBytes
					}
				});
			} else {
				// Reject response promise
				pending.responseReject(new Error(`Channel request rejected`));
			}
		} finally {
			// Mark message as processed
			message.done();
		}
	}

	/*
	 * Pre-load channel's message-type id <-> name mappings
	 */
	#preloadMessageTypes () {
		const types = this.#_.messageTypes;
		for (const [id, name] of [
			TCC_DTAM_TRAN_STOP,
			TCC_DTAM_CHAN_REQUEST,
			TCC_DTAM_CHAN_RESPONSE,
			TCC_CTLM_MESG_TYPE_REG_REQ,
			TCC_CTLM_MESG_TYPE_REG_RESP
		]) {
			types.set(id, name);
			types.set(name, id);
		}
	}

	/**
	 * Send a request to open a new channel
	 * Called by transport.requestChannel
	 * @param {string} channelName - The name of the channel
	 * @param {Object} options - Channel options (maxBufferBytes, maxChunkBytes)
	 * @param {Promise} responsePromise - Promise created by transport, to be resolved when response arrives
	 * @param {Function} responseResolve - Resolve function for responsePromise
	 * @param {Function} responseReject - Reject function for responsePromise
	 */
	async requestChannel (channelName, options, responsePromise, responseResolve, responseReject) {
		// Check if request already pending - reuse existing
		const existing = this.#pendingRequests.get(channelName);
		if (existing) {
			// Already pending - don't send another request
			throw new Error(`Transport forwarded duplicate request for channel ${channelName}`);
		}

		// Store pending request
		const pending = {
			responsePromise,
			responseResolve,
			responseReject,
			options
		};
		this.#pendingRequests.set(channelName, pending);

		// Send TCC request message
		const request = JSON.stringify({
			channelName,
			maxBufferBytes: options.maxBufferBytes,
			maxChunkBytes: options.maxChunkBytes
		});
		await this.write(TCC_DTAM_CHAN_REQUEST[0], request);
	}

	// Subscribe to private state (called by base constructor)
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}
}
