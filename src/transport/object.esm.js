/*
 * Object-Stream-Based Transport Class
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '../channel.esm.js';
import { Transport } from './base.esm.js';
import { HDR_TYPE_ACK, PROTOCOL } from '../protocol.esm.js';

export class ObjectTransport extends Transport {
	#state;

	constructor (options = {}) {
		super(options);
		this._getState();
	}

	// Expect object transports to not require text encoding
	get needsEncodedText () { return false; }

	/**
	 * Subscribe to private state
	 * @param {Set} subs - Subscribers Set
	 */
	_subState (subs) {
		super._subState(subs);
		subs.add((s) => this.#state ||= s); // Set #state once
	}
}
