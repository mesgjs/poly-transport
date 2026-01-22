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
	#state;

	constructor (options) {
		super(options);
		this.#preloadMessageTypes();
	}

	/*
	 * Pre-load channel's message-type id <-> name mappings
	 */
	#preloadMessageTypes () {
		const state = this.#state;
		const types = state.messageTypes;
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

	// Thread private state (called by base constructor)
	_setState (state) {
		if (!this.#state) {
			super._setState(state);
			this.#state = state;
		}
	}
}
