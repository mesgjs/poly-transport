// Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung

/**
 * PolyTransport Protocol Layer
 * 
 * Handles encoding and decoding of message headers and protocol constants.
 * 
 * Message Format:
 * - ACK messages: Type 0
 * - Channel-control messages: Type 2
 * - Channel-data messages: Type 3
 */

// Protocol version
export const PROTOCOL_VERSION = 1;

// Message type constants
export const MSG_TYPE_ACK = 0;
export const MSG_TYPE_CHANNEL_CONTROL = 2;
export const MSG_TYPE_CHANNEL_DATA = 3;

// Transport identifier for handshake
export const TRANSPORT_IDENTIFIER = new Uint8Array([
  0x02, // STX
  ...new TextEncoder().encode('PolyTransport'),
  0x03  // ETX
]);

// Binary stream marker
export const BINARY_STREAM_MARKER = new Uint8Array([0x01]);

// Flag constants
export const FLAG_EOM = 0x0001; // End of message

// Channel constants
export const CHANNEL_TCC = 0; // Transport-Control Channel
export const CHANNEL_C2C = 1; // Console-Content Channel

// TCC message types
export const TCC_MSG_TRANSPORT_STATE = 0;
export const TCC_MSG_CHANNEL_REQUEST = 1;
export const TCC_MSG_CHANNEL_RESPONSE = 2;

// C2C message types
export const C2C_MSG_UNCAUGHT_EXCEPTION = 0;
export const C2C_MSG_DEBUG = 1;
export const C2C_MSG_INFO = 2;
export const C2C_MSG_WARN = 3;
export const C2C_MSG_ERROR = 4;

// CCM (Channel Control Message) types
export const CCM_MSG_TYPE_REGISTER_REQUEST = 0;
export const CCM_MSG_TYPE_REGISTER_RESPONSE = 1;

const toEven = (v) => (v & 1) ? (v + 1) : v;

export const CHANNEL_HEADER_SIZE = 18;

/**
 * Return the exact encoded ACK header size in bytes.
 * The ACK header is even-padded.
 */
export function ackHeaderSize (rangeCount) {
	if (!Number.isInteger(rangeCount) || rangeCount < 0 || rangeCount > 255) {
		throw new RangeError('rangeCount must be an integer in [0, 255]');
	}

	return toEven(13 + rangeCount);
}

/**
 * Return the encoded channel-control/channel-data header size in bytes.
 */
export function channelHeaderSize () {
	return CHANNEL_HEADER_SIZE;
}

/**
 * Given the first 2 bytes of a header, compute the total header byte size.
 * Returns null if fewer than 2 bytes are available.
 */
export function decodeHeaderSizeFromPrefix (buffer, offset = 0) {
	if (!(buffer instanceof Uint8Array)) {
		throw new TypeError('buffer must be a Uint8Array');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}
	if (buffer.length - offset < 2) {
		return null;
	}

	const type = buffer[offset];
	const sizeByte = buffer[offset + 1];

	if (type === MSG_TYPE_ACK) {
		const remainingSize = (sizeByte + 1) << 1;
		return 2 + remainingSize;
	}

	if (type === MSG_TYPE_CHANNEL_CONTROL || type === MSG_TYPE_CHANNEL_DATA) {
		return CHANNEL_HEADER_SIZE;
	}

	throw new Error(`Unknown message type: ${type}`);
}

/**
 * Encode an ACK header into a caller-provided buffer window.
 *
 * SECURITY: if the header is even-padded, the pad byte is explicitly zeroed.
 *
 * @returns {number} header size in bytes
 */
export function encodeAckHeaderInto (target, offset, fields) {
	if (!(target instanceof Uint8Array)) {
		throw new TypeError('target must be a Uint8Array');
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
	if (target.length - offset < headerSize) {
		throw new RangeError('target too small for ACK header');
	}

	const view = new DataView(target.buffer, target.byteOffset + offset, headerSize);
	const inHeaderSize = (headerSize - 4) >> 1;

	let o = 0;
	view.setUint8(o++, MSG_TYPE_ACK);
	view.setUint8(o++, inHeaderSize);
	view.setUint16(o, flags, false); o += 2;
	view.setUint32(o, channelId, false); o += 4;
	view.setUint32(o, baseSequence, false); o += 4;
	view.setUint8(o++, rangeCount);
	for (const q of ranges) {
		view.setUint8(o++, q);
	}

	// Zero the pad byte if present (prevents data leakage from previously-used ring ranges).
	if (o < headerSize) {
		view.setUint8(o, 0);
	}

	return headerSize;
}

/**
 * Encode a channel-control or channel-data header into a caller-provided buffer window.
 *
 * @returns {number} header size in bytes (always 18)
 */
export function encodeChannelHeaderInto (target, offset, type, fields) {
	if (!(target instanceof Uint8Array)) {
		throw new TypeError('target must be a Uint8Array');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}
	if (type !== MSG_TYPE_CHANNEL_CONTROL && type !== MSG_TYPE_CHANNEL_DATA) {
		throw new Error(`Invalid channel message type: ${type}`);
	}

	const { dataSize = 0, flags = 0, channelId, sequence, messageType } = fields;

	if (target.length - offset < CHANNEL_HEADER_SIZE) {
		throw new RangeError('target too small for channel header');
	}

	const view = new DataView(target.buffer, target.byteOffset + offset, CHANNEL_HEADER_SIZE);

	let o = 0;
	view.setUint8(o++, type);
	view.setUint8(o++, 7);
	view.setUint32(o, dataSize, false); o += 4;
	view.setUint16(o, flags, false); o += 2;
	view.setUint32(o, channelId, false); o += 4;
	view.setUint32(o, sequence, false); o += 4;
	view.setUint16(o, messageType, false); o += 2;

	return CHANNEL_HEADER_SIZE;
}

/**
 * Allocating wrapper for ACK header encoding.
 */
export function encodeAckHeader (fields) {
	const ranges = fields?.ranges || [];
	const buffer = new Uint8Array(ackHeaderSize(ranges.length));
	encodeAckHeaderInto(buffer, 0, fields);
	return buffer;
}

/**
 * Allocating wrapper for channel header encoding.
 */
export function encodeChannelHeader (type, fields) {
	const buffer = new Uint8Array(CHANNEL_HEADER_SIZE);
	encodeChannelHeaderInto(buffer, 0, type, fields);
	return buffer;
}

export function decodeHeaderFrom (buffer, offset = 0) {
	if (!(buffer instanceof Uint8Array)) {
		throw new TypeError('buffer must be a Uint8Array');
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new RangeError('offset out of range');
	}
	if (buffer.length - offset < 4) {
		throw new Error('Buffer too small for header');
	}

	const type = buffer[offset];
	if (type === MSG_TYPE_ACK) {
		return decodeAckHeaderFrom(buffer, offset);
	}
	if (type === MSG_TYPE_CHANNEL_CONTROL || type === MSG_TYPE_CHANNEL_DATA) {
		return decodeChannelHeaderFrom(buffer, offset);
	}
	throw new Error(`Unknown message type: ${type}`);
}

export function decodeHeader (buffer) {
	return decodeHeaderFrom(buffer, 0);
}

function decodeAckHeaderFrom (buffer, offset) {
	const headerSize = decodeHeaderSizeFromPrefix(buffer, offset);
	if (headerSize === null || buffer.length - offset < headerSize) {
		throw new Error('Buffer too small for ACK header');
	}

	const view = new DataView(buffer.buffer, buffer.byteOffset + offset, headerSize);

	let o = 0;
	const type = view.getUint8(o++);
	const remainingSize = (view.getUint8(o++) + 1) << 1;
	const flags = view.getUint16(o, false); o += 2;
	const channelId = view.getUint32(o, false); o += 4;
	const baseSequence = view.getUint32(o, false); o += 4;
	const rangeCount = view.getUint8(o++);

	const ranges = [];
	for (let i = 0; i < rangeCount; i++) {
		ranges.push(view.getUint8(o++));
	}

	return {
		type,
		headerLength: 2 + remainingSize,
		flags,
		channelId,
		baseSequence,
		rangeCount,
		ranges
	};
}

function decodeChannelHeaderFrom (buffer, offset) {
	if (buffer.length - offset < CHANNEL_HEADER_SIZE) {
		throw new Error('Buffer too small for channel header');
	}

	const view = new DataView(buffer.buffer, buffer.byteOffset + offset, CHANNEL_HEADER_SIZE);

	let o = 0;
	const type = view.getUint8(o++);
	o++; // sizeByte
	const dataSize = view.getUint32(o, false); o += 4;
	const flags = view.getUint16(o, false); o += 2;
	const channelId = view.getUint32(o, false); o += 4;
	const sequence = view.getUint32(o, false); o += 4;
	const messageType = view.getUint16(o, false); o += 2;

	return {
		type,
		headerLength: CHANNEL_HEADER_SIZE,
		dataSize,
		flags,
		channelId,
		sequence,
		messageType,
		eom: (flags & FLAG_EOM) !== 0
	};
}

/**
 * Validate a decoded header
 * 
 * @param {Object} header - Decoded header
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
export function validateHeader (header) {
	if (!header || typeof header !== 'object') {
		throw new Error('Invalid header: not an object');
	}

	if (typeof header.type !== 'number') {
		throw new Error('Invalid header: missing or invalid type');
	}

	switch (header.type) {
		case MSG_TYPE_ACK:
			validateAckHeader(header);
			break;
		case MSG_TYPE_CHANNEL_CONTROL:
		case MSG_TYPE_CHANNEL_DATA:
			validateChannelHeader(header);
			break;
		default:
			throw new Error(`Invalid header: unknown type ${header.type}`);
	}

	return true;
}

/**
 * Validate an ACK header
 * 
 * @param {Object} header - Decoded ACK header
 * @throws {Error} If validation fails
 */
function validateAckHeader (header) {
	if (typeof header.channelId !== 'number' || header.channelId < 0) {
		throw new Error('Invalid ACK header: invalid channelId');
	}

	if (typeof header.baseSequence !== 'number' || header.baseSequence < 0) {
		throw new Error('Invalid ACK header: invalid baseSequence');
	}

	if (typeof header.rangeCount !== 'number' || header.rangeCount < 0 || header.rangeCount > 255) {
		throw new Error('Invalid ACK header: invalid rangeCount');
	}

	if (!Array.isArray(header.ranges) || header.ranges.length !== header.rangeCount) {
		throw new Error('Invalid ACK header: ranges length mismatch');
	}
}

/**
 * Validate a channel header
 * 
 * @param {Object} header - Decoded channel header
 * @throws {Error} If validation fails
 */
function validateChannelHeader (header) {
	if (typeof header.dataSize !== 'number' || header.dataSize < 0) {
		throw new Error('Invalid channel header: invalid dataSize');
	}

	if (typeof header.channelId !== 'number' || header.channelId < 0) {
		throw new Error('Invalid channel header: invalid channelId');
	}

	if (typeof header.sequence !== 'number' || header.sequence < 0) {
		throw new Error('Invalid channel header: invalid sequence');
	}

	if (typeof header.messageType !== 'number' || header.messageType < 0) {
		throw new Error('Invalid channel header: invalid messageType');
	}
}

/**
 * Encode transport configuration for handshake
 * 
 * @param {Object} config - Transport configuration
 * @returns {Uint8Array} Encoded configuration (STX + JSON + ETX)
 */
export function encodeTransportConfig (config) {
	const json = JSON.stringify(config);
	const jsonBytes = new TextEncoder().encode(json);
	const buffer = new Uint8Array(2 + jsonBytes.length);

	buffer[0] = 0x02; // STX
	buffer.set(jsonBytes, 1);
	buffer[buffer.length - 1] = 0x03; // ETX

	return buffer;
}

/**
 * Decode transport configuration from handshake
 * 
 * @param {Uint8Array} buffer - Buffer containing configuration
 * @returns {Object} Decoded configuration
 */
export function decodeTransportConfig (buffer) {
	if (buffer.length < 2 || buffer[0] !== 0x02 || buffer[buffer.length - 1] !== 0x03) {
		throw new Error('Invalid transport configuration format');
	}

	const jsonBytes = buffer.slice(1, -1);
	const json = new TextDecoder().decode(jsonBytes);

	try {
		return JSON.parse(json);
	} catch (error) {
		throw new Error(`Invalid transport configuration JSON: ${error.message}`);
	}
}
