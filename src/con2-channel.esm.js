/*
 * Con2Channel - Channel sub-class implementing the console-content channel (C2C)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from './channel.esm.js';
import {
	// Foundational console-content-channel types
	C2C_MESG_TRACE,
	C2C_MESG_DEBUG,
	C2C_MESG_INFO,
	C2C_MESG_WARN,
	C2C_MESG_ERROR
} from './protocol.esm.js';

export class Con2Channel extends Channel {
	#_;

	constructor (options) {
		super(options);
		this._get_();
		this.#preloadMessageTypes();
	}

	/* async */ close ({ disconnect, shutdown } = {}) {
		if (disconnect && disconnect === this.#_.token) {
			// Transport-initiated shutdown: finalize the channel to terminate the reader loop
			return this.#_.onDisconnect();
		}
		if (shutdown && shutdown === this.#_.token) {
			// Transport-initiated shutdown: finalize the channel to terminate any reader loops
			return this.#_.onShutDown();
		}
		const logger = this.#_.transport.logger;
		logger.warn('Console Content Channel .close ignored');
		return Promise.resolve();
	}

	/*
	 * Pre-load channel's message-type id <-> name mappings
	 */
	#preloadMessageTypes () {
		const types = this.#_.messageTypes;
		for (const [id, type] of [
			C2C_MESG_TRACE,
			C2C_MESG_DEBUG,
			C2C_MESG_INFO,
			C2C_MESG_WARN,
			C2C_MESG_ERROR
		]) {
			const entry = { type, ids: [id] };
			types.set(id, entry);
			types.set(type, entry);
		}
	}

	// Subscribe to private state (called by base constructor)
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot);
	}

	// Helper methods to write with the appropriate message type

	debug (text) {
		return this.write(C2C_MESG_DEBUG[0], text);
	}

	error (text) {
		return this.write(C2C_MESG_ERROR[0], text);
	}

	info (text) {
		return this.write(C2C_MESG_INFO[0], text);
	}

	trace (text) {
		return this.write(C2C_MESG_TRACE[0], text);
	}

	warn (text) {
		return this.write(C2C_MESG_WARN[0], text);
	}
}
