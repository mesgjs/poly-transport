/*
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 *
 * PolyTransport Protocol Layer
 *
 * Handles message encoding/decoding for the binary protocol.
 * Encoding methods write directly into VirtualRWBuffer or DataView for zero-copy operation.
 */

// Protocol constants (requirements.md:636-641, Update 2026-01-08-A)
export const MAX_DATA_HEADER_BYTES = 18;
export const MIN_DATA_RES_BYTES = 4;
export const RESERVE_ACK_BYTES = 514;

// Header type constants (requirements.md:415-421)
export const HDR_TYPE_ACK = 0;
export const HDR_TYPE_CHAN_CONTROL = 1;
export const HDR_TYPE_CHAN_DATA = 2;

// Transport handshake markers (requirements.md:395-404)
const HANDSHAKE_START = 0x02;  // STX
const HANDSHAKE_END = 0x03;    // ETX
const BINARY_STREAM_START = 0x01;  // SOH

// Transport identifier
const TRANSPORT_ID = 'PolyTransport';

// Default transport configuration (requirements.md:406-413)
export const MIN_CHANNEL_ID = 2;
export const MIN_MESG_TYPE_ID = 256;
const DEFAULT_CONFIG = {
	c2cEnabled: false,
	minChannelId: MIN_CHANNEL_ID,
	minMessageTypeId: MIN_MESG_TYPE_ID,
	version: 1
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
export const TCC_DTAM_TRAN_STOP = 0;
export const TCC_DTAM_CHAN_REQUEST = 1;
export const TCC_DTAM_CHAN_RESPONSE = 2;
export const TCC_CTLM_MESG_TYPE_REG_REQ = 3; // message-type registration request
export const TCC_CTLM_MESG_TYPE_REG_RESP = 4; // message-type registration response

// C2C pre-defined (foundational) message types (requirements.md:495-505)
// (Message-types not required at transport start should be registered/mapped)
export const C2C_MESG_UNCAUGHT = 0; // uncaught exceptions
export const C2C_MESG_TRACE = 1;
export const C2C_MESG_DEBUG = 2;
export const C2C_MESG_INFO = 3;
export const C2C_MESG_WARN = 4;
export const C2C_MESG_ERROR = 5;

/**
 * Helper: Round up to even number
 */
const toEven = (v) => (v & 1) ? (v + 1) : v;

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
 * @param {number} rangeCount - Number of range bytes (should be 0 or odd)
 * @returns {number} Header size in bytes
 */
export function ackHeaderSize (rangeCount) {
	if (!Number.isInteger(rangeCount) || rangeCount < 0 || rangeCount > 255) {
		throw new RangeError('rangeCount must be an integer in [0, 255]');
	}
	return toEven(13 + rangeCount);
}

/**
 * Calculate channel header size in bytes (always 18)
 * 
 * @returns {number} Header size in bytes
 */
export function channelHeaderSize () {
	return MAX_DATA_HEADER_BYTES;
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
 * - 1B: range count (0 or odd)
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
		throw new TypeError('target must have DataView-compatible API (setUint8, setUint16, setUint32)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}

	const { channelId, baseSequence, flags = 0, ranges = [] } = fields;

	if (!Array.isArray(ranges)) {
		throw new TypeError('ranges must be an array');
	}
	if (ranges.length > 255) {
		throw new Error('Too many ranges (max 255)');
	}

	const rangeCount = ranges.length;
	const headerSize = ackHeaderSize(rangeCount);

	// Calculate remaining size: (actualBytes - 2) >> 1
	const remainingSize = totalToEncAddl(headerSize);

	let o = offset;
	target.setUint8(o++, HDR_TYPE_ACK);
	target.setUint8(o++, remainingSize);
	target.setUint16(o, flags); o += 2;
	target.setUint32(o, channelId); o += 4;
	target.setUint32(o, baseSequence); o += 4;
	target.setUint8(o++, rangeCount);
	
	for (const q of ranges) {
		target.setUint8(o++, q);
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
 * Total: 18 bytes (MAX_DATA_HEADER_BYTES)
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
	target.setUint8(o++, totalToEncAddl(MAX_DATA_HEADER_BYTES));
	target.setUint32(o, dataSize); o += 4;
	target.setUint16(o, flags); o += 2;
	target.setUint32(o, channelId); o += 4;
	target.setUint32(o, sequence); o += 4;
	target.setUint16(o, messageType); o += 2;

	return MAX_DATA_HEADER_BYTES;
}

/**
 * Allocating wrapper for ACK header encoding (for testing)
 * 
 * @param {Object} fields - { channelId, baseSequence, flags=0, ranges=[] }
 * @returns {Uint8Array} Encoded ACK header
 */
export function encodeAckHeader (fields) {
	const ranges = fields?.ranges || [];
	const buffer = new Uint8Array(ackHeaderSize(ranges.length));
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	encodeAckHeaderInto(view, 0, fields);
	return buffer;
}

/**
 * Allocating wrapper for channel header encoding (for testing)
 * 
 * @param {number} type - HDR_TYPE_CHAN_CONTROL or HDR_TYPE_CHAN_DATA
 * @param {Object} fields - { dataSize=0, flags=0, channelId, sequence, messageType }
 * @returns {Uint8Array} Encoded channel header
 */
export function encodeChannelHeader (type, fields) {
	const buffer = new Uint8Array(MAX_DATA_HEADER_BYTES);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	encodeChannelHeaderInto(view, 0, type, fields);
	return buffer;
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

	if (type === HDR_TYPE_ACK) {
		return encAddlToTotal(sizeByte);
	}

	if (type === HDR_TYPE_CHAN_CONTROL || type === HDR_TYPE_CHAN_DATA) {
		return MAX_DATA_HEADER_BYTES;
	}

	throw new Error(`Unknown message type: ${type}`);
}

/**
 * Decode ACK header from buffer
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing ACK header
 * @param {number} offset - Offset in buffer
 * @returns {Object} Decoded ACK header
 */
function decodeAckHeaderFrom (buffer, offset) {
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
	const rangeCount = buffer.getUint8(o++);

	const ranges = [];
	for (let i = 0; i < rangeCount; i++) {
		ranges.push(buffer.getUint8(o++));
	}

	return {
		type,
		headerLength: encAddlToTotal(sizeByte),
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
function decodeChannelHeaderFrom (buffer, offset) {
	const length = buffer.length || buffer.byteLength;
	if (length - offset < MAX_DATA_HEADER_BYTES) {
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
		headerLength: MAX_DATA_HEADER_BYTES,
		dataSize,
		flags,
		channelId,
		sequence,
		messageType,
		eom: (flags & FLAG_EOM) !== 0
	};
}

/**
 * Decode header from buffer (auto-detects type)
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing header
 * @param {number} offset - Offset in buffer
 * @returns {Object} Decoded header
 */
export function decodeHeaderFrom (buffer, offset = 0) {
	if (!buffer || typeof buffer.getUint8 !== 'function') {
		throw new TypeError('buffer must have DataView-compatible API (getUint8)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}
	
	const length = buffer.length || buffer.byteLength;
	if (length - offset < 4) {
		throw new Error('Buffer too small for header');
	}

	const type = buffer.getUint8(offset);
	if (type === HDR_TYPE_ACK) {
		return decodeAckHeaderFrom(buffer, offset);
	}
	if (type === HDR_TYPE_CHAN_CONTROL || type === HDR_TYPE_CHAN_DATA) {
		return decodeChannelHeaderFrom(buffer, offset);
	}
	throw new Error(`Unknown message type: ${type}`);
}

/**
 * Decode header from buffer starting at offset 0
 *
 * @param {VirtualBuffer|DataView} buffer - Buffer containing header
 * @returns {Object} Decoded header
 */
export function decodeHeader (buffer) {
	return decodeHeaderFrom(buffer, 0);
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
	if (!target || typeof target.setUint8 !== 'function') {
		throw new TypeError('target must have DataView-compatible API (setUint8)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}

	// Merge with defaults
	const fullConfig = { ...DEFAULT_CONFIG, ...config };
	
	let o = offset;
	
	// Encode transport identifier: \x02PolyTransport\x03
	target.setUint8(o++, HANDSHAKE_START);
	// Use target.encodeFrom
	const idBytes = new TextEncoder().encode(TRANSPORT_ID);
	for (let i = 0; i < idBytes.length; i++) {
		target.setUint8(o++, idBytes[i]);
	}
	target.setUint8(o++, HANDSHAKE_END);
	
	// Encode configuration: \x02{...}\x03
	target.setUint8(o++, HANDSHAKE_START);
	const configJson = JSON.stringify(fullConfig);
	const configBytes = new TextEncoder().encode(configJson);
	for (let i = 0; i < configBytes.length; i++) {
		target.setUint8(o++, configBytes[i]);
	}
	target.setUint8(o++, HANDSHAKE_END);
	
	// Binary stream marker
	target.setUint8(o++, BINARY_STREAM_START);
	
	return o - offset;
}

/**
 * Decode transport handshake from buffer
 *
 * @param {VirtualBuffer} buffer - Buffer containing handshake
 * @param {number} offset - Offset in buffer
 * @returns {Object|null} { config, bytesConsumed } or null if incomplete
 */
export function decodeHandshakeFrom (buffer, offset = 0) {
	if (!buffer || typeof buffer.getUint8 !== 'function') {
		throw new TypeError('buffer must have DataView-compatible API (getUint8)');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}

	const length = buffer.length || buffer.byteLength;
	let o = offset;
	
	// Parse transport identifier
	if (length < o + 2 || buffer.getUint8(o) !== HANDSHAKE_START) {
		return null;  // Incomplete or invalid
	}
	o++;
	
	// Find end of identifier
	let idEnd = o;
	while (idEnd < length && buffer.getUint8(idEnd) !== HANDSHAKE_END) {
		idEnd++;
	}
	if (idEnd >= length) {
		return null;  // Incomplete
	}
	
	// Verify transport identifier (use VirtualBuffer.decode if available, otherwise slice)
	const idSlice = buffer.slice ? buffer.slice(o, idEnd) : buffer;
	const id = idSlice.decode ?
		idSlice.decode({ start: buffer.slice ? 0 : o, end: buffer.slice ? undefined : idEnd }) :
		new TextDecoder().decode(idSlice);
	if (id !== TRANSPORT_ID) {
		throw new Error(`Invalid transport identifier: ${id}`);
	}
	o = idEnd + 1;
	
	// Parse configuration
	if (length < o + 2 || buffer.getUint8(o) !== HANDSHAKE_START) {
		return null;  // Incomplete or invalid
	}
	o++;
	
	// Find end of configuration
	let configEnd = o;
	while (configEnd < length && buffer.getUint8(configEnd) !== HANDSHAKE_END) {
		configEnd++;
	}
	if (configEnd >= length) {
		return null;  // Incomplete
	}
	
	// Parse configuration JSON (use VirtualBuffer.decode if available, otherwise slice)
	const configSlice = buffer.slice ? buffer.slice(o, configEnd) : buffer;
	const configJson = configSlice.decode ?
		configSlice.decode({ start: buffer.slice ? 0 : o, end: buffer.slice ? undefined : configEnd }) :
		new TextDecoder().decode(configSlice);
	const config = JSON.parse(configJson);
	o = configEnd + 1;
	
	// Verify binary stream marker
	if (length < o + 1 || buffer.getUint8(o) !== BINARY_STREAM_START) {
		return null;  // Incomplete or invalid
	}
	o++;
	
	return { config, bytesConsumed: o - offset };
}

/**
 * Decode transport handshake from buffer starting at offset 0
 *
 * @param {VirtualBuffer} buffer - Buffer containing handshake
 * @returns {Object|null} { config, bytesConsumed } or null if incomplete
 */
export function decodeHandshake (buffer) {
	return decodeHandshakeFrom(buffer, 0);
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
		this.name = this.constructor.name;
		this.description = this.reason = description;
		this.details = details;
	}
}

