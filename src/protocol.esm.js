/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Protocol Layer
 *
 * Handles message encoding/decoding for the binary protocol.
 * Encoding methods write directly into VirtualRWBuffer or DataView for zero-copy operation.
 */

// Protocol constants (requirements.md:636-641, Update 2026-01-08-A)
export const DATA_HEADER_BYTES = 18;
export const MAX_HEADER_BYTES = 514; // 255 * 2 + 4 (biggest "additional" encoding)
export const MIN_DATA_RES_BYTES = 4;
export const MIN_ACK_BYTES = 14; // even(13) (base without ranges)
export const MAX_ACK_BYTES = 514; // Same as MAX_HEADER_BYTeS
export const MAX_ACK_RANGES = 501; // 514 - 13 = 501 for ranges
export const RESERVE_ACK_BYTES = MAX_ACK_BYTES; // Reserved when sending control or data messages

// Header type constants (requirements.md:415-421)
export const HDR_TYPE_ACK = 0;
export const HDR_TYPE_CHAN_CONTROL = 1;
export const HDR_TYPE_CHAN_DATA = 2;
export const HDR_TYPE_HANDSHAKE = 'handshake'; // For object-stream transports

// Byte-stream-transport greeting and start-byte-stream sequences
export const PROTOCOL = 'PolyTransport';
export const GREET_CONFIG_PREFIX = '\x02' + PROTOCOL + ':';
export const GREET_CONFIG_SUFFIX = '\x03\n';
export const START_BYTE_STREAM = '\x02\x01\x03\n';

// Default transport configuration (requirements.md:406-413)
export const MIN_CHANNEL_ID = 2;
export const MIN_MESG_TYPE_ID = 256;
const DEFAULT_CONFIG = {
	version: 1,
	c2cEnabled: false,
	minChannelId: MIN_CHANNEL_ID,
	minMessageTypeId: MIN_MESG_TYPE_ID
};

// Flag constants
export const FLAG_EOM = 0x0001;  // End of message

// Foundational channel constants
// (Channels not required at transport start should be registered/mapped)
export const CHANNEL_TCC = 0;  // Transport-Control Channel
export const CHANNEL_C2C = 1;  // Console-Content Channel

// TCC pre-defined (foundational) message types (requirements.md:482-493)
// (One shared namespace for TCC control/data and control on all channels)
// (Message-types not required at transport start should be registered/mapped)
export const TCC_DTAM_CHAN_REQUEST = [1, 'chanReq'];
export const TCC_DTAM_CHAN_RESPONSE = [2, 'chanResp'];
export const TCC_CTLM_MESG_TYPE_REG_REQ = [3, 'mesgTypeReq']; // message-type registration request
export const TCC_CTLM_MESG_TYPE_REG_RESP = [4, 'mesgTypeResp']; // message-type registration response
export const TCC_DTAM_CHAN_CLOSE = [5, 'chanClose']; // channel close initiation
export const TCC_DTAM_CHAN_CLOSED = [6, 'chanClosed']; // channel close completion
export const TCC_DTAM_TRAN_STOP = [7, 'tranStop']; // transport stop initiation
export const TCC_DTAM_TRAN_STOPPED = [8, 'tranStopped']; // transport stop completion

// C2C pre-defined (foundational) message types (requirements.md:495-505)
// (Message-types not required at transport start should be registered/mapped)
export const C2C_MESG_TRACE = [0, 'trace'];
export const C2C_MESG_DEBUG = [1, 'debug'];
export const C2C_MESG_INFO = [2, 'info'];
export const C2C_MESG_WARN = [3, 'warn'];
export const C2C_MESG_ERROR = [4, 'error'];

/**
 * Helpers: Round up to even/odd number
 */
export const toEven = (v) => (v & 1) ? (v + 1) : v;
export const toOdd = (v) => (v & 1) ? v : (v + 1);

/**
 * Helper to add an even or odd role id (stored in ascending order, allowing one of each)
 * @param {number} id - Id candidate to be added
 * @param {number[]} ids - 0/1/2-element set of ids
 * @returns {boolean} Success (true) or error (false)
 */
export function addRoleId (id, ids) {
	if (!Array.isArray(ids) || typeof id !== 'number') {
		throw new TypeError('Invalid addRoleId parameter');
	}
	if (ids.length === 0) {
		ids[0] = id; // First id
		return true;
	}
	// There are 1 or 2 already
	if (id === ids[0] || id === ids[1]) {
		return true; // Existing id
	}
	if (ids.length > 1) {
		return false; // Too many!
	}
	// There's only 1 right now
	if (id % 2 === ids[0] % 2) {
		return false; // Only one id allowed per even/odd parity
	}
	if (id < ids[0]) {
		ids.unshift(id); // New id is smaller: insert
	} else {
		ids[1] = id; // New id is larger: append
	}
	return true;
}

/**
 * Additional-bytes helpers
 * totalToEncAddl: *total* bytes (including type + remaining-size bytes) to encoded-additional
 * addlToEncAddl: *additional* bytes to encoded-additional
 * encAddlToAddl: encoded-additional to additional header bytes (how much more buffer is required before the rest of header parsing can be completed)
 * encAddlToTotal: encoded-additional to total header bytes
 */
export const totalToEncAddl = (bytes) => (bytes - 4) >> 1;
export const addlToEncAddl = (bytes) => (bytes - 2) >> 1;
export const encAddlToAddl = (enc) => (enc << 1) + 2;
export const encAddlToTotal = (enc) => (enc << 1) + 4;

/**
 * Calculate ACK header size in bytes (always even-padded)
 * (Note: This is the *total* size, not additional bytes)
 * Formula: toEven(13 + rangeCount)
 *
 * @param {number} rangeCount - Number of *range* bytes (should be 0 or odd)
 * @returns {number} Header size in bytes
 */
export function ackHeaderSize (rangeCount) {
	if (!Number.isInteger(rangeCount) || rangeCount < 0 || rangeCount > MAX_ACK_RANGES) {
		throw new RangeError(`rangeCount must be an integer in [0, ${MAX_ACK_RANGES}]`);
	}
	return toEven(13 + rangeCount);
}

/**
 * Calculate channel header size in bytes (always 18)
 *
 * @returns {number} Header size in bytes
 */
export function channelHeaderSize () {
	return DATA_HEADER_BYTES;
}

/**
 * Encode ACK header directly into target buffer
 *
 * Format (requirements.md:442-456, Update 2026-01-08-A):
 * - 1B: 0 (ACK type)
 * - 1B: remaining message size = (actualBytes - 2) >> 1
 * - 2B: flags
 * - 4B: transport local channel number
 * - 4B: base remote sequence number
 * - 1B: include count (0 or # of *include* ranges); e.g. 5 => 5 include + 4 skip (9 range bytes)
 * - Variable: range bytes (alternating include/skip/include)
 * - Pad byte if needed (zeroed for security)
 *
 * @param {VirtualRWBuffer|DataView} target - Target buffer with DataView-compatible API
 * @param {number} offset - Offset in target buffer
 * @param {Object} fields - { channelId, baseSequence, flags=0, ranges=[] }
 * @returns {number} Header size in bytes
 */
export function encodeAckHeaderInto (target, offset, fields) {
	if (!target || typeof target.setUint8 !== 'function') {
		throw new TypeError('Target must have DataView-compatible API (setUint8, setUint16, setUint32)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('Offset out of range');
	}

	const { channelId, baseSequence, flags = 0, ranges = [] } = fields;

	if (!Array.isArray(ranges)) {
		throw new TypeError('Ranges must be an array');
	}

	const rangeCount = ranges.length;
	const bytesAvailable = target.byteLength - offset;
	const maxRanges = maxAckRanges(bytesAvailable);

	if (rangeCount > maxRanges) {
		throw new RangeError('Too many ranges for available space');
	}
	if (rangeCount && !(rangeCount & 1)) {
		throw new RangeError('Range count must be zero or odd');
	}

	// Calculate encoded remaining size
	const headerSize = ackHeaderSize(rangeCount);
	const remainingSize = totalToEncAddl(headerSize);
	const includeCount = rangeCount ? ((rangeCount + 1) / 2) : 0;

	let o = offset;
	target.setUint8(o++, HDR_TYPE_ACK);
	target.setUint8(o++, remainingSize);
	target.setUint16(o, flags); o += 2;
	target.setUint32(o, channelId); o += 4;
	target.setUint32(o, baseSequence); o += 4;
	target.setUint8(o++, includeCount);

	for (const range of ranges) {
		target.setUint8(o++, range);
	}

	// Zero-pad requirement is handled by ArrayBuffer constructor or zero-on-release strategy
	return headerSize;
}

/**
 * Encode channel control or data header directly into target buffer
 *
 * Format (requirements.md:469-480):
 * - 1B: 1 (control) or 2 (data)
 * - 1B: remaining header size = 7 (for 18-byte header: (16-2)>>1 = 7)
 * - 4B: total data size (bytes)
 * - 2B: flags (+1: EOM)
 * - 4B: remote transport channel number
 * - 4B: local channel sequence number
 * - 2B: remote message type
 * Total: 18 bytes (DATA_HEADER_BYTES)
 *
 * @param {VirtualRWBuffer|DataView} target - Target buffer with DataView-compatible API
 * @param {number} offset - Offset in target buffer
 * @param {number} type - HDR_TYPE_CHAN_CONTROL or HDR_TYPE_CHAN_DATA
 * @param {Object} fields - { dataSize=0, flags=0, channelId, sequence, messageType }
 * @returns {number} Header size in bytes (always 18)
 */
export function encodeChannelHeaderInto (target, offset, type, fields) {
	if (!target || typeof target.setUint8 !== 'function') {
		throw new TypeError('target must have DataView-compatible API (setUint8, setUint16, setUint32)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}
	if (type !== HDR_TYPE_CHAN_CONTROL && type !== HDR_TYPE_CHAN_DATA) {
		throw new Error(`Invalid channel message type: ${type}`);
	}

	const { dataSize = 0, flags = 0, channelId, sequence, messageType } = fields;

	let o = offset;
	target.setUint8(o++, type);
	target.setUint8(o++, totalToEncAddl(DATA_HEADER_BYTES));
	target.setUint32(o, dataSize); o += 4;
	target.setUint16(o, flags); o += 2;
	target.setUint32(o, channelId); o += 4;
	target.setUint32(o, sequence); o += 4;
	target.setUint16(o, messageType); o += 2;

	return DATA_HEADER_BYTES;
}

/**
 * Decode ACK header from buffer
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing ACK header
 * @param {number} offset - Offset in buffer
 * @returns {Object} Decoded ACK header
 */
export function decodeAckHeaderFrom (buffer, offset = 0) {
	const headerSize = decodeHeaderSizeFromPrefix(buffer, offset);
	const length = buffer.length || buffer.byteLength;
	if (headerSize === null || length - offset < headerSize) {
		throw new Error('Buffer too small for ACK header');
	}

	let o = offset;
	const type = buffer.getUint8(o++);
	const sizeByte = buffer.getUint8(o++);
	const flags = buffer.getUint16(o); o += 2;
	const channelId = buffer.getUint32(o); o += 4;
	const baseSequence = buffer.getUint32(o); o += 4;
	const includeCount = buffer.getUint8(o++);
	// Include count => range count
	// 0 -> 0 bytes; 1 -> 1 include (1 byte); 2 -> include/skip/include (3 bytes)
	const rangeCount = includeCount ? (includeCount * 2 - 1) : 0;

	const ranges = [];
	for (let i = 0; i < rangeCount; i++) {
		ranges.push(buffer.getUint8(o++));
	}

	return {
		type,
		headerSize: encAddlToTotal(sizeByte),
		flags,
		channelId,
		baseSequence,
		rangeCount,
		ranges
	};
}

/**
 * Decode channel control or data header from buffer
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing channel header
 * @param {number} offset - Offset in buffer
 * @returns {Object} Decoded channel header
 */
export function decodeChannelHeaderFrom (buffer, offset = 0) {
	const length = buffer.length || buffer.byteLength;
	if (length - offset < DATA_HEADER_BYTES) {
		throw new Error('Buffer too small for channel header');
	}

	let o = offset;
	const type = buffer.getUint8(o++);
	o++;  // Skip size byte

	const dataSize = buffer.getUint32(o); o += 4;
	const flags = buffer.getUint16(o); o += 2;
	const channelId = buffer.getUint32(o); o += 4;
	const sequence = buffer.getUint32(o); o += 4;
	const messageType = buffer.getUint16(o); o += 2;

	return {
		type,
		headerSize: DATA_HEADER_BYTES,
		dataSize,
		flags,
		channelId,
		sequence,
		messageType,
		eom: (flags & FLAG_EOM) !== 0
	};
}

/**
 * Decode header size from first 2 bytes of buffer
 * Returns null if fewer than 2 bytes available
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing header
 * @param {number} offset - Offset in buffer
 * @returns {number|null} Header size in bytes, or null if incomplete
 */
export function decodeHeaderSizeFromPrefix (buffer, offset = 0) {
	if (!buffer || typeof buffer.getUint8 !== 'function') {
		throw new TypeError('buffer must have DataView-compatible API (getUint8)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}

	// Get length from buffer
	const length = buffer.length || buffer.byteLength;
	if (length - offset < 2) {
		return null;
	}

	const type = buffer.getUint8(offset);
	const sizeByte = buffer.getUint8(offset + 1);

	switch (type) {
	case HDR_TYPE_ACK:
	case HDR_TYPE_CHAN_CONTROL:
	case HDR_TYPE_CHAN_DATA:
		return encAddlToTotal(sizeByte);
	}

	throw new Error(`Unknown message type: ${type}`);
}

/**
 * Encode transport handshake directly into target buffer
 * Format: \x02PolyTransport\x03 \x02{...}\x03 \x01
 *
 * @param {VirtualRWBuffer} target - Target buffer for writing
 * @param {number} offset - Offset in target buffer
 * @param {Object} config - Transport configuration
 * @returns {number} Number of bytes written
 */
export function encodeHandshakeInto (target, offset, config = {}) {
	if (typeof target?.encodeFrom !== 'function') {
		throw new TypeError('target does not support encodeFrom()');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}

	// Merge with defaults
	const fullConfig = { ...DEFAULT_CONFIG, ...config };

	// Text of handshake message (greeting and configuration only)
	const handshakeText = GREET_CONFIG_PREFIX + JSON.stringify(fullConfig) + GREET_CONFIG_SUFFIX;
	const { written } = target.encodeFrom(handshakeText, offset);
	return written;
}

/**
 * Return the maximum number of ranges capable of fitting in an ACK messages of a given size
 * @param {*} availableBytes
 * @returns
 */
export function maxAckRanges (availableBytes) {
	if (!Number.isInteger(availableBytes) || availableBytes < MIN_ACK_BYTES || availableBytes > MAX_ACK_BYTES) {
		throw new RangeError('Invalid available bytes for maxAckRanges');
	}
	const maxRanges = availableBytes - 13;
	return ((maxRanges % 2) ? maxRanges : (maxRanges - 1));
}

/**
 * Protocol violation error for flow control issues.
 */
export class ProtocolViolationError extends Error {
	/**
	 * Create a new ProtocolViolationError.
	 * @param {string} description - Description ('Out of order', 'Over budget', 'Duplicate ACK', etc)
	 * @param {object} details - Additional context
	 */
	constructor (description, details) {
		super(`Protocol violation: ${description}`);
		this.description = this.reason = description;
		this.details = details;
	}

	get name () { return this.constructor.name; }
}

/**
 * State error for operations incompatible with current channel/transport state.
 */
export class StateError extends Error {
	/**
	 * Create a new StateError.
	 * @param {string} message - Error message
	 * @param {object} details - Additional context (state, operation, etc.)
	 */
	constructor (message = 'Wrong state for request', details) {
		super(message);
		this.details = details;
	}

	get name () { return this.constructor.name; }
}

