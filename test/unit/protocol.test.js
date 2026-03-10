/**
 * Protocol Layer Unit Tests
 * 
 * Tests for message encoding/decoding, handshake, and protocol utilities.
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
	// Constants
	DATA_HEADER_BYTES,
	MIN_DATA_RES_BYTES,
	RESERVE_ACK_BYTES,
	HDR_TYPE_ACK,
	HDR_TYPE_CHAN_CONTROL,
	HDR_TYPE_CHAN_DATA,
	FLAG_EOM,
	CHANNEL_TCC,
	CHANNEL_C2C,
	TCC_DTAM_TRAN_STOP,
	TCC_DTAM_CHAN_REQUEST,
	TCC_DTAM_CHAN_RESPONSE,
	TCC_CTLM_MESG_TYPE_REG_REQ,
	TCC_CTLM_MESG_TYPE_REG_RESP,
	C2C_MESG_EXCEPT,
	C2C_MESG_TRACE,
	C2C_MESG_DEBUG,
	C2C_MESG_INFO,
	C2C_MESG_WARN,
	C2C_MESG_ERROR,
	MIN_CHANNEL_ID, // Missing coverage
	MIN_MESG_TYPE_ID, // Missing coverage
	// Helper functions
	totalToEncAddl,
	addlToEncAddl,
	encAddlToAddl,
	encAddlToTotal,
	ackHeaderSize,
	channelHeaderSize,
	// Encoding functions
	encodeAckHeaderInto,
	encodeChannelHeaderInto,
	encodeHandshakeInto,
	// Decoding functions
	decodeHeaderSizeFromPrefix,
	decodeAckHeaderFrom,
	decodeChannelHeaderFrom
} from '../../src/protocol.esm.js';
import { VirtualBuffer, VirtualRWBuffer } from '../../src/virtual-buffer.esm.js';

/**
 * Allocating wrapper for ACK header encoding testing
 *
 * @param {Object} fields - { channelId, baseSequence, flags=0, ranges=[] }
 * @returns {Uint8Array} Encoded ACK header
 */
function encodeAckHeader (fields) {
	const ranges = fields?.ranges || [];
	const buffer = new Uint8Array(ackHeaderSize(ranges.length));
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	encodeAckHeaderInto(view, 0, fields);
	return buffer;
}

/**
 * Allocating wrapper for channel header encoding testing
 *
 * @param {number} type - HDR_TYPE_CHAN_CONTROL or HDR_TYPE_CHAN_DATA
 * @param {Object} fields - { dataSize=0, flags=0, channelId, sequence, messageType }
 * @returns {Uint8Array} Encoded channel header
 */
function encodeChannelHeader (type, fields) {
	const buffer = new Uint8Array(DATA_HEADER_BYTES);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	encodeChannelHeaderInto(view, 0, type, fields);
	return buffer;
}

// ============================================================================
// Constants Tests
// ============================================================================

Deno.test('Protocol - constants are defined', () => {
	assertEquals(typeof DATA_HEADER_BYTES, 'number');
	assertEquals(typeof MIN_DATA_RES_BYTES, 'number');
	assertEquals(typeof RESERVE_ACK_BYTES, 'number');
	assertEquals(DATA_HEADER_BYTES, 18);
	assertEquals(MIN_DATA_RES_BYTES, 4);
	assertEquals(RESERVE_ACK_BYTES, 514);
});

Deno.test('Protocol - message type constants', () => {
	assertEquals(HDR_TYPE_ACK, 0);
	assertEquals(HDR_TYPE_CHAN_CONTROL, 1);
	assertEquals(HDR_TYPE_CHAN_DATA, 2);
});

Deno.test('Protocol - flag constants', () => {
	assertEquals(FLAG_EOM, 0x0001);
});

Deno.test('Protocol - channel constants', () => {
	assertEquals(CHANNEL_TCC, 0);
	assertEquals(CHANNEL_C2C, 1);
});

Deno.test('Protocol - TCC message-type constants', () => {
	assertEquals(TCC_DTAM_TRAN_STOP, [0, 'tranStop']);
	assertEquals(TCC_DTAM_CHAN_REQUEST, [1, 'chanReq']);
	assertEquals(TCC_DTAM_CHAN_RESPONSE, [2, 'chanResp']);
	assertEquals(TCC_CTLM_MESG_TYPE_REG_REQ, [3, 'mesgTypeReq']);
	assertEquals(TCC_CTLM_MESG_TYPE_REG_RESP, [4, 'mesgTypeResp']);
});

Deno.test('Protocol - C2C message-type constants', () => {
	assertEquals(C2C_MESG_EXCEPT, [0, 'except']);
	assertEquals(C2C_MESG_TRACE, [1, 'trace']);
	assertEquals(C2C_MESG_DEBUG, [2, 'debug']);
	assertEquals(C2C_MESG_INFO, [3, 'info']);
	assertEquals(C2C_MESG_WARN, [4, 'warn']);
	assertEquals(C2C_MESG_ERROR, [5, 'error']);
});

// ============================================================================
// Helper Function Tests
// ============================================================================

Deno.test('Protocol - totalToEncAddl', () => {
	assertEquals(totalToEncAddl(4), 0);   // (4-4)>>1 = 0
	assertEquals(totalToEncAddl(6), 1);   // (6-4)>>1 = 1
	assertEquals(totalToEncAddl(14), 5);  // (14-4)>>1 = 5
	assertEquals(totalToEncAddl(18), 7);  // (18-4)>>1 = 7
});

Deno.test('Protocol - addlToEncAddl', () => {
	assertEquals(addlToEncAddl(2), 0);   // (2-2)>>1 = 0
	assertEquals(addlToEncAddl(4), 1);   // (4-2)>>1 = 1
	assertEquals(addlToEncAddl(12), 5);  // (12-2)>>1 = 5
	assertEquals(addlToEncAddl(16), 7);  // (16-2)>>1 = 7
});

Deno.test('Protocol - encAddlToAddl', () => {
	assertEquals(encAddlToAddl(0), 2);   // 0<<1 + 2 = 2
	assertEquals(encAddlToAddl(1), 4);   // 1<<1 + 2 = 4
	assertEquals(encAddlToAddl(5), 12);  // 5<<1 + 2 = 12
	assertEquals(encAddlToAddl(7), 16);  // 7<<1 + 2 = 16
});

Deno.test('Protocol - encAddlToTotal', () => {
	assertEquals(encAddlToTotal(0), 4);   // 0<<1 + 4 = 4
	assertEquals(encAddlToTotal(1), 6);   // 1<<1 + 4 = 6
	assertEquals(encAddlToTotal(5), 14);  // 5<<1 + 4 = 14
	assertEquals(encAddlToTotal(7), 18);  // 7<<1 + 4 = 18
});

Deno.test('Protocol - ackHeaderSize with no ranges', () => {
	assertEquals(ackHeaderSize(0), 14);  // toEven(13 + 0) = 14
});

Deno.test('Protocol - ackHeaderSize with odd range count', () => {
	assertEquals(ackHeaderSize(1), 14);  // toEven(13 + 1) = 14
	assertEquals(ackHeaderSize(3), 16);  // toEven(13 + 3) = 16
	assertEquals(ackHeaderSize(5), 18);  // toEven(13 + 5) = 18
});

Deno.test('Protocol - ackHeaderSize validation', () => {
	assertThrows(
		() => ackHeaderSize(-1),
		RangeError,
		'rangeCount must be an integer in [0, 255]'
	);
	assertThrows(
		() => ackHeaderSize(256),
		RangeError,
		'rangeCount must be an integer in [0, 255]'
	);
	assertThrows(
		() => ackHeaderSize(1.5),
		RangeError,
		'rangeCount must be an integer in [0, 255]'
	);
});

Deno.test('Protocol - channelHeaderSize', () => {
	assertEquals(channelHeaderSize(), 18);
	assertEquals(channelHeaderSize(), DATA_HEADER_BYTES);
});

// ============================================================================
// ACK Header Encoding Tests
// ============================================================================

Deno.test('Protocol - encodeAckHeader basic', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		flags: 0,
		ranges: []
	});

	assertEquals(header.length, 14);
	assertEquals(header[0], HDR_TYPE_ACK);
	assertEquals(header[1], 5);  // (14-4)>>1 = 5
	
	// Verify channelId (big-endian)
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	assertEquals(view.getUint32(4), 100);
	assertEquals(view.getUint32(8), 200);
	assertEquals(header[12], 0);  // rangeCount
});

Deno.test('Protocol - encodeAckHeader with flags', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		flags: 0x1234,
		ranges: []
	});

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	assertEquals(view.getUint16(2), 0x1234);
});

Deno.test('Protocol - encodeAckHeader with ranges', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		flags: 0,
		ranges: [10, 20, 30]
	});

	assertEquals(header.length, 16);  // toEven(13 + 3) = 16
	assertEquals(header[12], 3);  // rangeCount
	assertEquals(header[13], 10);
	assertEquals(header[14], 20);
	assertEquals(header[15], 30);
});

Deno.test('Protocol - encodeAckHeaderInto with VirtualRWBuffer', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	const size = encodeAckHeaderInto(vb, 0, {
		channelId: 100,
		baseSequence: 200,
		flags: 0,
		ranges: []
	});

	assertEquals(size, 14);
	assertEquals(buffer[0], HDR_TYPE_ACK);
	assertEquals(buffer[1], 5);
});

Deno.test('Protocol - encodeAckHeaderInto with DataView', () => {
	const buffer = new Uint8Array(20);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	
	const size = encodeAckHeaderInto(view, 0, {
		channelId: 100,
		baseSequence: 200,
		flags: 0,
		ranges: []
	});

	assertEquals(size, 14);
	assertEquals(buffer[0], HDR_TYPE_ACK);
	assertEquals(buffer[1], 5);
});

Deno.test('Protocol - encodeAckHeaderInto with offset', () => {
	const buffer = new Uint8Array(30);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	
	const size = encodeAckHeaderInto(view, 10, {
		channelId: 100,
		baseSequence: 200,
		flags: 0,
		ranges: []
	});

	assertEquals(size, 14);
	assertEquals(buffer[10], HDR_TYPE_ACK);
	assertEquals(buffer[11], 5);
});

Deno.test('Protocol - encodeAckHeaderInto validation', () => {
	const buffer = new Uint8Array(20);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

	// Invalid target
	assertThrows(
		() => encodeAckHeaderInto(null, 0, { channelId: 100, baseSequence: 200 }),
		TypeError,
		'target must have DataView-compatible API'
	);

	// Invalid offset
	assertThrows(
		() => encodeAckHeaderInto(view, -1, { channelId: 100, baseSequence: 200 }),
		RangeError,
		'offset out of range'
	);

	// Invalid ranges
	assertThrows(
		() => encodeAckHeaderInto(view, 0, { channelId: 100, baseSequence: 200, ranges: 'invalid' }),
		TypeError,
		'ranges must be an array'
	);

	// Too many ranges
	assertThrows(
		() => encodeAckHeaderInto(view, 0, { channelId: 100, baseSequence: 200, ranges: new Array(256).fill(0) }),
		Error,
		'Too many ranges'
	);
});

// ============================================================================
// Channel Header Encoding Tests
// ============================================================================

Deno.test('Protocol - encodeChannelHeader control message', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_CONTROL, {
		dataSize: 100,
		flags: 0,
		channelId: 200,
		sequence: 300,
		messageType: 400
	});

	assertEquals(header.length, 18);
	assertEquals(header[0], HDR_TYPE_CHAN_CONTROL);
	assertEquals(header[1], 7);  // (18-4)>>1 = 7

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	assertEquals(view.getUint32(2), 100);   // dataSize
	assertEquals(view.getUint16(6), 0);     // flags
	assertEquals(view.getUint32(8), 200);   // channelId
	assertEquals(view.getUint32(12), 300);  // sequence
	assertEquals(view.getUint16(16), 400);  // messageType
});

Deno.test('Protocol - encodeChannelHeader data message', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		dataSize: 1024,
		flags: FLAG_EOM,
		channelId: 500,
		sequence: 600,
		messageType: 700
	});

	assertEquals(header.length, 18);
	assertEquals(header[0], HDR_TYPE_CHAN_DATA);

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	assertEquals(view.getUint32(2), 1024);
	assertEquals(view.getUint16(6), FLAG_EOM);
	assertEquals(view.getUint32(8), 500);
	assertEquals(view.getUint32(12), 600);
	assertEquals(view.getUint16(16), 700);
});

Deno.test('Protocol - encodeChannelHeader with defaults', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		channelId: 100,
		sequence: 200,
		messageType: 300
	});

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	assertEquals(view.getUint32(2), 0);  // dataSize defaults to 0
	assertEquals(view.getUint16(6), 0);  // flags defaults to 0
});

Deno.test('Protocol - encodeChannelHeaderInto with VirtualRWBuffer', () => {
	const buffer = new Uint8Array(20);
	const vb = new VirtualRWBuffer(buffer);
	
	const size = encodeChannelHeaderInto(vb, 0, HDR_TYPE_CHAN_DATA, {
		dataSize: 100,
		flags: 0,
		channelId: 200,
		sequence: 300,
		messageType: 400
	});

	assertEquals(size, 18);
	assertEquals(buffer[0], HDR_TYPE_CHAN_DATA);
});

Deno.test('Protocol - encodeChannelHeaderInto with DataView', () => {
	const buffer = new Uint8Array(20);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	
	const size = encodeChannelHeaderInto(view, 0, HDR_TYPE_CHAN_DATA, {
		dataSize: 100,
		flags: 0,
		channelId: 200,
		sequence: 300,
		messageType: 400
	});

	assertEquals(size, 18);
	assertEquals(buffer[0], HDR_TYPE_CHAN_DATA);
});

Deno.test('Protocol - encodeChannelHeaderInto validation', () => {
	const buffer = new Uint8Array(20);
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

	// Invalid target
	assertThrows(
		() => encodeChannelHeaderInto(null, 0, HDR_TYPE_CHAN_DATA, { channelId: 100, sequence: 200, messageType: 300 }),
		TypeError,
		'target must have DataView-compatible API'
	);

	// Invalid offset
	assertThrows(
		() => encodeChannelHeaderInto(view, -1, HDR_TYPE_CHAN_DATA, { channelId: 100, sequence: 200, messageType: 300 }),
		RangeError,
		'offset out of range'
	);

	// Invalid message type
	assertThrows(
		() => encodeChannelHeaderInto(view, 0, 99, { channelId: 100, sequence: 200, messageType: 300 }),
		Error,
		'Invalid channel message type'
	);
});

// ============================================================================
// Header Decoding Tests
// ============================================================================

Deno.test('Protocol - decodeHeaderSizeFromPrefix ACK', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: []
	});
	const vb = new VirtualBuffer(header);
	
	const size = decodeHeaderSizeFromPrefix(vb, 0);
	assertEquals(size, 14);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix ACK with ranges', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: [10, 20, 30]
	});
	const vb = new VirtualBuffer(header);
	
	const size = decodeHeaderSizeFromPrefix(vb, 0);
	assertEquals(size, 16);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix channel message', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		channelId: 100,
		sequence: 200,
		messageType: 300
	});
	const vb = new VirtualBuffer(header);
	
	const size = decodeHeaderSizeFromPrefix(vb, 0);
	assertEquals(size, 18);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix with DataView', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: []
	});
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	
	const size = decodeHeaderSizeFromPrefix(view, 0);
	assertEquals(size, 14);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix incomplete', () => {
	const buffer = new Uint8Array(1);
	const vb = new VirtualBuffer(buffer);
	
	const size = decodeHeaderSizeFromPrefix(vb, 0);
	assertEquals(size, null);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix unknown type', () => {
	const buffer = new Uint8Array([99, 0]);
	const vb = new VirtualBuffer(buffer);
	
	assertThrows(
		() => decodeHeaderSizeFromPrefix(vb, 0),
		Error,
		'Unknown message type: 99'
	);
});

Deno.test('Protocol - decodeHeaderSizeFromPrefix validation', () => {
	const buffer = new Uint8Array(10);
	const vb = new VirtualBuffer(buffer);

	// Invalid buffer
	assertThrows(
		() => decodeHeaderSizeFromPrefix(null, 0),
		TypeError,
		'buffer must have DataView-compatible API'
	);

	// Invalid offset
	assertThrows(
		() => decodeHeaderSizeFromPrefix(vb, -1),
		RangeError,
		'offset out of range'
	);
});

Deno.test('Protocol - decodeAckHeaderFrom basic', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		flags: 0x1234,
		ranges: [10, 20, 30]
	});
	const vb = new VirtualBuffer(header);
	
	const decoded = decodeAckHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_ACK);
	assertEquals(decoded.headerSize, 16);
	assertEquals(decoded.flags, 0x1234);
	assertEquals(decoded.channelId, 100);
	assertEquals(decoded.baseSequence, 200);
	assertEquals(decoded.rangeCount, 3);
	assertEquals(decoded.ranges, [10, 20, 30]);
});

Deno.test('Protocol - decodeAckHeaderFrom with DataView', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: []
	});
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	
	const decoded = decodeAckHeaderFrom(view);
	
	assertEquals(decoded.type, HDR_TYPE_ACK);
	assertEquals(decoded.channelId, 100);
	assertEquals(decoded.baseSequence, 200);
});

Deno.test('Protocol - decodeAckHeaderFrom with offset', () => {
	const buffer = new Uint8Array(30);
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: []
	});
	buffer.set(header, 10);
	const vb = new VirtualBuffer(buffer);
	
	const decoded = decodeAckHeaderFrom(vb, 10);
	
	assertEquals(decoded.type, HDR_TYPE_ACK);
	assertEquals(decoded.channelId, 100);
});

Deno.test('Protocol - decodeAckHeaderFrom buffer too small', () => {
	const buffer = new Uint8Array(3);
	const vb = new VirtualBuffer(buffer);
	
	assertThrows(
		() => decodeAckHeaderFrom(vb),
		Error,
		'Buffer too small for ACK header'
	);
});

Deno.test('Protocol - decodeChannelHeaderFrom control', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_CONTROL, {
		dataSize: 100,
		flags: 0x5678,
		channelId: 200,
		sequence: 300,
		messageType: 400
	});
	const vb = new VirtualBuffer(header);
	
	const decoded = decodeChannelHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_CONTROL);
	assertEquals(decoded.headerSize, 18);
	assertEquals(decoded.dataSize, 100);
	assertEquals(decoded.flags, 0x5678);
	assertEquals(decoded.channelId, 200);
	assertEquals(decoded.sequence, 300);
	assertEquals(decoded.messageType, 400);
	assertEquals(decoded.eom, false);
});

Deno.test('Protocol - decodeChannelHeaderFrom data with EOM', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		dataSize: 1024,
		flags: FLAG_EOM,
		channelId: 500,
		sequence: 600,
		messageType: 700
	});
	const vb = new VirtualBuffer(header);
	
	const decoded = decodeChannelHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_DATA);
	assertEquals(decoded.dataSize, 1024);
	assertEquals(decoded.flags, FLAG_EOM);
	assertEquals(decoded.eom, true);
});

Deno.test('Protocol - decodeChannelHeaderFrom with DataView', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		channelId: 100,
		sequence: 200,
		messageType: 300
	});
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	
	const decoded = decodeChannelHeaderFrom(view);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_DATA);
	assertEquals(decoded.channelId, 100);
	assertEquals(decoded.sequence, 200);
	assertEquals(decoded.messageType, 300);
});

Deno.test('Protocol - decodeChannelHeaderFrom with offset', () => {
	const buffer = new Uint8Array(30);
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		channelId: 100,
		sequence: 200,
		messageType: 300
	});
	buffer.set(header, 10);
	const vb = new VirtualBuffer(buffer);
	
	const decoded = decodeChannelHeaderFrom(vb, 10);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_DATA);
	assertEquals(decoded.channelId, 100);
});

Deno.test('Protocol - decodeChannelHeaderFrom buffer too small', () => {
	const buffer = new Uint8Array(10);
	const vb = new VirtualBuffer(buffer);
	
	assertThrows(
		() => decodeChannelHeaderFrom(vb),
		Error,
		'Buffer too small for channel header'
	);
});

// ============================================================================
// Handshake Encoding Tests
// ============================================================================

Deno.test('Protocol - encodeHandshakeInto basic', () => {
	const buffer = new Uint8Array(100);
	const vb = new VirtualRWBuffer(buffer);
	
	const size = encodeHandshakeInto(vb, 0);
	
	// Should have: \x02PolyTransport:{JSON}\x03\n
	assertEquals(buffer[0], 0x02);  // STX
	
	// Verify transport ID prefix
	const idBytes = new TextEncoder().encode('PolyTransport:');
	for (let i = 0; i < idBytes.length; i++) {
		assertEquals(buffer[1 + i], idBytes[i]);
	}
	
	// Should end with ETX and newline
	assertEquals(buffer[size - 2], 0x03);  // ETX
	assertEquals(buffer[size - 1], 0x0A);  // \n
});

Deno.test('Protocol - encodeHandshakeInto with custom config', () => {
	const buffer = new Uint8Array(200);
	const vb = new VirtualRWBuffer(buffer);
	
	const config = {
		c2cEnabled: true,
		minChannelId: 512,
		minMessageTypeId: 2048,
		version: 2
	};
	
	const size = encodeHandshakeInto(vb, 0, config);
	
	// Verify it's a valid handshake format
	assertEquals(buffer[0], 0x02);  // STX
	assertEquals(buffer[size - 2], 0x03);  // ETX
	assertEquals(buffer[size - 1], 0x0A);  // \n
	
	// Verify config is in JSON format
	const text = new TextDecoder().decode(buffer.slice(0, size));
	const jsonStart = text.indexOf('{');
	const jsonEnd = text.lastIndexOf('}');
	const jsonText = text.slice(jsonStart, jsonEnd + 1);
	const parsed = JSON.parse(jsonText);
	
	assertEquals(parsed.c2cEnabled, true);
	assertEquals(parsed.minChannelId, 512);
	assertEquals(parsed.minMessageTypeId, 2048);
	assertEquals(parsed.version, 2);
});

Deno.test('Protocol - encodeHandshakeInto with offset', () => {
	const buffer = new Uint8Array(200);
	const vb = new VirtualRWBuffer(buffer);
	
	const size = encodeHandshakeInto(vb, 10);
	
	assertEquals(buffer[10], 0x02);  // STX at offset
	assertEquals(buffer[10 + size - 2], 0x03);  // ETX
	assertEquals(buffer[10 + size - 1], 0x0A);  // \n
});

Deno.test('Protocol - encodeHandshakeInto validation', () => {
	// Invalid target
	assertThrows(
		() => encodeHandshakeInto(null, 0),
		TypeError,
		'target does not support encodeFrom()'
	);

	// Invalid offset
	const buffer = new Uint8Array(100);
	const vb = new VirtualRWBuffer(buffer);
	assertThrows(
		() => encodeHandshakeInto(vb, -1),
		RangeError,
		'offset out of range'
	);
});

// ============================================================================
// Round-trip Tests
// ============================================================================

Deno.test('Protocol - ACK round-trip', () => {
	const original = {
		channelId: 12345,
		baseSequence: 67890,
		flags: 0xABCD,
		ranges: [1, 2, 3, 4, 5]
	};
	
	const encoded = encodeAckHeader(original);
	const vb = new VirtualBuffer(encoded);
	const decoded = decodeAckHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_ACK);
	assertEquals(decoded.channelId, original.channelId);
	assertEquals(decoded.baseSequence, original.baseSequence);
	assertEquals(decoded.flags, original.flags);
	assertEquals(decoded.ranges, original.ranges);
});

Deno.test('Protocol - channel control round-trip', () => {
	const original = {
		dataSize: 4096,
		flags: 0x1234,
		channelId: 999,
		sequence: 888,
		messageType: 777
	};
	
	const encoded = encodeChannelHeader(HDR_TYPE_CHAN_CONTROL, original);
	const vb = new VirtualBuffer(encoded);
	const decoded = decodeChannelHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_CONTROL);
	assertEquals(decoded.dataSize, original.dataSize);
	assertEquals(decoded.flags, original.flags);
	assertEquals(decoded.channelId, original.channelId);
	assertEquals(decoded.sequence, original.sequence);
	assertEquals(decoded.messageType, original.messageType);
});

Deno.test('Protocol - channel data round-trip', () => {
	const original = {
		dataSize: 8192,
		flags: FLAG_EOM,
		channelId: 111,
		sequence: 222,
		messageType: 333
	};
	
	const encoded = encodeChannelHeader(HDR_TYPE_CHAN_DATA, original);
	const vb = new VirtualBuffer(encoded);
	const decoded = decodeChannelHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_DATA);
	assertEquals(decoded.dataSize, original.dataSize);
	assertEquals(decoded.flags, original.flags);
	assertEquals(decoded.eom, true);
	assertEquals(decoded.channelId, original.channelId);
	assertEquals(decoded.sequence, original.sequence);
	assertEquals(decoded.messageType, original.messageType);
});

// ============================================================================
// Multi-segment Buffer Tests
// ============================================================================

Deno.test('Protocol - decode ACK from multi-segment VirtualBuffer', () => {
	const header = encodeAckHeader({
		channelId: 100,
		baseSequence: 200,
		ranges: [10, 20]
	});
	
	// Split into two segments
	const seg1 = header.slice(0, 8);
	const seg2 = header.slice(8);
	const vb = new VirtualBuffer();
	vb.append(seg1);
	vb.append(seg2);
	
	const decoded = decodeAckHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_ACK);
	assertEquals(decoded.channelId, 100);
	assertEquals(decoded.baseSequence, 200);
	assertEquals(decoded.ranges, [10, 20]);
});

Deno.test('Protocol - decode channel header from multi-segment VirtualBuffer', () => {
	const header = encodeChannelHeader(HDR_TYPE_CHAN_DATA, {
		dataSize: 1024,
		flags: FLAG_EOM,
		channelId: 500,
		sequence: 600,
		messageType: 700
	});
	
	// Split into three segments
	const seg1 = header.slice(0, 6);
	const seg2 = header.slice(6, 12);
	const seg3 = header.slice(12);
	const vb = new VirtualBuffer();
	vb.append(seg1);
	vb.append(seg2);
	vb.append(seg3);
	
	const decoded = decodeChannelHeaderFrom(vb);
	
	assertEquals(decoded.type, HDR_TYPE_CHAN_DATA);
	assertEquals(decoded.dataSize, 1024);
	assertEquals(decoded.channelId, 500);
	assertEquals(decoded.sequence, 600);
	assertEquals(decoded.messageType, 700);
	assertEquals(decoded.eom, true);
});
