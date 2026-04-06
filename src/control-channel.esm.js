/*
 * ControlChannel - Channel sub-class implementing the transport control channel (TCC)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from './channel.esm.js';
import {
	// Foundational transport-control-channel types
	TCC_DTAM_CHAN_REQUEST,
	TCC_DTAM_CHAN_RESPONSE,
	TCC_CTLM_MESG_TYPE_REG_REQ,
	TCC_CTLM_MESG_TYPE_REG_RESP,
	TCC_DTAM_TRAN_STOP,
	TCC_DTAM_TRAN_STOPPED,
} from './protocol.esm.js';

/**
 * ControlChannel - Just a Channel with pre-loaded message types
 *
 * No business logic, no reader loop, no state management.
 * Transport owns all channel lifecycle logic and reads from this channel.
 */
export class ControlChannel extends Channel {
	#_;

	constructor (options) {
		super(options);
		this._get_();
		this.#preloadMessageTypes();
	}

	/* async */ close ({ shutdown } = {}) {
		if (shutdown && shutdown === this.#_.token) {
			// Transport-initiated shutdown: finalize the channel to terminate the reader loop
			return this.#_.onShutDown();
		}
		const logger = this.#_.transport.logger;
		logger.warn('Transport Control Channel .close ignored');
		// return Promise.resolve();
		throw new Error('TCC.close should only be for shutdown');
	}

	/**
	 * Pre-load channel's message-type id <-> name mappings
	 * This avoids round-trip negotiation for foundational message types
	 * @private
	 */
	#preloadMessageTypes () {
		const types = this.#_.messageTypes;
		for (const [id, type] of [
			TCC_DTAM_CHAN_REQUEST,
			TCC_DTAM_CHAN_RESPONSE,
			TCC_CTLM_MESG_TYPE_REG_REQ,
			TCC_CTLM_MESG_TYPE_REG_RESP,
			TCC_DTAM_TRAN_STOP,
			TCC_DTAM_TRAN_STOPPED,
		]) {
			const entry = { type, ids: [id] };
			types.set(id, entry);
			types.set(type, entry);
		}
	}

	/**
	 * Next expected receive sequence number (for testing/simulation)
	 */
	get nextReadSeq () {
		return this.#_.flowControl.nextReadSeq;
	}

	// Subscribe to private state (called by base constructor)
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}
}
