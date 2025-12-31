import {
	assertEquals,
	assertRejects,
	assertThrows
} from 'https://deno.land/std@0.177.0/testing/asserts.ts';

import {
	FlowController,
	ProtocolViolationError,
	TimeoutError
} from '../../src/flow-control.esm.js';

Deno.test('flow-control: outbound blocks until ACK restores credits', async () => {
	const fc = new FlowController({ remoteMaxBufferSize: 10 });

	const seq1 = await fc.reserveSend(6);
	assertEquals(seq1, 1);
	assertEquals(fc.sendInFlightBytes, 6);

	const pending = fc.reserveSend(6, { timeout: 200 });

	setTimeout(() => {
		fc.processAck({ baseSequence: 1, ranges: [1] });
	}, 10);

	const seq2 = await pending;
	assertEquals(seq2, 2);
	assertEquals(fc.sendInFlightBytes, 6);
});

Deno.test('flow-control: outbound timeout when credits never return', async () => {
	const fc = new FlowController({ remoteMaxBufferSize: 10 });
	await fc.reserveSend(10);

	await assertRejects(
		() => fc.reserveSend(1, { timeout: 20 }),
		TimeoutError,
		'Timed out waiting for send budget'
	);
});

Deno.test('flow-control: outbound detects duplicate ACK', async () => {
	const fc = new FlowController({ remoteMaxBufferSize: 10 });
	await fc.reserveSend(0);
	await fc.reserveSend(5);

	fc.processAck({ baseSequence: 1, ranges: [2] });
	assertEquals(fc.sendInFlightBytes, 0);

	assertThrows(
		() => fc.processAck({ baseSequence: 1, ranges: [1] }),
		ProtocolViolationError,
		'Duplicate ACK'
	);
});

Deno.test('flow-control: inbound enforces maxBufferSize', () => {
	const fc = new FlowController({ maxBufferSize: 10, lowBufferSize: 0 });
	fc.onReceiveChunk({ sequence: 1, size: 6 });

	assertThrows(
		() => fc.onReceiveChunk({ sequence: 2, size: 6 }),
		ProtocolViolationError,
		'Inbound buffer overflow'
	);
});

Deno.test('flow-control: inbound can ACK consumed chunks out-of-order', () => {
	const fc = new FlowController({ channelId: 42, maxBufferSize: 3, lowBufferSize: 2 });

	fc.onReceiveChunk({ sequence: 1, size: 1 });
	fc.onReceiveChunk({ sequence: 2, size: 1 });
	fc.onReceiveChunk({ sequence: 3, size: 1 });
	assertEquals(fc.recvBufferedBytes, 3);

	fc.onConsumeChunk(2);
	assertEquals(fc.shouldSendAck, true);
	assertEquals(fc.createAck(255), { channelId: 42, baseSequence: 2, ranges: [1] });

	fc.onConsumeChunk(1);
	fc.onConsumeChunk(3);
	assertEquals(fc.createAck(255), { channelId: 42, baseSequence: 1, ranges: [1, 1, 1] });
});

Deno.test('flow-control: inbound enforces in-order receive sequence numbers', () => {
	const fc = new FlowController({ maxBufferSize: 0, lowBufferSize: 0 });

	assertThrows(
		() => fc.onReceiveChunk({ sequence: 2, size: 1 }),
		ProtocolViolationError,
		'Unexpected inbound sequence'
	);
});

