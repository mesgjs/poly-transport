# Flow Control Model: Three-Layer Resource Coordination

**Date**: 2026-01-17
**Status**: Architecture Document

## Overview

PolyTransport uses a **three-layer resource coordination system** to prevent buffer overflow and ensure reliable data transfer. Each layer manages a different type of resource, and all three must be available before data can be sent.

This document provides a high-level explanation of how these layers work together, with a focus on understanding the overall model rather than implementation details.

## The Three Layers

### Layer 1: Channel Budget (Per-Channel Flow Control)

**What it controls**: How much data can be in-flight for a specific channel

**Managed by**: [`ChannelFlowControl`](../src/channel-flow-control.esm.js) class

**Purpose**: Prevents overwhelming the remote's channel buffer

**Key Concepts**:
- Each channel has its own budget (independent of other channels)
- Budget = remote channel's `maxBufferBytes` - in-flight bytes
- In-flight bytes = data sent but not yet ACK'd by remote
- Budget restored when remote sends ACK (acknowledges consumption)
- Sequence numbers track which chunks are in-flight

**Example**:
```
Remote's channel buffer: 64KB
Already in-flight: 48KB
Available channel budget: 16KB
→ Can send up to 16KB more on this channel
```

### Layer 2: Transport Budget (Shared Across All Channels)

**What it controls**: How much data can be in-flight across ALL channels on this transport

**Managed by**: Transport class (via `TransportFlowControl` - to be implemented)

**Purpose**: Prevents overwhelming the remote's transport-level buffer

**Key Concepts**:
- Single budget shared by all channels on the transport
- Budget = remote's transport `maxBufferBytes` - total in-flight bytes
- In-flight bytes = sum of all channel in-flight bytes
- Budget restored when remote sends ACKs (any channel)
- FIFO round-robin ensures fairness across channels

**Example**:
```
Remote's transport buffer: 256KB
Channel A in-flight: 48KB
Channel B in-flight: 64KB
Channel C in-flight: 32KB
Total in-flight: 144KB
Available transport budget: 112KB
→ Can send up to 112KB more across all channels
```

### Layer 3: Ring Buffer Space (Local Output Buffer)

**What it controls**: How much space is available in the local output ring buffer

**Managed by**: [`OutputRingBuffer`](../src/output-ring-buffer.esm.js) class

**Purpose**: Provides zero-copy encoding space before data is sent

**Key Concepts**:
- Fixed-size circular buffer (e.g., 256KB)
- Space = total size - committed bytes - reserved bytes
- Space freed when data is consumed (after successful send)
- Single pending reservation at a time (prevents overlap)
- Zero-after-write security (prevents data leakage)

**Example**:
```
Ring buffer size: 256KB
Committed (ready to send): 64KB
Reserved (being encoded): 16KB
Available space: 176KB
→ Can reserve up to 176KB for next chunk
```

## How the Layers Work Together

### Sending Data: Three-Resource Coordination

When a channel wants to send data, it must acquire resources from all three layers **atomically**:

```
1. Reserve channel budget (Layer 1)
   ↓ (if available)
2. Reserve transport budget (Layer 2)
   ↓ (if available)
3. Reserve ring buffer space (Layer 3)
   ↓ (if available)
4. Encode header and data
5. Commit to ring buffer
6. Send in background
```

**Critical**: All three reservations must succeed before encoding begins. This prevents:
- **Budget theft**: Another writer stealing budget while waiting
- **Deadlocks**: Holding one resource while waiting for another
- **Race conditions**: Multiple writers interfering with each other

**Serialization**: TaskQueue ensures only one chunk is reserving resources at a time (per channel for Layer 1, across all channels for Layer 2, per ring for Layer 3).

### Receiving Data: Two-Level Validation

When data arrives, it must be validated against two budgets:

```
1. Validate transport budget (Layer 2)
   ↓ (if within budget)
2. Validate channel budget (Layer 1)
   ↓ (if within budget)
3. Store in channel buffer
4. Deliver to application
5. Application consumes
6. Generate ACK (if below low-water mark)
```

**Critical**: Validation order is transport first, then channel. This ensures:
- **Transport-level violations** are caught early (close entire transport)
- **Channel-level violations** are isolated (close only that channel)
- **Protocol compliance** is enforced at both levels

### ACK Messages: Special Case

ACKs are **transport-level messages** that restore budget but don't consume budget.

**Terminology**:
- **Transport A**: Original data sender (will receive ACKs)
- **Transport B**: Data receiver (will send ACKs)

**Transport B (ACK Sending)**:
```
1. Application consumes chunk
2. Channel buffer usage drops below low-water mark
3. Generate ACK information (base sequence + ranges)
4. Reserve ring buffer space (Layer 3 only, with exact: true)
5. Encode ACK header
6. Send ACK to transport A
7. Free ring buffer space immediately
```

**Transport A (ACK Processing)**:
```
1. Receive ACK message from transport B
2. Restore channel budget (Layer 1)
3. Restore transport budget (Layer 2)
4. Wake waiting writer (if budget now available)
```

**Why ACKs are special**:
- **Fire-and-forget**: ACKs are not acknowledged (no ACK-on-ACK)
- **Ring buffer only**: ACKs use Layer 3 only, not Layer 1 or Layer 2
- **Immediate release**: Ring buffer space freed right after send
- **Budget restoration**: ACKs restore Layers 1 and 2 on transport A
- **No rate limiting**: Transport B can send ACKs as fast as ring buffer can push them

### ACK Memory Bounds

**Question**: What prevents unbounded ACK memory usage?

**Answer**: There are two ACK memory concerns, both naturally bounded:

**1. Transport B's Tracking Memory** (un-ACK'd chunks):
- Transport B tracks received chunks until they're ACK'd
- Maximum tracking = transport A's in-flight data
- Transport A cannot send more than `remoteMaxBufferBytes` (Layer 1 and 2 limits imposed by B on A)
- Therefore, transport B's tracking is bounded by those budgets

**Example**:
```
Transport A (data sender):
- Channel budget: 64KB
- Sends: 64KB (budget exhausted, cannot send more)

Transport B (data receiver, ACK sender):
- Receives: 64KB (tracks all chunks)
- Consumes: 48KB (marks as consumed)
- Generates ACK: 48KB worth of chunks
- Tracking memory: At most 64KB worth of sequence numbers
```

**2. Transport A's ACK Buffer Memory** (incoming ACK messages):
- ACKs are processed immediately upon receipt (not queued)
- ACK processing is synchronous (decode → validate → restore budget)
- ACKs cannot "hang around" like channel data buffers
- Very short-lived (microseconds to milliseconds)

**Example**:
```
Transport A (ACK receiver):
1. Receive ACK message (14-514 bytes)
2. Decode header immediately
3. Validate sequences
4. Restore budgets
5. Wake waiting writers
6. ACK buffer freed
Total time: < 1ms typically
```

**Rate Limiting**: Transport B can send ACKs as fast as its output ring buffer can push them (no transport or channel budget required). The only bounds are:
- **Ring buffer space**: Must have space to encode ACK (typically 14-514 bytes)
- **Transport A's in-flight data**: Cannot ACK more than transport A has sent
- **Protocol validation**: No duplicate or premature ACKs allowed (protocol violations)

## Preventing Buffer Overflow

### How Each Layer Prevents Overflow

**Layer 1 (Channel Budget)**:
- Sender cannot send more than remote's channel buffer can hold
- Remote validates incoming chunks against channel budget
- Out-of-order or over-budget chunks trigger protocol violation
- ACKs restore budget as remote consumes data

**Layer 2 (Transport Budget)**:
- Sender cannot send more than remote's transport buffer can hold
- Remote validates incoming chunks against transport budget
- Over-budget chunks trigger protocol violation (close transport)
- ACKs restore budget as remote consumes data (any channel)

**Layer 3 (Ring Buffer Space)**:
- Sender cannot encode more than ring buffer can hold
- Synchronous reservation (returns null if insufficient space)
- Async waiting via TaskQueue (serialized, FIFO)
- Space freed immediately after send (zero-after-write)

### ACKs and Buffer Limits

**Question**: How do we ensure ACKs can be sent when buffers are full?

**Answer**: ACKs use ring buffer space only (Layer 3), not transport or channel budget.

**Mechanism**:
1. **Data messages** reserve extra ring space (`RESERVE_ACK_BYTES` = 514 bytes)
   - This ensures ACKs can be sent even when ring is nearly full
   - Formula: `reserve(dataBytes + RESERVE_ACK_BYTES, { exact: false })`

2. **ACK messages** reserve exact space needed (no extra)
   - Bypasses `RESERVE_ACK_BYTES` requirement
   - Formula: `reserve(ackBytes, { exact: true })`

3. **Ring buffer space** is freed immediately after ACK send
   - ACKs are fire-and-forget (no waiting for ACK-on-ACK)
   - Space available for next data message

**Example**:
```
Ring buffer: 256KB total
Data ready: 250KB (reserves 250KB + 514 bytes = 250.5KB)
ACK ready: 14 bytes (reserves 14 bytes, no extra)

Scenario 1: Ring has 5KB free
- Data cannot reserve (needs 250.5KB)
- ACK can reserve (needs 14 bytes)
- ACK sent first, frees 14 bytes immediately
- Data still cannot reserve (needs 250.5KB)
- Wait for more space

Scenario 2: Ring has 251KB free
- Data can reserve (250.5KB)
- ACK can reserve (14 bytes)
- ACK sent first (priority), frees 14 bytes
- Data sent next (uses freed space)
```

### Protocol Violations

**Out-of-Order Sequence** (Layer 1):
- Chunks must arrive in consecutive sequence order
- Detected by: `ChannelFlowControl.recordReceived()`
- Action: Emit `protocolViolation` event, handler decides (close channel or transport)

**Over-Budget Chunk** (Layer 1 or Layer 2):
- Chunk exceeds available channel or transport budget
- Detected by: `ChannelFlowControl.recordReceived()` or `TransportFlowControl.recordReceived()`
- Action: Emit `protocolViolation` event, handler decides (close channel or transport)

**Duplicate ACK** (Layer 1):
- ACKing same sequence twice
- Detected by: `ChannelFlowControl.processAck()`
- Action: Emit `protocolViolation` event, handler decides

**Premature ACK** (Layer 1):
- ACKing sequence that hasn't been sent yet
- Detected by: `ChannelFlowControl.processAck()`
- Action: Emit `protocolViolation` event, handler decides

**Unknown Channel** (Transport):
- ACK or data for channel that doesn't exist
- Detected by: Transport when looking up channel
- Action: Emit `protocolViolation` event, handler decides

## Fairness and Starvation Prevention

### Channel-Level Fairness (Layer 1)

**Problem**: Large multi-chunk messages could block small single-chunk messages

**Solution**: Chunk-level serialization via TaskQueue
- Each chunk is independent (can interleave with other messages)
- Example: Message A (3 chunks), Message B (1 chunk) → `A1, B1, A2, A3`
- FIFO ordering within channel ensures fairness

### Transport-Level Fairness (Layer 2)

**Problem**: Multiple channels competing for shared transport budget

**Solution**: FIFO round-robin via TaskQueue
- Channels wait in FIFO order for transport budget
- Example: Channel A waits, Channel B waits, Channel C waits
- Budget freed: Wake A, then B, then C (in order)
- Prevents starvation of any channel

### Ring Buffer Fairness (Layer 3)

**Problem**: Large reservations could block small reservations

**Solution**: Single waiter model via TaskQueue
- Only one chunk waiting for ring space at a time
- Other chunks wait in TaskQueue (FIFO)
- Space freed: Wake next waiter in queue
- Prevents starvation

## Budget Restoration Flow

### Transport B (Data Receiver, ACK Sender)

```
1. Application reads chunk
2. Application processes chunk data
3. Application calls chunk.done()
4. ChannelFlowControl.recordConsumed(seq)
5. Check channel buffer usage
6. If below low-water mark:
   a. Generate ACK info (base + ranges)
   b. Reserve ring space (exact: true)
   c. Encode ACK header
   d. Send ACK to transport A
   e. Free ring space immediately
   f. Clear ACK'd chunks from tracking
```

### Transport A (Data Sender, ACK Receiver)

```
1. Receive ACK message from transport B
2. Decode ACK header (base + ranges)
3. Find channel by ID
4. ChannelFlowControl.processAck(base, ranges)
   a. Validate sequences (no duplicates, no premature)
   b. Remove ACK'd chunks from in-flight map
   c. Restore channel budget
   d. Wake waiting writer (FIFO)
5. Transport restores transport budget
6. Wake waiting channels (FIFO)
```

## Key Takeaways

1. **Three layers, three resources**: Channel budget, transport budget, ring buffer space
2. **All three must be available**: Atomic reservation prevents race conditions
3. **ACKs are special**: Ring buffer only, fire-and-forget, immediate release
4. **Data messages reserve extra**: `RESERVE_ACK_BYTES` ensures ACKs can be sent
5. **Protocol violations detected**: Out-of-order, over-budget, duplicate ACK, premature ACK
6. **Fairness at all levels**: TaskQueue serialization, FIFO ordering, chunk-level interleaving
7. **Budget restoration**: ACKs restore both channel and transport budgets
8. **Validation order**: Transport first (outer layer), then channel (inner layer)

## Related Documents

- [`arch/scenarios/send-flow-control.md`](scenarios/send-flow-control.md) - Detailed send-side flow control
- [`arch/scenarios/receive-flow-control.md`](scenarios/receive-flow-control.md) - Detailed receive-side flow control
- [`arch/scenarios/ack-generation-processing.md`](scenarios/ack-generation-processing.md) - ACK generation and processing
- [`arch/scenarios/protocol-violation.md`](scenarios/protocol-violation.md) - Protocol violation handling
- [`arch/writer-serialization.md`](writer-serialization.md) - Writer serialization architecture
- [`arch/flow-control-budget-model.md`](flow-control-budget-model.md) - Detailed budget model (planning document)
