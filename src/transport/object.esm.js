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

	/**
	 * Send a message (object-stream version)
	 * @param {symbol} token
	 * @param {Object} header
	 * @param {*} data
	 */
	async sendMessage (token, header, data) {
		const state = this.#state;
		const channel = state.channelTokens.get(token);
		if (typeof token !== 'symbol' || !(channel instanceof Channel)) {
			throw new Error('Unauthorized sendMessage');
		}
	}

	/**
	 * Thread and extend the private state
	 * @param {Object} state - The private state
	 */
	_setState (state) {
		if (!this.#state) {
			this.#state = state;
			super._setState(state);
			// Object.assign(state, {
			// });
		}
	}
}
