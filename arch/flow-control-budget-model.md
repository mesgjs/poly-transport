# Flow Control and Budget Model

**Date**: 2026-01-14
**Status**: Planning Document - Revised

## Question

How do flow control and budgets work in PolyTransport, especially the interaction between transport and channel budgets?

## Key Insight

**Channels proxy transport budget management for channel-based traffic.** Users interact with channels, not transports directly. The channel internally coordinates with the transport for budget tracking.

## Overview

PolyTransport uses a **two-level budget system** to prevent buffer overflow and ensure fair resource allocation:

1. **Transport-level budget** - Shared across all channels on a transport
2. **Channel-level budget** - Per-channel limits for each direction

Both levels use budget-based flow control with sequence tracking and range-based acknowledgments.

## Key Architectural Principles

### 1. ChannelFlowControl Is For Channels

**Current Implementation**: [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js)

- **`ChannelFlowControl`** - Manages bidirectional flow control for a single channel
  - **Outbound (send)**: Tracks in-flight chunks (sent but not yet ACK'd)
  - **Outbound (send)**: Calculates available sending budget (remote max - in-flight)
  - **Outbound (send)**: Processes incoming ACKs to restore budget
  - **Outbound (send)**: Provides async waiting for budget availability
  - **Inbound (receive)**: Tracks received chunks (received but not yet consumed)
  - **Inbound (receive)**: Calculates buffer usage and available space
  - **Inbound (receive)**: Generates ACK information for sending to remote
  - **Inbound (receive)**: Validates sequence order and budget

**Usage**: Each bidirectional channel contains an instance of ChannelFlowControl.

### 2. Transport Budget Management

**Current Status**: Not yet implemented (ChannelFlowControl is channel-level only)

**Planned Implementation**: Transport class will manage its own budget using a similar flow control class.

## Budget Hierarchy

```
Transport Budget (shared across all channels)
├── Channel 0 Budget (TCC - Transport Control Channel)
├── Channel 1 Budget (C2C - Console Content Channel, if enabled)
├── Channel N Budget (user channels)
└── ACK Messages (transport-level, NOT channel-level)
```

### Critical Budget Rules

1. **ACK messages are transport-level**
   - ACKs require transport budget but NOT channel budget
   - ACKs must be sent before data to prevent budget hemorrhage
   - If data is ready but no ACKs, reserve `RESERVE_ACK_BYTES` (514 bytes) extra transport budget

2. **Channel messages count toward channel budget**
   - Channel control messages (header type 1) count toward channel budget
   - Channel data messages (header type 2) count toward channel budget
   - Budget includes ALL message headers (not just data payload)

3. **Channel limits cannot exceed transport limits**
   - Each channel's `maxBufferBytes` ≤ transport's `maxBufferBytes`
   - Writes must fit within BOTH transport and channel budgets

## Flow Control Interaction Model

### Sending Data (Channel Proxies Transport)

```javascript
// User code (simple interface)
await channel.write(data, { eom: true });

// Inside channel.write() implementation:
async write(data, options) {
  const headerBytes = 18;  // Channel header size
  const dataBytes = data.length;
  const totalBytes = headerBytes + dataBytes;
  
  // Step 1: Check channel budget
  await this.#sendFlow.waitForBudget(totalBytes);
  
  // Step 2: Check transport budget (channel proxies this)
  await this.#transport._waitForSendBudget(totalBytes);
  
  // Step 3: Record at both levels
  const seq = this.#sendFlow.recordSent(totalBytes);
  this.#transport._recordSent(totalBytes);
  
  // Step 4: Encode and send
  // ... encode header and data into ring buffer ...
  // ... send to remote ...
}
```

**Key Point**: User calls `channel.write()`, channel handles transport coordination internally.

### Receiving Data (Transport Validates, Channel Delivers)

```javascript
// Inside transport._handleIncomingMessage() implementation:
_handleIncomingMessage(message) {
  const { channelId, seq, headerBytes, dataBytes } = message;
  const totalBytes = headerBytes + dataBytes;
  
  // Step 1: Validate transport budget (transport layer)
  try {
    this.#receiveBudget.recordReceived(totalBytes);
  } catch (err) {
    if (err instanceof ProtocolViolationError) {
      // Transport-level budget violation - close transport
      this.emit('protocolViolation', { level: 'transport', ...err.details });
      this.close({ discard: true });
      return;
    }
    throw err;
  }
  
  // Step 2: Find channel and validate channel budget
  const channel = this.#channels.get(channelId);
  if (!channel) {
    // Unknown channel - protocol violation
    this.emit('protocolViolation', { reason: 'UnknownChannel', channelId });
    return;
  }
  
  try {
    channel._recordReceived(seq, totalBytes);  // May throw ProtocolViolationError
  } catch (err) {
    if (err instanceof ProtocolViolationError) {
      // Channel-level budget violation - close channel
      channel.emit('protocolViolation', err.details);
      channel.close({ discard: true });
      return;
    }
    throw err;
  }
  
  // Step 3: Deliver to channel for application processing
  channel._deliverChunk(message);
}

// Inside channel._deliverChunk() implementation:
_deliverChunk(message) {
  // Queue chunk for application read
  this.#receiveQueue.push(message);
  
  // Wake up any waiting readers
  this.#processWaitingReaders();
}

// When application reads and processes chunk:
async read(options) {
  const chunk = await this.#getNextChunk(options);
  
  // Application processes chunk...
  // When done, chunk is automatically marked consumed
  
  // Mark consumed at channel level
  this.#receiveFlow.recordConsumed(chunk.seq);
  
  // Mark consumed at transport level (channel proxies this)
  this.#transport._recordConsumed(chunk.totalBytes);
  
  // Check if ACK should be sent (low-water mark)
  if (this.#receiveFlow.bufferUsed <= this.#lowBufferBytes) {
    this.#generateAndSendAck();
  }
  
  return chunk;
}

// Inside channel._generateAndSendAck() implementation:
async _generateAndSendAck() {
  const ackInfo = this.#receiveFlow.getAckInfo();
  if (!ackInfo) return;
  
  const ackBytes = calculateAckSize(ackInfo);
  
  // ACK uses transport budget, NOT channel budget
  await this.#transport._waitForSendBudget(ackBytes);
  this.#transport._recordSent(ackBytes);
  
  // Send ACK
  await this.#transport._sendAck(this.#channelId, ackInfo);
  
  // Clear ACK'd chunks from tracking
  this.#receiveFlow.clearAcked(ackInfo.baseSeq, ackInfo.ranges);
  
  // Transport clears its tracking when ACK is actually sent
}
```

**Key Points**:
- Transport validates incoming data against transport budget
- Channel validates against channel budget
- Application calls `channel.read()`, which handles consumption tracking
- Channel proxies transport budget operations (user never touches transport directly)

## Transport Budget Implementation Strategy

Transport budget is simpler than channel budget (no sequences, no ACK generation):

```javascript
class TransportFlowControl {
  #localMaxBytes;
  #receivedBytes = 0;  // Bytes received but not yet consumed
  
  #remoteMaxBytes;
  #inFlightBytes = 0;
  #waiters = [];  // FIFO queue for channels
  
  constructor(localMaxBytes, remoteMaxBytes) {
    this.#localMaxBytes = localMaxBytes;
    this.#remoteMaxBytes = remoteMaxBytes;
  }
  
  get available() {
    return this.#remoteMaxBytes === 0 ? Infinity :
           Math.max(0, this.#remoteMaxBytes - this.#inFlightBytes);
  }
  
  async waitForBudget(bytes) {
    if (this.available >= bytes) return;
    return new Promise(resolve => this.#waiters.push({ bytes, resolve }));
  }
  
  recordSent(bytes) {
    this.#inFlightBytes += bytes;
  }
  
  recordAcked(bytes) {
    this.#inFlightBytes -= bytes;
    this.#processWaiters();
  }
  
  #processWaiters() {
    // FIFO processing (same as ChannelFlowControl)
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (this.available >= waiter.bytes) {
        this.#waiters.shift();
        waiter.resolve();
      } else {
        break;
      }
    }
  }
  
  get available() {
    return this.#localMaxBytes === 0 ? Infinity :
           Math.max(0, this.#localMaxBytes - this.#receivedBytes);
  }
  
  get used() {
    return this.#receivedBytes;
  }
  
  recordReceived(bytes) {
    // Validate budget
    const available = this.available;
    if (available !== Infinity && bytes > available) {
      throw new ProtocolViolationError('OverBudget', {
        level: 'transport',
        available,
        requested: bytes,
      });
    }
    
    this.#receivedBytes += bytes;
  }
  
  recordConsumed(bytes) {
    this.#receivedBytes -= bytes;
  }
}
```

**Pros**:
- Simpler, purpose-built for transport level
- Bidirectional (send and receive)
- Detects input buffer overrun (ProtocolViolationError)

**Cons**:
- Some code duplication with ChannelFlowControl

**Rationale**:
- Transport budget is fundamentally simpler (no sequences, no ACK generation)
- Clearer separation of concerns (transport vs channel)
- Easier to understand and maintain
- Minimal code duplication (FIFO waiter processing is the only overlap)

## Implementation Plan

### Phase 1: Transport Budget Classes

1. Create `TransportSendBudget` class (similar to Option 3 above)
2. Create `TransportReceiveBudget` class (similar structure)
3. Add to Transport base class:
   ```javascript
   #transportSendBudget;
   #transportReceiveBudget;
   ```

### Phase 2: Integrate with Channel Flow Control

1. **Add protected methods to Transport base class**:
   ```javascript
   // Protected methods for channels to use
   async _waitForSendBudget(bytes)  // Channel calls this
   _recordSent(bytes)                // Channel calls this
   _recordConsumed(bytes)            // Channel calls this
   async _sendAck(channelId, ackInfo) // Channel calls this
   ```

2. **Update channel write path**:
   - Check channel budget first (prevents channel deadlock)
   - Check transport budget second via `transport._waitForSendBudget()` (FIFO round-robin)
   - Record sent at both levels

3. **Update transport receive path**:
   - Validate transport budget first (in `_handleIncomingMessage()`)
   - Validate channel budget second (delegate to channel)
   - Channel delivers to application

4. **Update channel read path**:
   - Application calls `channel.read()`
   - Channel marks consumed at both levels (channel + transport)
   - Channel generates ACKs when buffer drops below low-water mark

5. **Update ACK generation**:
   - ACKs use transport budget only (via `transport._waitForSendBudget()`)
   - Reserve `RESERVE_ACK_BYTES` (514) when data ready but no ACKs

### Phase 3: Testing

1. Unit tests for TransportSendBudget/TransportReceiveBudget
2. Integration tests for two-level budget interaction
3. Stress tests for budget exhaustion scenarios
4. Tests for ACK priority (ACKs before data)

## Key Design Decisions

### 1. FIFO Round-Robin for Transport Budget

**Problem**: Multiple channels competing for shared transport budget

**Solution**: FIFO queue at transport level ensures fair allocation
- Channels wait in order for transport budget
- Prevents starvation of large writes by small writes
- Can use `TaskQueue` from `@task-queue` for this

### 2. ACK Priority

**Problem**: ACKs are critical for budget restoration, but data can block them

**Solution**: Send ACKs before data
- Check for ready ACKs first
- Reserve extra transport budget (`RESERVE_ACK_BYTES`) if data ready but no ACKs
- Prevents "budget hemorrhage" during channel closure

### 3. Two-Level Validation Order

**Problem**: Which budget to check first?

**Solution**: 
- **Sending**: Channel first, then transport (prevents channel deadlock)
- **Receiving**: Transport first, then channel (transport is outer layer)

### 4. Budget Includes Headers

**Problem**: Should budget count just data or data + headers?

**Solution**: Budget includes ALL message bytes (header + data)
- More accurate resource tracking
- Prevents header overhead from bypassing limits
- Consistent with "over-the-wire" byte counting

## Open Questions

1. **Should transport budget track per-channel usage?**
   - Useful for debugging and fairness monitoring
   - Adds complexity and memory overhead
   - **Recommendation**: Add as optional statistics, not core tracking

2. **How to handle transport budget exhaustion?**
   - Block all channels until ACKs arrive?
   - Emit event for monitoring?
   - **Recommendation**: Block + emit event for visibility

3. **Should transport budget be configurable per-channel?**
   - Allows priority channels (e.g., TCC, C2C)
   - Adds significant complexity
   - **Recommendation**: Not for initial implementation (all channels equal)

4. **Who calls transport budget methods?**
   - **Answer**: Channels call protected transport methods (`_waitForSendBudget()`, `_recordSent()`, `_recordConsumed()`)
   - Users never touch transport directly (especially in JSMAWS applet scenario)
   - Channel provides simple interface, handles transport coordination internally

## Related Scenarios

- [`arch/scenarios/transport-budget.md`](../arch/scenarios/transport-budget.md) - Transport budget management (to be written)
- [`arch/scenarios/send-flow-control.md`](../arch/scenarios/send-flow-control.md) - Sending with two-level budget (to be written)
- [`arch/scenarios/receive-flow-control.md`](../arch/scenarios/receive-flow-control.md) - Receiving with two-level validation (to be written)
- [`arch/scenarios/channel-closure.md`](../arch/scenarios/channel-closure.md) - ACKs during closure (written)

## References

- [`arch/requirements.md`](../arch/requirements.md) - Lines 599-601, 610-612, 643-648, 1111-1127
- [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js) - Current channel-level implementation
- [`src/transport/base.esm.js`](../src/transport/base.esm.js) - Transport base class
- [`arch/sanity-check-20260103.md`](../arch/sanity-check-20260103.md) - Lines 145-148 (ACK budget requirements)
