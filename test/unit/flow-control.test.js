import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { SendFlowControl, ReceiveFlowControl, ProtocolViolationError } from '../../src/flow-control.esm.js';

// ============================================================================
// SendFlowControl Tests
// ============================================================================

Deno.test('SendFlowControl - construction with limited budget', () => {
	const fc = new SendFlowControl(10000);
	assertEquals(fc.remoteMaxBufferBytes, 10000);
	assertEquals(fc.sendingBudget, 10000);
	assertEquals(fc.inFlightBytes, 0);
});

Deno.test('SendFlowControl - construction with unlimited budget', () => {
	const fc = new SendFlowControl(0);
	assertEquals(fc.remoteMaxBufferBytes, 0);
	assertEquals(fc.sendingBudget, Infinity);
	assertEquals(fc.inFlightBytes, 0);
});

Deno.test('SendFlowControl - canSend with sufficient budget', () => {
	const fc = new SendFlowControl(10000);
	assertEquals(fc.canSend(5000), true);
	assertEquals(fc.canSend(10000), true);
});

Deno.test('SendFlowControl - canSend with insufficient budget', () => {
	const fc = new SendFlowControl(10000);
	assertEquals(fc.canSend(10001), false);
});

Deno.test('SendFlowControl - canSend with unlimited budget', () => {
	const fc = new SendFlowControl(0);
	assertEquals(fc.canSend(999999999), true);
});

Deno.test('SendFlowControl - recordSent consumes budget', () => {
	const fc = new SendFlowControl(10000);
	const seq1 = fc.recordSent(3000);
	assertEquals(seq1, 1);
	assertEquals(fc.sendingBudget, 7000);
	assertEquals(fc.inFlightBytes, 3000);

	const seq2 = fc.recordSent(2000);
	assertEquals(seq2, 2);
	assertEquals(fc.sendingBudget, 5000);
	assertEquals(fc.inFlightBytes, 5000);
});

Deno.test('SendFlowControl - recordSent with unlimited budget', () => {
	const fc = new SendFlowControl(0);
	fc.recordSent(5000);
	fc.recordSent(10000);
	assertEquals(fc.sendingBudget, Infinity);
	assertEquals(fc.inFlightBytes, 15000);
});

Deno.test('SendFlowControl - processAck restores budget (single sequence)', () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(3000);
	assertEquals(fc.sendingBudget, 7000);

	const freed = fc.processAck(1, []);
	assertEquals(freed, 3000);
	assertEquals(fc.sendingBudget, 10000);
	assertEquals(fc.inFlightBytes, 0);
});

Deno.test('SendFlowControl - processAck with ranges', () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(1000);  // seq 1
	fc.recordSent(2000);  // seq 2
	fc.recordSent(3000);  // seq 3
	assertEquals(fc.sendingBudget, 4000);

	// ACK sequences 1 and 3 (skip 2)
	const freed = fc.processAck(1, [0, 1, 1]);  // skip 1, include 1
	assertEquals(freed, 4000);  // 1000 + 3000
	assertEquals(fc.sendingBudget, 8000);
	assertEquals(fc.inFlightBytes, 2000);
});

Deno.test('SendFlowControl - processAck with large ranges (>255)', () => {
	const fc = new SendFlowControl(0);  // Unlimited
	
	// Send 300 chunks of 100 bytes each
	for (let i = 0; i < 300; i++) {
		fc.recordSent(100);
	}
	assertEquals(fc.inFlightBytes, 30000);

	// ACK all 300 sequences (requires splitting: 255 + 0 + 44)
	const freed = fc.processAck(1, [255, 0, 44]);
	assertEquals(freed, 30000);
	assertEquals(fc.inFlightBytes, 0);
});

Deno.test('SendFlowControl - processAck throws on duplicate ACK', () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(1000);
	fc.processAck(1, []);  // ACK sequence 1

	assertThrows(
		() => fc.processAck(1, []),  // Try to ACK sequence 1 again
		ProtocolViolationError,
		'DuplicateAck'
	);
});

Deno.test('SendFlowControl - processAck throws on premature ACK', () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(1000);  // seq 1

	assertThrows(
		() => fc.processAck(2, []),  // Try to ACK sequence 2 (not sent yet)
		ProtocolViolationError,
		'PrematureAck'
	);
});

Deno.test('SendFlowControl - waitForBudget resolves immediately if sufficient', async () => {
	const fc = new SendFlowControl(10000);
	const start = Date.now();
	await fc.waitForBudget(5000);
	const elapsed = Date.now() - start;
	assertEquals(elapsed < 100, true);  // Should be nearly instant
});

Deno.test('SendFlowControl - waitForBudget waits for ACK', async () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(8000);  // Budget now 2000

	// Start waiting for 5000 bytes (insufficient)
	const waitPromise = fc.waitForBudget(5000);
	
	// Wait a bit to ensure it's actually waiting
	await new Promise(resolve => setTimeout(resolve, 10));

	// ACK the sent chunk to restore budget
	fc.processAck(1, []);

	// Now the wait should resolve
	await waitPromise;
	assertEquals(fc.sendingBudget, 10000);
});

Deno.test('SendFlowControl - waitForBudget FIFO ordering', async () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(9000);  // Budget now 1000

	const order = [];

	// Queue three waiters
	const wait1 = fc.waitForBudget(2000).then(() => order.push(1));
	const wait2 = fc.waitForBudget(3000).then(() => order.push(2));
	const wait3 = fc.waitForBudget(1500).then(() => order.push(3));

	// ACK to restore budget
	fc.processAck(1, []);  // Budget now 10000

	await Promise.all([wait1, wait2, wait3]);

	// Should resolve in FIFO order: 1, 2, 3
	assertEquals(order, [1, 2, 3]);
});

Deno.test('SendFlowControl - getStats', () => {
	const fc = new SendFlowControl(10000);
	fc.recordSent(3000);
	fc.recordSent(2000);

	const stats = fc.getStats();
	assertEquals(stats.remoteMaxBufferBytes, 10000);
	assertEquals(stats.nextSendSeq, 3);
	assertEquals(stats.inFlightChunks, 2);
	assertEquals(stats.inFlightBytes, 5000);
	assertEquals(stats.sendingBudget, 5000);
	assertEquals(stats.waiters, 0);
});

// ============================================================================
// ReceiveFlowControl Tests
// ============================================================================

Deno.test('ReceiveFlowControl - construction with limited budget', () => {
	const fc = new ReceiveFlowControl(10000);
	assertEquals(fc.localMaxBufferBytes, 10000);
	assertEquals(fc.bufferUsed, 0);
	assertEquals(fc.bufferAvailable, 10000);
	assertEquals(fc.nextExpectedSeq, 1);
});

Deno.test('ReceiveFlowControl - construction with unlimited budget', () => {
	const fc = new ReceiveFlowControl(0);
	assertEquals(fc.localMaxBufferBytes, 0);
	assertEquals(fc.bufferUsed, 0);
	assertEquals(fc.bufferAvailable, Infinity);
	assertEquals(fc.nextExpectedSeq, 1);
});

Deno.test('ReceiveFlowControl - recordReceived consumes buffer', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 3000);
	assertEquals(fc.bufferUsed, 3000);
	assertEquals(fc.bufferAvailable, 7000);
	assertEquals(fc.nextExpectedSeq, 2);

	fc.recordReceived(2, 2000);
	assertEquals(fc.bufferUsed, 5000);
	assertEquals(fc.bufferAvailable, 5000);
	assertEquals(fc.nextExpectedSeq, 3);
});

Deno.test('ReceiveFlowControl - recordReceived with unlimited budget', () => {
	const fc = new ReceiveFlowControl(0);
	fc.recordReceived(1, 5000);
	fc.recordReceived(2, 10000);
	assertEquals(fc.bufferUsed, 15000);
	assertEquals(fc.bufferAvailable, Infinity);
});

Deno.test('ReceiveFlowControl - recordReceived throws on out-of-order', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);

	assertThrows(
		() => fc.recordReceived(3, 1000),  // Expected 2, got 3
		ProtocolViolationError,
		'OutOfOrder'
	);
});

Deno.test('ReceiveFlowControl - recordReceived throws on over-budget', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 8000);

	assertThrows(
		() => fc.recordReceived(2, 3000),  // Would exceed budget (8000 + 3000 > 10000)
		ProtocolViolationError,
		'OverBudget'
	);
});

Deno.test('ReceiveFlowControl - recordConsumed marks chunk as consumed', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);

	const result1 = fc.recordConsumed(1);
	assertEquals(result1, true);

	const result2 = fc.recordConsumed(1);  // Already consumed
	assertEquals(result2, false);
});

Deno.test('ReceiveFlowControl - getAckInfo returns null if nothing consumed', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, null);
});

Deno.test('ReceiveFlowControl - getAckInfo single sequence', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordConsumed(1);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { baseSeq: 1, ranges: [] });
});

Deno.test('ReceiveFlowControl - getAckInfo consecutive sequences', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);
	fc.recordReceived(3, 3000);
	fc.recordConsumed(1);
	fc.recordConsumed(2);
	fc.recordConsumed(3);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { baseSeq: 1, ranges: [2] });  // Base + 2 more
});

Deno.test('ReceiveFlowControl - getAckInfo with gaps', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);
	fc.recordReceived(3, 3000);
	fc.recordReceived(4, 4000);
	fc.recordConsumed(1);
	fc.recordConsumed(3);  // Skip 2
	fc.recordConsumed(4);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { baseSeq: 1, ranges: [0, 1, 2] });  // Base by itself (no additional), then skip 1, include 2
});

Deno.test('ReceiveFlowControl - getAckInfo with large ranges (>255)', () => {
	const fc = new ReceiveFlowControl(0);  // Unlimited
	
	// Receive and consume 300 sequences
	for (let i = 1; i <= 300; i++) {
		fc.recordReceived(i, 100);
		fc.recordConsumed(i);
	}

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.baseSeq, 1);
	// Should split: 255 + 0 + 44 (299 sequences after base)
	assertEquals(ackInfo.ranges, [255, 0, 44]);
});

Deno.test('ReceiveFlowControl - getAckInfo enforces 255 range limit', () => {
	const fc = new ReceiveFlowControl(0);  // Unlimited
	
	// Create alternating consumed/unconsumed pattern (worst case for ranges)
	for (let i = 1; i <= 1000; i++) {
		fc.recordReceived(i, 100);
		if (i % 2 === 1) {  // Consume odd sequences only
			fc.recordConsumed(i);
		}
	}

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.baseSeq, 1);
	// Should stop at 255 ranges (alternating 1 include, 1 skip)
	assertEquals(ackInfo.ranges.length <= 255, true);
});

Deno.test('ReceiveFlowControl - clearAcked frees buffer space', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);
	fc.recordReceived(3, 3000);
	fc.recordConsumed(1);
	fc.recordConsumed(2);
	fc.recordConsumed(3);

	assertEquals(fc.bufferUsed, 6000);

	const ackInfo = fc.getAckInfo();
	const freed = fc.clearAcked(ackInfo.baseSeq, ackInfo.ranges);

	assertEquals(freed, 6000);
	assertEquals(fc.bufferUsed, 0);
	assertEquals(fc.bufferAvailable, 10000);
});

Deno.test('ReceiveFlowControl - clearAcked with gaps', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 1000);
	fc.recordReceived(2, 2000);
	fc.recordReceived(3, 3000);
	fc.recordConsumed(1);
	fc.recordConsumed(3);  // Skip 2

	const ackInfo = fc.getAckInfo();
	const freed = fc.clearAcked(ackInfo.baseSeq, ackInfo.ranges);

	assertEquals(freed, 4000);  // 1000 + 3000
	assertEquals(fc.bufferUsed, 2000);  // Sequence 2 still tracked
});

Deno.test('ReceiveFlowControl - getStats', () => {
	const fc = new ReceiveFlowControl(10000);
	fc.recordReceived(1, 3000);
	fc.recordReceived(2, 2000);
	fc.recordConsumed(1);

	const stats = fc.getStats();
	assertEquals(stats.localMaxBufferBytes, 10000);
	assertEquals(stats.nextExpectedSeq, 3);
	assertEquals(stats.receivedChunks, 2);
	assertEquals(stats.receivedBytes, 5000);
	assertEquals(stats.bufferUsed, 5000);
	assertEquals(stats.bufferAvailable, 5000);
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test('Integration - send and receive with ACKs', () => {
	const sendFC = new SendFlowControl(10000);
	const receiveFC = new ReceiveFlowControl(10000);

	// Send 3 chunks
	const seq1 = sendFC.recordSent(3000);
	const seq2 = sendFC.recordSent(2000);
	const seq3 = sendFC.recordSent(1000);

	assertEquals(sendFC.sendingBudget, 4000);

	// Receive 3 chunks
	receiveFC.recordReceived(seq1, 3000);
	receiveFC.recordReceived(seq2, 2000);
	receiveFC.recordReceived(seq3, 1000);

	assertEquals(receiveFC.bufferUsed, 6000);

	// Consume all chunks
	receiveFC.recordConsumed(seq1);
	receiveFC.recordConsumed(seq2);
	receiveFC.recordConsumed(seq3);

	// Generate ACK
	const ackInfo = receiveFC.getAckInfo();
	assertEquals(ackInfo.baseSeq, 1);
	assertEquals(ackInfo.ranges, [2]); // Base + 2 consecutive

	// Process ACK
	const freed = sendFC.processAck(ackInfo.baseSeq, ackInfo.ranges);
	assertEquals(freed, 6000);
	assertEquals(sendFC.sendingBudget, 10000);

	// Clear ACK'd chunks
	receiveFC.clearAcked(ackInfo.baseSeq, ackInfo.ranges);
	assertEquals(receiveFC.bufferUsed, 0);
});

Deno.test('Integration - selective consumption and ACK', () => {
	const sendFC = new SendFlowControl(10000);
	const receiveFC = new ReceiveFlowControl(10000);

	// Send 5 chunks
	for (let i = 1; i <= 5; i++) {
		sendFC.recordSent(1000);
		receiveFC.recordReceived(i, 1000);
	}

	// Consume only sequences 1, 2, and 5
	receiveFC.recordConsumed(1);
	receiveFC.recordConsumed(2);
	receiveFC.recordConsumed(5);

	// Generate ACK (should include 1-2, skip 3-4, include 5)
	const ackInfo = receiveFC.getAckInfo();
	assertEquals(ackInfo.baseSeq, 1);
	assertEquals(ackInfo.ranges, [1, 2, 1]);  // Base + 1 more, skip 2, include 1

	// Process ACK
	const freed = sendFC.processAck(ackInfo.baseSeq, ackInfo.ranges);
	assertEquals(freed, 3000);  // Sequences 1, 2, 5
	assertEquals(sendFC.inFlightBytes, 2000);  // Sequences 3, 4 still in flight
});
