// PolyTransport Protocol Layer Tests

import { assertEquals, assertThrows } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
	PROTOCOL_VERSION,
	MSG_TYPE_ACK,
	MSG_TYPE_CHANNEL_CONTROL,
	MSG_TYPE_CHANNEL_DATA,
	FLAG_EOM,
	CHANNEL_TCC,
	CHANNEL_C2C,
	ackHeaderSize,
	channelHeaderSize,
	decodeHeader,
	decodeHeaderFrom,
	decodeHeaderSizeFromPrefix,
	encodeAckHeader,
	encodeAckHeaderInto,
	encodeChannelHeader,
	encodeChannelHeaderInto,
	validateHeader,
	encodeTransportConfig,
	decodeTransportConfig,
	TRANSPORT_IDENTIFIER,
	BINARY_STREAM_MARKER
} from "../../src/protocol.esm.js";

Deno.test("Protocol - version constant", () => {
	assertEquals(PROTOCOL_VERSION, 1);
});

Deno.test("Protocol - message type constants", () => {
	assertEquals(MSG_TYPE_ACK, 0);
	assertEquals(MSG_TYPE_CHANNEL_CONTROL, 2);
	assertEquals(MSG_TYPE_CHANNEL_DATA, 3);
});

Deno.test("Protocol - channel constants", () => {
	assertEquals(CHANNEL_TCC, 0);
	assertEquals(CHANNEL_C2C, 1);
});

Deno.test("Protocol - transport identifier", () => {
	assertEquals(TRANSPORT_IDENTIFIER.length, 15);
	assertEquals(TRANSPORT_IDENTIFIER[0], 0x02); // STX
	assertEquals(TRANSPORT_IDENTIFIER[14], 0x03); // ETX
	const text = new TextDecoder().decode(TRANSPORT_IDENTIFIER.slice(1, -1));
	assertEquals(text, "PolyTransport");
});

Deno.test("Protocol - binary stream marker", () => {
	assertEquals(BINARY_STREAM_MARKER.length, 1);
	assertEquals(BINARY_STREAM_MARKER[0], 0x01);
});

// Header Validation Tests

Deno.test("Protocol - validate ACK header (valid)", () => {
	const header = {
		type: MSG_TYPE_ACK,
		channelId: 5,
		baseSequence: 100,
		rangeCount: 2,
		ranges: [3, 1]
	};

	assertEquals(validateHeader(header), true);
});

Deno.test("Protocol - validate ACK header (invalid channelId)", () => {
	const header = {
		type: MSG_TYPE_ACK,
		channelId: -1,
		baseSequence: 100,
		rangeCount: 0,
		ranges: []
	};

	assertThrows(
		() => validateHeader(header),
		Error,
		"invalid channelId"
	);
});

Deno.test("Protocol - validate ACK header (ranges length mismatch)", () => {
	const header = {
		type: MSG_TYPE_ACK,
		channelId: 5,
		baseSequence: 100,
		rangeCount: 3,
		ranges: [1, 2] // Should have 3 elements
	};

	assertThrows(
		() => validateHeader(header),
		Error,
		"ranges length mismatch"
	);
});

Deno.test("Protocol - validate channel header (valid)", () => {
	const header = {
		type: MSG_TYPE_CHANNEL_DATA,
		dataSize: 1024,
		channelId: 3,
		sequence: 42,
		messageType: 5
	};

	assertEquals(validateHeader(header), true);
});

Deno.test("Protocol - validate channel header (invalid dataSize)", () => {
	const header = {
		type: MSG_TYPE_CHANNEL_DATA,
		dataSize: -1,
		channelId: 3,
		sequence: 42,
		messageType: 5
	};

	assertThrows(
		() => validateHeader(header),
		Error,
		"invalid dataSize"
	);
});

Deno.test("Protocol - validate header (unknown type)", () => {
	const header = {
		type: 99
	};

	assertThrows(
		() => validateHeader(header),
		Error,
		"unknown type"
	);
});

// Transport Configuration Tests

Deno.test("Protocol - encode transport config", () => {
	const config = {
		version: 1,
		c2cEnabled: true,
		minChannelId: 256
	};

	const encoded = encodeTransportConfig(config);

	assertEquals(encoded[0], 0x02); // STX
	assertEquals(encoded[encoded.length - 1], 0x03); // ETX

	const jsonBytes = encoded.slice(1, -1);
	const json = new TextDecoder().decode(jsonBytes);
	const parsed = JSON.parse(json);

	assertEquals(parsed.version, 1);
	assertEquals(parsed.c2cEnabled, true);
	assertEquals(parsed.minChannelId, 256);
});

Deno.test("Protocol - decode transport config", () => {
	const config = {
		version: 1,
		c2cEnabled: false,
		minChannelId: 512,
		minMessageTypeId: 2048
	};

	const encoded = encodeTransportConfig(config);
	const decoded = decodeTransportConfig(encoded);

	assertEquals(decoded.version, 1);
	assertEquals(decoded.c2cEnabled, false);
	assertEquals(decoded.minChannelId, 512);
	assertEquals(decoded.minMessageTypeId, 2048);
});

Deno.test("Protocol - decode transport config (invalid format - no STX)", () => {
	const buffer = new Uint8Array([0x01, 0x7B, 0x7D, 0x03]);

	assertThrows(
		() => decodeTransportConfig(buffer),
		Error,
		"Invalid transport configuration format"
	);
});

Deno.test("Protocol - decode transport config (invalid format - no ETX)", () => {
	const buffer = new Uint8Array([0x02, 0x7B, 0x7D, 0x01]);

	assertThrows(
		() => decodeTransportConfig(buffer),
		Error,
		"Invalid transport configuration format"
	);
});

Deno.test("Protocol - decode transport config (invalid JSON)", () => {
	const buffer = new Uint8Array([0x02, 0x7B, 0x7B, 0x03]); // Invalid JSON

	assertThrows(
		() => decodeTransportConfig(buffer),
		Error,
		"Invalid transport configuration JSON"
	);
});

// Edge Cases

Deno.test("Protocol - decode header (buffer too small)", () => {
	const buffer = new Uint8Array([0x00, 0x01]); // Only 2 bytes

	assertThrows(
		() => decodeHeader(buffer),
		Error,
		"Buffer too small"
	);
});

Deno.test("Protocol - decode header (unknown type)", () => {
	const buffer = new Uint8Array([0x99, 0x00, 0x00, 0x00]);

	assertThrows(
		() => decodeHeader(buffer),
		Error,
		"Unknown message type"
	);
});

// Header encode/decode tests

Deno.test("Protocol - encode/decode round-trip (ACK)", () => {
	const original = {
		channelId: 123,
		baseSequence: 456,
		flags: 0,
		ranges: [10, 5, 20]
	};

	const encoded = encodeAckHeader(original);
	const decoded = decodeHeader(encoded);

	assertEquals(decoded.type, MSG_TYPE_ACK);
	assertEquals(decoded.channelId, original.channelId);
	assertEquals(decoded.baseSequence, original.baseSequence);
	assertEquals(decoded.ranges, original.ranges);
});

Deno.test("Protocol - encode/decode round-trip (channel-data)", () => {
	const original = {
		dataSize: 4096,
		flags: FLAG_EOM,
		channelId: 789,
		sequence: 321,
		messageType: 15
	};

	const encoded = encodeChannelHeader(MSG_TYPE_CHANNEL_DATA, original);
	const decoded = decodeHeader(encoded);

	assertEquals(decoded.type, MSG_TYPE_CHANNEL_DATA);
	assertEquals(decoded.dataSize, original.dataSize);
	assertEquals(decoded.flags, original.flags);
	assertEquals(decoded.channelId, original.channelId);
	assertEquals(decoded.sequence, original.sequence);
	assertEquals(decoded.messageType, original.messageType);
	assertEquals(decoded.eom, true);
});

// Codec (encode-into/decode-from) tests

Deno.test('Protocol codec - ackHeaderSize matches padding rule', () => {
	assertEquals(ackHeaderSize(0), 14);
	assertEquals(ackHeaderSize(1), 14);
	assertEquals(ackHeaderSize(2), 16);
	assertEquals(ackHeaderSize(3), 16);
});

Deno.test('Protocol codec - channelHeaderSize is fixed', () => {
	assertEquals(channelHeaderSize(), 18);
});

Deno.test('Protocol codec - encodeAckHeaderInto writes pad byte as 0', () => {
	// rangeCount=0 => encoded size 14, last byte is pad
	const buf = new Uint8Array(64);
	buf.fill(0xAA);

	const n = encodeAckHeaderInto(buf, 0, {
		channelId: 1,
		baseSequence: 2,
		flags: 0,
		ranges: []
	});
	assertEquals(n, 14);
	assertEquals(buf[13], 0);
});

Deno.test('Protocol codec - encode/decode ACK header via encodeInto/decodeFrom', () => {
	const buf = new Uint8Array(64);
	const n = encodeAckHeaderInto(buf, 0, {
		channelId: 10,
		baseSequence: 50,
		flags: 0,
		ranges: [5, 2, 3]
	});

	assertEquals(n, 16);
	assertEquals(decodeHeaderSizeFromPrefix(buf, 0), 16);

	const decoded = decodeHeaderFrom(buf, 0);
	assertEquals(decoded.type, MSG_TYPE_ACK);
	assertEquals(decoded.channelId, 10);
	assertEquals(decoded.baseSequence, 50);
	assertEquals(decoded.rangeCount, 3);
	assertEquals(decoded.ranges, [5, 2, 3]);
});

Deno.test('Protocol codec - encodeChannelHeaderInto + decodeHeaderFrom', () => {
	const buf = new Uint8Array(64);
	const n = encodeChannelHeaderInto(buf, 0, MSG_TYPE_CHANNEL_CONTROL, {
		dataSize: 256,
		flags: 0,
		channelId: 3,
		sequence: 42,
		messageType: 1
	});

	assertEquals(n, 18);
	assertEquals(decodeHeaderSizeFromPrefix(buf, 0), 18);

	const decoded = decodeHeaderFrom(buf, 0);
	assertEquals(decoded.type, MSG_TYPE_CHANNEL_CONTROL);
	assertEquals(decoded.dataSize, 256);
	assertEquals(decoded.channelId, 3);
	assertEquals(decoded.sequence, 42);
	assertEquals(decoded.messageType, 1);
	assertEquals(decoded.eom, false);
});
