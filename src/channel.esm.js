/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Channel
 */

/**
 * ChannelState error
 */
export class ChannelStateError extends Error {
	constructor (message = 'Wrong channel state for requested operation', details) {
		super(message);
		this.name = this.constructor.name;
		this.details = details;
	}
}

/**
 * DuplicateReader error
 */
export class DuplicateReaderError extends Error {
	constructor (message = 'Duplicate reader detected') {
		super(message);
		this.name = this.constructor.name;
	}
}

