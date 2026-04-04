import { assertEquals, assertThrows } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { ChannelFlowControl } from '../../src/channel-flow-control.esm.js';

// ============================================================================
// ChannelFlowControl - Write (Send) Tests
// ============================================================================

Deno.test('ChannelFlowControl - construction with limited budget', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	assertEquals(fc.writeLimit, 10000);
	assertEquals(fc.writeBudget, 10000);
	assertEquals(fc.written, 0);
});

Deno.test('ChannelFlowControl - construction with unlimited budget', () => {
	const fc = new ChannelFlowControl(0, 0);
	assertEquals(fc.writeLimit, 0);
	assertEquals(fc.writeBudget, Infinity);
	assertEquals(fc.written, 0);
});

Deno.test('ChannelFlowControl - sent consumes budget', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(3000);
	assertEquals(fc.nextWriteSeq, 2);
	assertEquals(fc.writeBudget, 7000);
	assertEquals(fc.written, 3000);

	fc.sent(2000);
	assertEquals(fc.nextWriteSeq, 3);
	assertEquals(fc.writeBudget, 5000);
	assertEquals(fc.written, 5000);
});

Deno.test('ChannelFlowControl - sent with unlimited budget', () => {
	const fc = new ChannelFlowControl(0, 0);
	fc.sent(5000);
	fc.sent(10000);
	assertEquals(fc.writeBudget, Infinity);
	assertEquals(fc.written, 15000);
});

Deno.test('ChannelFlowControl - clearWriteAckInfo restores budget (single sequence)', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(3000);
	assertEquals(fc.writeBudget, 7000);

	const result = fc.clearWriteAckInfo(1, []);
	assertEquals(result.bytes, 3000);
	assertEquals(result.acks, 1);
	assertEquals(fc.writeBudget, 10000);
	assertEquals(fc.written, 0);
});

Deno.test('ChannelFlowControl - clearWriteAckInfo with ranges', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(1000);  // seq 1
	fc.sent(2000);  // seq 2
	fc.sent(3000);  // seq 3
	assertEquals(fc.writeBudget, 4000);

	// ACK sequences 1 and 3 (skip 2)
	const result = fc.clearWriteAckInfo(1, [0, 1, 1]);  // skip 1, include 1
	assertEquals(result.bytes, 4000);  // 1000 + 3000
	assertEquals(result.acks, 2);
	assertEquals(fc.writeBudget, 8000);
	assertEquals(fc.written, 2000);
});

Deno.test('ChannelFlowControl - clearWriteAckInfo with large ranges (>255)', () => {
	const fc = new ChannelFlowControl(0, 0);  // Unlimited

	// Send 300 chunks of 100 bytes each
	for (let i = 0; i < 300; i++) {
		fc.sent(100);
	}
	assertEquals(fc.written, 30000);

	// ACK all 300 sequences (requires splitting: 255 + 0 + 44)
	const result = fc.clearWriteAckInfo(1, [255, 0, 44]);
	assertEquals(result.bytes, 30000);
	assertEquals(result.acks, 300);
	assertEquals(fc.written, 0);
});

Deno.test('ChannelFlowControl - clearWriteAckInfo detects duplicate ACK', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(1000);
	const result1 = fc.clearWriteAckInfo(1, []);  // ACK sequence 1
	assertEquals(result1.duplicate, 0);

	const result2 = fc.clearWriteAckInfo(1, []);  // Try to ACK sequence 1 again
	assertEquals(result2.duplicate, 1);
	assertEquals(result2.acks, 0);
});

Deno.test('ChannelFlowControl - clearWriteAckInfo detects premature ACK', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(1000);  // seq 1

	const result = fc.clearWriteAckInfo(2, []);  // Try to ACK sequence 2 (not sent yet)
	assertEquals(result.premature, 1);
	assertEquals(result.acks, 0);
});

Deno.test('ChannelFlowControl - writable resolves immediately if sufficient', async () => {
	const fc = new ChannelFlowControl(10000, 10000);
	const start = Date.now();
	await fc.writable(5000);
	const elapsed = Date.now() - start;
	assertEquals(elapsed < 100, true);  // Should be nearly instant
});

Deno.test('ChannelFlowControl - writable waits for ACK', async () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(8000);  // Budget now 2000

	// Start waiting for 5000 bytes (insufficient)
	const waitPromise = fc.writable(5000);

	// Wait a bit to ensure it's actually waiting
	await new Promise(resolve => setTimeout(resolve, 10));

	// ACK the sent chunk to restore budget
	fc.clearWriteAckInfo(1, []);

	// Now the wait should resolve
	await waitPromise;
	assertEquals(fc.writeBudget, 10000);
});

Deno.test('ChannelFlowControl - writable single waiter model', async () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(9000);  // Budget now 1000

	// Start waiting for 5000 bytes (insufficient)
	const waitPromise = fc.writable(5000);

	// Wait a bit to ensure it's actually waiting
	await new Promise(resolve => setTimeout(resolve, 10));

	// ACK the sent chunk to restore budget
	fc.clearWriteAckInfo(1, []);

	// Now the wait should resolve
	await waitPromise;
	assertEquals(fc.writeBudget, 10000);
});

Deno.test('ChannelFlowControl - write getStats', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.sent(3000);
	fc.sent(2000);

	const stats = fc.getStats();
	assertEquals(stats.writeLimit, 10000);
	assertEquals(stats.nextWriteSeq, 3);
	assertEquals(stats.writeAckInfo, 2);
	assertEquals(stats.written, 5000);
	assertEquals(stats.writeBudget, 5000);
	// Note: In real usage with TaskQueue, waiters would be queue size + (writer ? 1 : 0)
	// For this test (no TaskQueue), just check writer state
	assertEquals(stats.writer, null);
});

// ============================================================================
// ChannelFlowControl - Read (Receive) Tests
// ============================================================================

Deno.test('ChannelFlowControl - read construction with limited budget', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	assertEquals(fc.readLimit, 10000);
	assertEquals(fc.read, 0);
	assertEquals(fc.readBudget, 10000);
	assertEquals(fc.nextReadSeq, 1);
});

Deno.test('ChannelFlowControl - read construction with unlimited budget', () => {
	const fc = new ChannelFlowControl(0, 0);
	assertEquals(fc.readLimit, 0);
	assertEquals(fc.read, 0);
	assertEquals(fc.readBudget, Infinity);
	assertEquals(fc.nextReadSeq, 1);
});

Deno.test('ChannelFlowControl - received consumes buffer', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	const result1 = fc.received(1, 3000);
	assertEquals(result1, true);
	assertEquals(fc.read, 3000);
	assertEquals(fc.readBudget, 7000);
	assertEquals(fc.nextReadSeq, 2);

	const result2 = fc.received(2, 2000);
	assertEquals(result2, true);
	assertEquals(fc.read, 5000);
	assertEquals(fc.readBudget, 5000);
	assertEquals(fc.nextReadSeq, 3);
});

Deno.test('ChannelFlowControl - received with unlimited budget', () => {
	const fc = new ChannelFlowControl(0, 0);
	fc.received(1, 5000);
	fc.received(2, 10000);
	assertEquals(fc.read, 15000);
	assertEquals(fc.readBudget, Infinity);
});

Deno.test('ChannelFlowControl - received returns false on out-of-order', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);

	const result = fc.received(3, 1000);  // Expected 2, got 3
	assertEquals(result, false);
});

Deno.test('ChannelFlowControl - received returns false on over-budget', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 8000);

	const result = fc.received(2, 3000);  // Would exceed budget (8000 + 3000 > 10000)
	assertEquals(result, false);
});

Deno.test('ChannelFlowControl - markProcessed marks chunk as processed', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);

	const result1 = fc.markProcessed(1);
	assertEquals(result1, true);
	assertEquals(fc.ackableBytes, 1000);
	assertEquals(fc.ackableChunks, 1);

	const result2 = fc.markProcessed(1);  // Already processed
	assertEquals(result2, false);
	assertEquals(fc.ackableBytes, 1000);
	assertEquals(fc.ackableChunks, 1);
});

Deno.test('ChannelFlowControl - getAckInfo returns only complete if nothing processed', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { complete: true });
});

Deno.test('ChannelFlowControl - getAckInfo single sequence', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.markProcessed(1);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { base: 1, ranges: [], complete: true });
});

Deno.test('ChannelFlowControl - getAckInfo consecutive sequences', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);
	fc.received(3, 3000);
	fc.markProcessed(1);
	fc.markProcessed(2);
	fc.markProcessed(3);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { base: 1, ranges: [2], complete: true });  // Base + 2 more
});

Deno.test('ChannelFlowControl - getAckInfo with gaps', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);
	fc.received(3, 3000);
	fc.received(4, 4000);
	fc.markProcessed(1);
	fc.markProcessed(3);  // Skip 2
	fc.markProcessed(4);

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo, { base: 1, ranges: [0, 1, 2], complete: true });  // Base by itself (no additional), then skip 1, include 2
});

Deno.test('ChannelFlowControl - getAckInfo with large ranges (>255)', () => {
	const fc = new ChannelFlowControl(0, 0);  // Unlimited

	// Receive and process 300 sequences
	for (let i = 1; i <= 300; i++) {
		fc.received(i, 100);
		fc.markProcessed(i);
	}

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.base, 1);
	// Should split: 255 + 0 + 44 (299 sequences after base)
	assertEquals(ackInfo.ranges, [255, 0, 44]);
	assertEquals(ackInfo.complete, true);
});

Deno.test('ChannelFlowControl - getAckInfo enforces 501 range limit', () => {
	const fc = new ChannelFlowControl(0, 0);  // Unlimited

	// Create alternating processed/unprocessed pattern (worst case for ranges)
	for (let i = 1; i <= 1000; i++) {
		fc.received(i, 100);
		if (i % 2 === 1) {  // Process odd sequences only
			fc.markProcessed(i);
		}
	}

	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.base, 1);
	// Should stop at 501 ranges (alternating 1 include, 1 skip)
	assertEquals(ackInfo.ranges.length <= 501, true);
	// Should be incomplete since we hit the limit
	assertEquals(ackInfo.complete, false);
});

Deno.test('ChannelFlowControl - clearReadAckInfo frees buffer space', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);
	fc.received(3, 3000);
	fc.markProcessed(1);
	fc.markProcessed(2);
	fc.markProcessed(3);

	assertEquals(fc.read, 6000);
	assertEquals(fc.ackableBytes, 6000);

	const ackInfo = fc.getAckInfo();
	const result = fc.clearReadAckInfo(ackInfo.base, ackInfo.ranges);

	assertEquals(result.bytes, 6000);
	assertEquals(result.acks, 3);
	assertEquals(fc.read, 0);
	assertEquals(fc.readBudget, 10000);
	assertEquals(fc.ackableBytes, 0);
	assertEquals(fc.ackableChunks, 0);
});

Deno.test('ChannelFlowControl - clearReadAckInfo with gaps', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 1000);
	fc.received(2, 2000);
	fc.received(3, 3000);
	fc.markProcessed(1);
	fc.markProcessed(3);  // Skip 2

	const ackInfo = fc.getAckInfo();
	const result = fc.clearReadAckInfo(ackInfo.base, ackInfo.ranges);

	assertEquals(result.bytes, 4000);  // 1000 + 3000
	assertEquals(result.acks, 2);
	assertEquals(fc.read, 2000);  // Sequence 2 still tracked
	assertEquals(fc.ackableBytes, 0);
});

Deno.test('ChannelFlowControl - read getStats', () => {
	const fc = new ChannelFlowControl(10000, 10000);
	fc.received(1, 3000);
	fc.received(2, 2000);
	fc.markProcessed(1);

	const stats = fc.getStats();
	assertEquals(stats.readLimit, 10000);
	assertEquals(stats.nextReadSeq, 3);
	assertEquals(stats.readAckInfo, 2);
	assertEquals(stats.read, 5000);
	assertEquals(stats.readBudget, 5000);
	assertEquals(stats.ackableBytes, 3000);
	assertEquals(stats.ackableChunks, 1);
});

// ============================================================================
// Integration Tests
// ============================================================================

Deno.test('Integration - send and receive with ACKs', () => {
	const fc = new ChannelFlowControl(10000, 10000);

	// Send 3 chunks
	fc.sent(3000);
	fc.sent(2000);
	fc.sent(1000);

	assertEquals(fc.writeBudget, 4000);

	// Receive 3 chunks
	fc.received(1, 3000);
	fc.received(2, 2000);
	fc.received(3, 1000);

	assertEquals(fc.read, 6000);

	// Process all chunks
	fc.markProcessed(1);
	fc.markProcessed(2);
	fc.markProcessed(3);

	// Generate ACK
	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.base, 1);
	assertEquals(ackInfo.ranges, [2]); // Base + 2 consecutive

	// Process ACK
	const writeResult = fc.clearWriteAckInfo(ackInfo.base, ackInfo.ranges);
	assertEquals(writeResult.bytes, 6000);
	assertEquals(fc.writeBudget, 10000);

	// Clear ACK'd chunks
	const readResult = fc.clearReadAckInfo(ackInfo.base, ackInfo.ranges);
	assertEquals(readResult.bytes, 6000);
	assertEquals(fc.read, 0);
});

Deno.test('Integration - selective processing and ACK', () => {
	const fc = new ChannelFlowControl(10000, 10000);

	// Send 5 chunks
	for (let i = 1; i <= 5; i++) {
		fc.sent(1000);
		fc.received(i, 1000);
	}

	// Process only sequences 1, 2, and 5
	fc.markProcessed(1);
	fc.markProcessed(2);
	fc.markProcessed(5);

	// Generate ACK (should include 1-2, skip 3-4, include 5)
	const ackInfo = fc.getAckInfo();
	assertEquals(ackInfo.base, 1);
	assertEquals(ackInfo.ranges, [1, 2, 1]);  // Base + 1 more, skip 2, include 1

	// Process ACK
	const writeResult = fc.clearWriteAckInfo(ackInfo.base, ackInfo.ranges);
	assertEquals(writeResult.bytes, 3000);  // Sequences 1, 2, 5
	assertEquals(fc.written, 2000);  // Sequences 3, 4 still in flight
});

// ============================================================================
// ACK Batching Tests
// ============================================================================

Deno.test('ChannelFlowControl - ACK batching with callback', async () => {
	let ackCallCount = 0;
	const ackCallback = () => { ackCallCount++; };

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 0,  // No delay
		lowReadBytes: 0   // Always ACK
	});

	fc.received(1, 1000);
	fc.markProcessed(1);

	// Wait for microtask to execute
	await new Promise(resolve => setTimeout(resolve, 0));

	assertEquals(ackCallCount, 1);
});

Deno.test('ChannelFlowControl - ACK batching respects low water mark', async () => {
	let ackCallCount = 0;
	const ackCallback = () => { ackCallCount++; };

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 0,
		lowReadBytes: 5000  // Don't ACK until below 5000
	});

	fc.received(1, 6000);
	fc.markProcessed(1);

	// Wait for microtask
	await new Promise(resolve => setTimeout(resolve, 0));

	// Should not ACK yet (above low water mark)
	assertEquals(ackCallCount, 0);
});

Deno.test('ChannelFlowControl - ACK batching with force bytes', async () => {
	let ackCallCount = 0;
	const ackCallback = () => { ackCallCount++; };

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 100,  // 100ms delay
		forceAckBytes: 5000,  // Force ACK at 5000 bytes
		lowReadBytes: 0
	});

	fc.received(1, 6000);
	fc.markProcessed(1);

	// Should ACK immediately (exceeds forceAckBytes)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 1);
});

Deno.test('ChannelFlowControl - ACK batching with force chunks', async () => {
	let ackCallCount = 0;
	const ackCallback = () => { ackCallCount++; };

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 100,  // 100ms delay
		forceAckChunks: 3,  // Force ACK at 3 chunks
		lowReadBytes: 0
	});

	fc.received(1, 1000);
	fc.received(2, 1000);
	fc.received(3, 1000);
	fc.markProcessed(1);
	fc.markProcessed(2);
	fc.markProcessed(3);

	// Should ACK immediately (exceeds forceAckChunks)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 1);
});

Deno.test('ChannelFlowControl - ACK batching with delay', async () => {
	let ackCallCount = 0;
	const ackCallback = () => { ackCallCount++; };

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 50,  // 50ms delay
		lowReadBytes: 0
	});

	fc.received(1, 1000);
	fc.markProcessed(1);

	// Should ACK immediately (first ACK)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 1);

	// Clear the ACK
	const ackInfo = fc.getAckInfo();
	fc.clearReadAckInfo(ackInfo.base, ackInfo.ranges);

	// Receive and process another chunk
	fc.received(2, 1000);
	fc.markProcessed(2);

	// Should not ACK immediately (batching delay)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 1);

	// Wait for batching delay
	await new Promise(resolve => setTimeout(resolve, 60));
	assertEquals(ackCallCount, 2);
});

Deno.test('ChannelFlowControl - ACK batching prevents duplicate pending', async () => {
	let ackCallCount = 0;
	const ackCallback = () => {
		ackCallCount++;
		// Simulate real callback behavior: get ACK info and clear it
		const ackInfo = fc.getAckInfo();
		if (ackInfo) {
			fc.clearReadAckInfo(ackInfo.base, ackInfo.ranges);
		}
	};

	const fc = new ChannelFlowControl(10000, 10000, {
		ackCallback,
		ackBatchTime: 0,
		lowReadBytes: 0
	});

	fc.received(1, 1000);
	fc.markProcessed(1);

	// Wait for first ACK
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 1);

	// Mark another chunk processed before first ACK callback runs
	// (This is a race condition test - in practice, markProcessed happens
	// after scheduleAcks queues the microtask but before it runs)
	fc.received(2, 1000);
	fc.markProcessed(2);

	// Wait for second ACK (should be scheduled by clearReadAckInfo in first callback)
	await new Promise(resolve => setTimeout(resolve, 0));
	assertEquals(ackCallCount, 2);
});

Deno.test('ChannelFlowControl - ackableBytes and ackableChunks getters', () => {
	const fc = new ChannelFlowControl(10000, 10000);

	assertEquals(fc.ackableBytes, 0);
	assertEquals(fc.ackableChunks, 0);

	fc.received(1, 1000);
	fc.received(2, 2000);

	assertEquals(fc.ackableBytes, 0);
	assertEquals(fc.ackableChunks, 0);

	fc.markProcessed(1);

	assertEquals(fc.ackableBytes, 1000);
	assertEquals(fc.ackableChunks, 1);

	fc.markProcessed(2);

	assertEquals(fc.ackableBytes, 3000);
	assertEquals(fc.ackableChunks, 2);
});
