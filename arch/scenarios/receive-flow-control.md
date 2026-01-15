# Receive Flow Control Scenario

## Overview

This scenario documents how PolyTransport manages receive-side flow control for a channel. The receive flow control system tracks incoming chunks, validates sequence numbers and budget constraints, monitors buffer usage, and determines when to generate ACKs to restore the sender's budget.

**Key Responsibilities**:
- **ChannelFlowControl**: Tracks received chunks, validates sequences/budget, monitors buffer usage
- **Channel**: Processes incoming chunks, marks consumption, triggers ACK generation
- **Transport**: Delivers ACK messages to remote sender

## Preconditions

- Transport is started and connected
- Channel is open (bidirectional)
- ChannelFlowControl instance exists for the channel
- Local maximum buffer size configured (`localMaxBufferBytes`)
- Low-water mark configured (typically 50% of `localMaxBufferBytes`)

## Actors

1. **Transport** - Receives incoming chunks from remote, dispatches to channels
2. **Channel** - Processes incoming chunks, manages read buffer, marks consumption
3. **ChannelFlowControl** - Validates sequences/budget, tracks buffer usage, generates ACK info
4. **Protocol** - Decodes message headers
5. **VirtualBuffer** - Provides zero-copy views of chunk data

## Step-by-Step Sequence

### Phase 1: Receiving a Chunk

**Step 1: Transport receives data from remote**
- **Actor**: Transport
- **Action**: Reads data from underlying transport (WebSocket, pipe, etc.)
- **Data**: Raw bytes containing message header + data

**Step 2: Protocol decodes message header**
- **Actor**: Protocol
- **Action**: Calls [`Protocol.decodeHeader(vb)`](../../src/protocol.esm.js)
- **Returns**: Header object with:
  - `type`: 2 (channel data message)
  - `channelId`: Target channel ID
  - `seq`: Sequence number
  - `messageType`: Message type ID
  - `eom`: End-of-message flag
  - `dataLength`: Bytes of data following header
- **Note**: Header size includes both header bytes and data bytes (for budget tracking)

**Step 3: Transport routes to channel**
- **Actor**: Transport
- **Action**: Looks up channel by `channelId`
- **Error**: If channel not found, emit `protocolViolation` event (unknown channel)
- **Success**: Calls [`channel._handleIncomingChunk(header, dataVB)`](../../src/channel.esm.js)

**Step 4: Channel validates and records chunk**
- **Actor**: Channel
- **Action**: Calls [`flowControl.recordReceived(seq, chunkBytes)`](../../src/channel-flow-control.esm.js)
- **Parameters**:
  - `seq`: Sequence number from header
  - `chunkBytes`: Total bytes (header size + data size)
- **Validation**: ChannelFlowControl validates:
  - **Sequence order**: `seq === nextExpectedSeq` (must be consecutive)
  - **Budget**: `chunkBytes <= bufferAvailable` (must not exceed available buffer)
- **Error**: Emits `protocolViolation` event if validation fails:
  - `reason: 'Sequence out of order'` - Sequence not consecutive
  - `reason: 'Over budget'` - Chunk exceeds available buffer
- **Success**: Records chunk in received map, increments `nextExpectedSeq`, updates `bufferUsed`

**Step 5: Channel stores chunk in read buffer**
- **Actor**: Channel
- **Action**: Adds chunk to internal read buffer (queue or map)
- **Data Structure**: Chunk object:
  ```javascript
  {
    seq: number,           // Sequence number
    type: number,          // Message type ID
    eom: boolean,          // End-of-message flag
    data: VirtualBuffer,   // Zero-copy view of data
    chunkBytes: number,    // Total bytes (header + data)
    consumed: boolean      // Consumption tracking
  }
  ```
- **Note**: Data is VirtualBuffer (zero-copy view), not copied

**Step 6: Channel wakes waiting reader**
- **Actor**: Channel
- **Filtering**: Match message type if reader specified `only` parameter
- **Action**: If a reader is waiting (via `read()`), resolve promise
- **Note**: See [`simple-read.md`](simple-read.md) and [`streaming-read.md`](streaming-read.md) for details

### Phase 2: Consuming a Chunk

**Step 7: User reads chunk**
- **Actor**: User code
- **Action**: Calls [`channel.read({ only, timeout })`](../../src/channel.esm.js) or [`channel.readSync({ only })`](../../src/channel.esm.js)
- **Returns**: Chunk object with `process()` and `done()` methods
- **Note**: See [`simple-read.md`](simple-read.md) for details

**Step 8: User processes chunk data**
- **Actor**: User code
- **Action**: Reads data from `chunk.data` (VirtualBuffer)
- **Zero-copy**: Data is not copied, user accesses original buffer
- **Options**:
  - **Streaming**: Process immediately, call `chunk.done()` or `chunk.process(callback)`
  - **Buffering**: Store chunk, assemble complete message, call `done()` later

**Step 9: User marks chunk as consumed**
- **Actor**: User code
- **Action**: Calls `chunk.done()` or `chunk.process(callback)` (which calls `done()` automatically)
- **Effect**: Channel marks chunk as consumed

**Step 10: Channel records consumption**
- **Actor**: Channel
- **Action**: Calls [`flowControl.recordConsumed(seq)`](../../src/channel-flow-control.esm.js)
- **Effect**: ChannelFlowControl:
  - Removes chunk from received map
  - Decrements `bufferUsed` by chunk bytes
  - Increments `bufferAvailable` by chunk bytes
- **Note**: Chunk data still exists in VirtualBuffer until user releases reference

### Phase 3: ACK Generation Trigger

**Step 11: Channel checks low-water mark**
- **Actor**: Channel
- **Action**: After each `recordConsumed()`, checks if ACK should be generated
- **Condition**: `bufferUsed < lowBufferBytes` (typically 50% of `localMaxBufferBytes`)
- **Decision**:
  - **Below low-water mark**: Generate ACK to restore sender's budget
  - **Above low-water mark**: No ACK needed yet (sender still has budget)

**Step 12: Channel requests ACK info**
- **Actor**: Channel
- **Action**: Calls [`flowControl.getAckInfo()`](../../src/channel-flow-control.esm.js)
- **Returns**: ACK info object or `null`:
  ```javascript
  {
    baseSeq: number,       // Base sequence number
    ranges: Array<{        // Include/skip ranges (if any)
      include: number,     // Consecutive additional chunks to include
      skip: number         // Consecutive chunks to skip
    }>
  }
  ```
- **Note**: Returns `null` if no chunks to acknowledge (all already ACK'd)

**Step 13: Channel sends ACK to transport**
- **Actor**: Channel
- **Action**: Calls [`transport._sendAck(channelId, ackInfo)`](../../src/transport/base.esm.js)
- **Note**: See [`ack-generation-processing.md`](ack-generation-processing.md) for ACK encoding and sending

**Step 14: ChannelFlowControl clears ACK'd chunks**
- **Actor**: ChannelFlowControl
- **Action**: Calls [`clearAcked(baseSeq, ranges)`](../../src/channel-flow-control.esm.js)
- **Effect**: Removes ACK'd chunks from tracking (prevents duplicate ACKs)
- **Returns**: Bytes freed (for statistics)

## Postconditions

- Chunk received, validated, and stored in read buffer
- User processed chunk data (zero-copy access)
- Chunk marked as consumed, buffer space freed
- ACK generated and sent to remote (if low-water mark reached)
- Sender's budget restored (remote side processes ACK)

## Error Conditions

### 1. Out-of-Order Sequence

**Condition**: Received sequence number is not consecutive (`seq !== nextExpectedSeq`)

**Handling**:
- ChannelFlowControl throws `ProtocolViolationError` with `reason: 'Sequence out of order'`
- Channel catches error, emits `protocolViolation` event on transport
- Transport handler decides action (typically close transport)

**Example**:
```javascript
// Expected seq 5, received seq 7 (missing seq 6)
throw new ProtocolViolationError('Sequence out of order', {
  expected: 5,
  received: 7,
  channelId: 42
});
```

### 2. Over-Budget Chunk

**Condition**: Chunk size exceeds available buffer (`chunkBytes > bufferAvailable`)

**Handling**:
- ChannelFlowControl throws `ProtocolViolationError` with `reason: 'Over budget'`
- Channel catches error, emits `protocolViolation` event on transport
- Transport handler decides action (typically close transport)

**Example**:
```javascript
// Available buffer 1000 bytes, received chunk 1500 bytes
throw new ProtocolViolationError('Over budget', {
  available: 1000,
  received: 1500,
  channelId: 42
});
```

### 3. Unknown Channel

**Condition**: Transport receives chunk for channel ID that doesn't exist

**Handling**:
- Transport emits `protocolViolation` event with `reason: 'Unknown channel'`
- Handler decides action (typically close transport)

**Example**:
```javascript
transport.dispatchEvent('protocolViolation', {
  reason: 'Unknown channel',
  channelId: 99,
  seq: 1
});
```

### 4. Duplicate Consumption

**Condition**: User calls `chunk.done()` multiple times on same chunk

**Handling**:
- Channel detects `consumed: true` flag, silently ignores duplicate call
- No error thrown (local action, no need to escalate)

**Example**:
```javascript
chunk.done();
chunk.done(); // Silently ignored (no-op)
```

## Related Scenarios

- **[`send-flow-control.md`](send-flow-control.md)** - Sender's perspective (budget tracking, in-flight chunks)
- **[`ack-generation-processing.md`](ack-generation-processing.md)** - ACK generation and processing details
- **[`simple-read.md`](simple-read.md)** - Single-chunk read flow
- **[`streaming-read.md`](streaming-read.md)** - Multi-chunk read flow
- **[`protocol-violation.md`](protocol-violation.md)** - Protocol violation handling
- **[`channel-budget.md`](channel-budget.md)** - Channel-level budget management

## Implementation Notes

### 1. Sequence Validation

**Critical**: Sequences MUST be consecutive. Out-of-order chunks are protocol violations, not reordering scenarios.

**Rationale**:
- PolyTransport assumes reliable, ordered transport (TCP, WebSocket, etc.)
- No reordering or retransmission logic needed
- Simplifies implementation and reduces overhead

**Implementation**:
```javascript
recordReceived (seq, chunkBytes) {
  if (seq !== this.#nextExpectedSeq) {
    throw new ProtocolViolationError('Sequence out of order', {
      expected: this.#nextExpectedSeq,
      received: seq
    });
  }
  // ... rest of logic
}
```

### 2. Budget Validation

**Critical**: Chunks MUST NOT exceed available buffer. Over-budget chunks are protocol violations.

**Rationale**:
- Sender should respect receiver's budget (from ACKs)
- Over-budget indicates sender bug or malicious behavior
- Prevents buffer overflow and memory exhaustion

**Implementation**:
```javascript
recordReceived (seq, chunkBytes) {
  if (chunkBytes > this.bufferAvailable) {
    throw new ProtocolViolationError('Over budget', {
      available: this.bufferAvailable,
      received: chunkBytes
    });
  }
  // ... rest of logic
}
```

### 3. Low-Water Mark Trigger

**Critical**: ACKs generated when buffer usage drops BELOW low-water mark (not AT low-water mark).

**Rationale**:
- Prevents ACK thrashing (generating ACK for every chunk)
- Batches acknowledgments for efficiency
- Sender has sufficient budget to continue sending

**Implementation**:
```javascript
recordConsumed (seq) {
  // ... remove chunk, update bufferUsed
  
  // Check if ACK should be generated
  if (this.bufferUsed < this.#lowBufferBytes) {
    // Generate ACK
    const ackInfo = this.getAckInfo();
    if (ackInfo) {
      this.#channel._sendAck(ackInfo);
    }
  }
}
```

### 4. Zero-Copy Data Access

**Critical**: Chunk data is VirtualBuffer (zero-copy view), not copied.

**Rationale**:
- Minimizes memory allocations and copies
- Improves performance for large messages
- User can access data directly from transport buffers

**Implementation**:
```javascript
// Channel stores VirtualBuffer directly
// Note: consumed flag is internal tracking only (not user-visible/manipulatable)
const chunk = {
  seq,
  type: messageType,
  eom,
  data: dataVB,  // VirtualBuffer (zero-copy)
  chunkBytes
  // consumed tracked internally by channel (not exposed to user)
};
```

### 5. Consumption Tracking

**Critical**: Chunks marked as consumed MUST be tracked to prevent double-consumption.

**Rationale**:
- Prevents incorrect buffer usage calculations
- Prevents duplicate ACKs
- Ensures correct flow control

**Implementation**:
```javascript
// done() and process() are bound functions or closures (not traditional methods)
// consumed flag is scoped internally (not user-visible/manipulatable)
function createChunk (seq, type, eom, data, chunkBytes, channel) {
  let consumed = false; // Scoped variable (not exposed)
  
  const done = () => {
    if (consumed) return; // Silently ignore duplicate calls
    consumed = true;
    channel._recordConsumed(seq);
  };
  
  const process = async (callback) => {
    try {
      await callback();
    } finally {
      done();
    }
  };
  
  return { seq, type, eom, data, chunkBytes, done, process };
}
```

### 6. Protocol Violation Handling

**Critical**: Protocol violations emit events on transport (not throw exceptions).

**Rationale**:
- Allows transport handler to decide action (close, log, ignore)
- Prevents uncaught exceptions from crashing application
- Provides flexibility for different deployment scenarios

**Implementation**:
```javascript
try {
  flowControl.recordReceived(seq, chunkBytes);
} catch (err) {
  if (err instanceof ProtocolViolationError) {
    this.#transport.dispatchEvent('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: this.id
    });
    return; // Don't process chunk
  }
  throw err; // Re-throw other errors
}
```

### 7. Buffer Usage Calculation

**Critical**: Buffer usage includes ALL received chunks (not just unconsumed chunks).

**Rationale**:
- Received chunks occupy buffer space until consumed
- Sender's budget based on receiver's available buffer
- Prevents buffer overflow

**Implementation**:
```javascript
get bufferUsed () {
  return this.#localMaxBufferBytes - this.bufferAvailable;
}

get bufferAvailable () {
  let used = 0;
  for (const chunk of this.#receivedChunks.values()) {
    used += chunk.chunkBytes;
  }
  return this.#localMaxBufferBytes - used;
}
```

### 8. ACK Generation Timing

**Critical**: ACKs generated AFTER consumption (not after reception).

**Rationale**:
- ACKs indicate buffer space is available for new chunks
- Premature ACKs would allow sender to overflow buffer
- Consumption frees buffer space

**Implementation**:
```javascript
recordConsumed (seq) {
  // Remove chunk, update bufferUsed
  this.#receivedChunks.delete(seq);
  
  // Check if ACK should be generated (AFTER consumption)
  if (this.bufferUsed < this.#lowBufferBytes) {
    // Generate ACK
  }
}
```

## API Reference

### ChannelFlowControl (Receive Methods)

```javascript
class ChannelFlowControl {
  // Properties
  get localMaxBufferBytes()    // Maximum buffer size
  get bufferUsed()              // Bytes received but not consumed
  get bufferAvailable()         // Available buffer space
  get nextExpectedSeq()         // Next expected sequence number
  
  // Methods
  recordReceived(seq, chunkBytes)  // Track received chunk
                                   // Throws ProtocolViolationError if:
                                   //   - seq !== nextExpectedSeq (out-of-order)
                                   //   - chunkBytes > bufferAvailable (over-budget)
  
  recordConsumed(seq)              // Mark chunk as consumed
                                   // Removes from received map
                                   // Updates bufferUsed/bufferAvailable
  
  getAckInfo()                     // Returns { baseSeq, ranges } or null
                                   // Generates ACK information
  
  clearAcked(baseSeq, ranges)      // Clear ACK'd chunks
                                   // Returns bytes freed
}
```

### Channel (Receive Methods)

```javascript
class Channel {
  // Read methods
  async read({ only, timeout })    // Async read (waits for chunk)
  readSync({ only })               // Sync read (returns null if no chunk)
  
  // Internal methods
  _handleIncomingChunk(header, dataVB)  // Process incoming chunk
  _recordConsumed(seq)                  // Mark chunk as consumed
  _sendAck(ackInfo)                     // Send ACK to transport
}
```

### Chunk Object

```javascript
{
  seq: number,           // Sequence number
  type: number,          // Message type ID
  eom: boolean,          // End-of-message flag
  data: VirtualBuffer,   // Zero-copy view of data
  chunkBytes: number,    // Total bytes (header + data)
  
  // Methods (bound functions or closures)
  done()                 // Mark as consumed (idempotent - silently ignores duplicates)
  async process(callback)  // Process and mark as consumed (calls done() in finally)
}
```

## Statistics

ChannelFlowControl provides receive statistics via `getStats()`:

```javascript
{
  receive: {
    localMaxBufferBytes: number,   // Maximum buffer size
    bufferUsed: number,             // Bytes received but not consumed
    bufferAvailable: number,        // Available buffer space
    nextExpectedSeq: number,        // Next expected sequence
    receivedChunks: number,         // Count of received chunks
    consumedChunks: number,         // Count of consumed chunks
    totalBytesReceived: number,     // Total bytes received
    totalBytesConsumed: number      // Total bytes consumed
  }
}
```
