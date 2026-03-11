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

	constructor (options) {
		super(options);
		this._get_();
		this.#preloadMessageTypes();
	}

	/**
	 * Channel-request response reader
	 */
	onChannelResponse () {
		//
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
	 */
	requestChannel (channelName) {
		const request = JSON.stringify({
			channelName
		});
		this.write(TCC_DTAM_CHAN_REQUEST, request);
	}

	// Subscribe to private state (called by base constructor)
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}
}
