# Transport Input Processing Architecture

**Status**: [DRAFT]
**Date**: 2026-01-19, Updated 2026-01-20, 2026-01-21
**Related**: [`transport-input-overview.md`](transport-input-overview.md), [`message-decoding.md`](scenarios/message-decoding.md), [`simple-read.md`](scenarios/simple-read.md), [`virtual-buffer.esm.js`](../src/virtual-buffer.esm.js)

## Overview

This document describes the high-level architecture for processing incoming data in PolyTransport. The transport acts as a **lexical analyzer**, splitting the byte stream into tokens (headers + data), which are then passed to channels for processing.

**See Also**: [`transport-input-overview.md`](transport-input-overview.md) provides a concise algorithmic overview of both handshake processing and byte-stream message processing.

## The Core Problem

**Everything flows through the transport's byte stream**:
- Byte-stream transports read potentially large chunks (e.g., 64KB) from a socket or pipe
- Buffer contains MIXED data:
  - ACK headers (13-514 bytes)
  - Channel control headers (18 bytes) + optional data
  - Channel data headers (18 bytes) + data (could be megabytes)
- Read boundaries are arbitrary (not aligned to message boundaries)
- Multiple channels share the same byte stream

**Key Challenge**: How to efficiently decode protocol messages and deliver data to channels without excessive copying or complexity?

## Architectural Decision

### Transport as Lexical Analyzer

**Chosen Approach**: Transport decodes headers and copies data to pool buffers.

**Rationale**:
1. **Simplicity**: No pinning/migration complexity
2. **Clean Separation**: Transport handles protocol, channels handle application logic
3. **No Shared State**: Channels receive independent buffers
4. **Acceptable Overhead**: Single copy per message is acceptable (syscall overhead typically exceeds copy overhead)
5. **Consistent**: This is consistent with worker transports (which pass header objects and message-specific data buffers via `postMessage`)

### Alternative Approaches (Rejected)

#### Zero-Copy with Reference Counting

**Approach**: Pass VirtualBuffer views directly to channels, use reference counting to manage buffer lifetime.

**Problems**:
- BYOB not universally supported
- Slow channels hold large buffers (e.g., 64KB total read, 63K processed, 1KB still referenced waiting to be processed)
- Shared state between transport and channels
- Out-of-order consumption complicates buffer release

**Verdict**: Complexity not worth the benefit.

#### Zero-Or-One-Copy with Pinning/Migration

**Approach**: VirtualBuffer initially references the original read buffer(s) like the reference-counting approach, but with transparent migration to pool buffers when the original space needs to be reclaimed.

**Problems**:
- BYOB not universally supported
- Complex migration logic (transparent VirtualBuffer updates)
- Migration failure handling (fatal errors; unlikely, but not impossible)
- Epoch tracking across wrap-around
- Out-of-order release tracking

**Verdict**: Too complex for the benefit (original BYOB input ring design, rejected in Update 2026-01-07-B).

## Architecture Components

### 1. VirtualRWBuffer for Input Accumulation

**Purpose**: Accumulate incoming data for incremental protocol decoding at transport level.

**Implementation**: Uses existing [`VirtualRWBuffer`](../src/virtual-buffer.esm.js) class (no modifications needed).

**Key Operations**:
- [`append(buffer)`](../src/virtual-buffer.esm.js:410-416) - Accept buffers from byte stream (pool or reader-allocated)
- [`getUint8(offset)`](../src/virtual-buffer.esm.js:306-342), [`getUint16(offset)`](../src/virtual-buffer.esm.js:349-358), [`getUint32(offset)`](../src/virtual-buffer.esm.js:365-376) - DataView interface for header decoding
- [`slice(start, end)`](../src/virtual-buffer.esm.js:184-233) - Zero-copy views for data extraction
- [`toPool(pool)`](../src/virtual-buffer.esm.js:240-259) - Copy message data to pool buffers
- [`release(count, pool)`](../src/virtual-buffer.esm.js:537-565) - Release consumed bytes, return buffers to pool

**Async Coordination**: Transport manages waiting for sufficient data (coordinates raw-read task with stream-reader task).

**Scope**: Transport-level only (not used by channels).

### 2. Transport Receive Loop

**Purpose**: Read from byte stream, decode protocol, route to channels.

**Responsibilities**:
- Read large chunks from socket/pipe (minimize syscalls)
- Decode protocol headers (type, size, channel, sequence, etc.)
- Extract data payloads (copy to pool buffers)
- Route ALL messages to appropriate channels (ACKs, control, data)
- Handle transport-level protocol violations

**Key Insights**:
- Transport MUST decode headers to route to channels (no duplicate work)
- **ACKs are routed to channels** (channels manage their own un-ACK'd sequence tracking)
- **Channel-control messages are routed to channels** (channels emit channel-level events)
- Only channels can properly validate ACKs (they own the sequence state)

### 3. Channel Receive Buffer

**Purpose**: Queue chunks for application consumption.

**Responsibilities**:
- Receive pre-parsed header objects + pool buffers from transport
- Queue chunks in FIFO order
- Track flow control (sequence, budget)
- Deliver chunks to application via `channel.read()`
- Generate ACKs when appropriate
- Release buffers after ACK sent

**Key Insight**: Channels receive clean, independent buffers (no shared state with transport).

## Processing Phases

### Phase 1: Handshake Processing

**Purpose**: Establish transport configuration and switch to byte-stream mode.

**Algorithm**: See [`transport-input-overview.md`](transport-input-overview.md#handshake-processing) for detailed handshake algorithm.

**Key Features**:
- **Line-based processing**: Uses STX/ETX markers to distinguish transport content from out-of-band data
- **Configuration exchange**: `\x02PolyTransport:{JSON}\x03\n` format
- **Byte stream marker**: `\x02\x01\x03\n` signals switch to byte-stream mode
- **Out-of-band data**: Non-transport content (console logs, exceptions) emitted as `outOfBandData` events

**Implementation Notes**:
- VirtualRWBuffer accumulates incoming bytes during handshake
- Transport decodes lines and processes configuration
- Handler (`#onRemoteConfig()`) validates config, determines role, initializes foundational channels
- After handler completes, transport sends byte stream marker
- When remote byte stream marker received, switch to byte-stream message processing

### Phase 2: Byte-Stream Message Processing

**Purpose**: Decode protocol messages and route to channels.

**Algorithm**: See [`transport-input-overview.md`](transport-input-overview.md#byte-stream-message-processing) for concise algorithm.

**Key Features**:
- **Header decoding**: Transport decodes all message headers
- **Data extraction**: Copy data to pool buffers (single copy per message)
- **Channel routing**: Pass header objects + pool buffers to channels
- **ACK routing**: ACKs routed to channels (channels manage sequence tracking)

## Data Flow

### High-Level Flow

```
Handshake Phase:
  Byte Stream → Transport → VirtualRWBuffer → Line Decoder → Config Handler → Byte Stream Mode

Byte-Stream Phase:
  Byte Stream → Transport → VirtualRWBuffer → Protocol Decoder → Channels → Application
```

### Detailed Flow (Byte-Stream Phase)

```
1. Socket/Pipe → Transport.receive(64KB)
2. Transport → inputBuffer.append(buffer)
3. Transport → wait for inputBuffer.length >= 2
4. Transport → inputBuffer.getUint8(0) → header type
5. Transport → inputBuffer.getUint8(1) → remaining size
6. Transport → wait for inputBuffer.length >= totalHeaderSize
7. Transport → decode header using DataView interface → { type, channelId, sequence, ... }
8. Transport → inputBuffer.release(totalHeaderSize, pool) → release header bytes
9. IF type === 0 (ACK):
   - Channel.receiveAck(header) → process ACK (no data, ranges encoded in header)
   - Channel validates ACK (sequence tracking)
   - IF valid: Channel restores channel budget, signals transport to restore transport budget
   - IF invalid: Channel signals transport to emit `protocolViolation` event
10. IF type === 1 (control):
   - IF header.dataSize > 0:
     - Transport → wait for inputBuffer.length >= header.dataSize
     - inputBuffer.slice(0, header.dataSize).toPool(pool) → copy data to pool buffers
     - inputBuffer.release(header.dataSize, pool) → release data bytes
   - Channel.receiveControl({ header, segments }) → process control
   - Channel emits channel-level events (e.g., `newMessageType`)
11. IF type === 2 (data):
   - Transport → wait for inputBuffer.length >= header.dataSize
   - inputBuffer.slice(0, header.dataSize).toPool(pool) → copy data to pool buffers
   - inputBuffer.release(header.dataSize, pool) → release data bytes
   - Channel.receiveData({ header, segments }) → queue chunk
12. Application → channel.read() → get chunk
13. Application → chunk.done() → mark consumed
14. Channel → generate ACK (if buffer usage < low-water mark)
15. Channel → Pool.release(segments) → return data buffers to pool
```

## Key Design Decisions

### Decision 1: Copy Data to Pool Buffers

**Rationale**:
- **Simplicity**: No pinning/migration complexity
- **Clean Separation**: Channels get independent buffers
- **Acceptable Overhead**: Single copy per message
- **Predictable Memory**: No large buffers held by slow channels

**Tradeoff**: One copy per message vs zero-copy complexity.

**Verdict**: Simplicity wins.

### Decision 2: Transport Decodes Headers

**Rationale**:
- Transport MUST decode headers to route to channels
- No duplicate work (channel doesn't re-decode)
- Clean API: Channels receive header objects, not raw bytes

**Benefit**: Efficient, no duplicate work.

### Decision 3: VirtualRWBuffer for Input Accumulation

**Rationale**:
- Transport needs incremental decoding (arbitrary read boundaries)
- VirtualRWBuffer already provides all needed operations (append, DataView interface, toPool, release)
- No new implementation needed (reuse existing, well-tested code)
- Transport manages async waiting (coordinates raw-read with stream-reader)
- Channels receive complete messages (no incremental decoding needed)

**Benefit**: Reuse existing code, clear separation of concerns, no additional complexity.

### Decision 4: Large Reads Minimize Syscalls

**Rationale**:
- Syscall overhead typically exceeds copy overhead
- Large reads (64KB) minimize syscalls
- Single copy per message is acceptable

**Benefit**: Efficient I/O, acceptable overhead.

## Transport Responsibilities

### 1. Read from Byte Stream and Accumulate

```javascript
// Transport manages async coordination
async #ensureBytes(count) {
  while (this.#inputBuffer.length < count) {
    const buffer = await this.#socket.read(64 * 1024);  // Large reads minimize syscalls
    this.#inputBuffer.append(buffer);
  }
}
```

### 2. Decode Protocol Headers

```javascript
// Wait for header type and size
await this.#ensureBytes(2);
const type = this.#inputBuffer.getUint8(0);
const remainingSize = this.#inputBuffer.getUint8(1);
const totalHeaderSize = encAddlToTotal(remainingSize);

// Wait for full header
await this.#ensureBytes(totalHeaderSize);

// Decode header using DataView interface
const header = {
  type,
  flags: this.#inputBuffer.getUint16(2),
  channelId: this.#inputBuffer.getUint32(4),
  // ... decode remaining fields based on type ...
};

// Release header bytes immediately (header converted to object)
this.#inputBuffer.release(totalHeaderSize, this.#pool);
```

### 3. Extract and Copy Data (if present)

```javascript
// Only control and data messages have data bodies
// ACK messages encode ranges in header (no data body)
if ((header.type === 1 || header.type === 2) && header.dataSize > 0) {
  await this.#ensureBytes(header.dataSize);
  
  // Copy data to pool buffers
  const dataSegments = this.#inputBuffer.slice(0, header.dataSize).toPool(this.#pool);
  
  // Release data bytes
  this.#inputBuffer.release(header.dataSize, this.#pool);
} else {
  const dataSegments = [];
}
```

### 4. Route to Channels

```javascript
// Pass header object + pool buffer segments to channel
const channel = this.#channels.get(header.channelId);

if (header.type === 0) {
  // ACK message (no data, ranges encoded in header)
  channel.#receiveAck(header);
} else if (header.type === 1) {
  // Control message
  channel.#receiveControl({ header, segments: dataSegments });
} else if (header.type === 2) {
  // Data message
  channel.#receiveData({
    seq: header.sequence,
    type: header.messageTypeId,
    eom: (header.flags & 1) !== 0,
    data: new VirtualBuffer(dataSegments),
    segments: dataSegments  // For release after ACK
  });
}
```

## Channel Responsibilities

### 1. Receive Pre-Parsed Chunks

```javascript
#receiveChunk({ seq, type, eom, data, buffer }) {
  // Validate sequence and budget
  this.#flowControl.recordReceived(seq, data.length);
  
  // Store chunk
  this.#receiveBuffer.push({ seq, type, eom, data, buffer });
  
  // Check for waiting readers
  this.#checkWaitingReaders();
}
```

### 2. Deliver to Application

```javascript
async read({ timeout, only } = {}) {
  // ... find matching chunk ...
  
  const chunk = this.#receiveBuffer.shift();
  
  return {
    seq: chunk.seq,
    type: chunk.type,
    eom: chunk.eom,
    data: chunk.data,  // VirtualBuffer (pool buffer)
    done: () => {
      // Mark consumed, generate ACK, release buffer
      this.#markConsumed(chunk);
    }
  };
}
```

### 3. Generate ACKs and Release Buffers

```javascript
#markConsumed(chunk) {
  // Mark consumed
  this.#flowControl.recordConsumed(chunk.seq);
  
  // Check if should generate ACK
  if (this.#flowControl.bufferUsed < this.lowBufferBytes) {
    const ackInfo = this.#flowControl.getAckInfo();
    if (ackInfo) {
      // Send ACK
      this.#transport.sendAck(ackInfo);
      
      // Clear ACK'd chunks
      this.#flowControl.clearAcked(ackInfo.baseSeq, ackInfo.ranges);
      
      // Release buffer to pool
      this.#pool.release(chunk.buffer);
    }
  }
}
```

## Performance Considerations

### Syscall vs Copy Overhead

**Syscall Overhead**:
- Typically 1-10 microseconds per syscall
- Large reads (64KB) minimize syscalls
- Example: 1MB data = 16 syscalls (64KB each) = 16-160 microseconds

**Copy Overhead**:
- Typically 0.1-1 microseconds per KB
- Example: 1MB data = 1000 KB = 100-1000 microseconds

**Verdict**: Syscall overhead comparable to copy overhead. Large reads + single copy is acceptable.

### Memory Efficiency

**Pool Buffers**:
- Reused efficiently (zeroed on release)
- Bounded memory usage (water marks)
- Predictable allocation patterns

**No Large Buffer Holding**:
- Slow channels don't hold large buffers
- Each channel gets appropriately-sized buffer
- No migration complexity

**Verdict**: Efficient, predictable memory usage.

### Throughput

**Large Reads**:
- Minimize syscalls (major bottleneck)
- Efficient use of kernel buffers
- Reduced context switching

**Single Copy**:
- Acceptable overhead (see above)
- Simpler than zero-copy complexity
- No shared state or locking

**Verdict**: High throughput, acceptable overhead.

## Security Considerations

### Buffer Isolation

**Channels receive independent buffers**:
- No shared state with transport
- No risk of data leakage between channels
- Clean separation of concerns

**Benefit**: Strong isolation, no cross-channel contamination.

### Buffer Zeroing

**Pool buffers zeroed on release**:
- Prevents data leakage between uses
- Handled by BufferPool automatically
- No application-level concerns

**Benefit**: Secure by default.

### Protocol Validation

**Transport validates protocol**:
- Sequence order (consecutive)
- Budget enforcement (no overflow)
- Header integrity (valid types, sizes)

**Benefit**: Early detection of malicious/buggy implementations.

## Testing Strategy

### Unit Tests

1. **Transport Receive Loop**:
   - Large reads (64KB chunks)
   - Mixed messages (ACK, control, data)
   - Header decoding (all types)
   - Data extraction (copy to pool)
   - Channel routing (correct delivery)

3. **Channel Receive Buffer**:
   - Chunk queueing (FIFO order)
   - Flow control (sequence, budget)
   - ACK generation (low-water mark)
   - Buffer release (after ACK)

### Integration Tests

1. **End-to-End Flow**:
   - Socket → Transport → Channel → Application
   - Multiple channels (interleaved data)
   - Large messages (multi-chunk)
   - ACK round-trip (budget restoration)

2. **Performance Tests**:
   - Syscall overhead (large vs small reads)
   - Copy overhead (various message sizes)
   - Throughput (messages per second)
   - Memory usage (pool buffer churn)

## Related Documents

- [`transport-input-overview.md`](transport-input-overview.md) - Concise algorithmic overview (handshake + byte-stream)
- [`virtual-buffer.esm.js`](../src/virtual-buffer.esm.js) - VirtualBuffer and VirtualRWBuffer implementation
- [`message-decoding.md`](scenarios/message-decoding.md) - Protocol decoding scenarios
- [`simple-read.md`](scenarios/simple-read.md) - Channel read flow
- [`buffer-pool-lifecycle.md`](scenarios/buffer-pool-lifecycle.md) - Buffer pool management
- [`virtual-buffer-operations.md`](scenarios/virtual-buffer-operations.md) - VirtualBuffer operations
- [`handshake.md`](scenarios/handshake.md) - Detailed handshake scenario
- [`requirements.md`](requirements.md) - Overall requirements (Update 2026-01-07-B)

## Summary

**Key Insight**: Transport acts as lexical analyzer, splitting byte stream into tokens (headers + data), which are passed to channels for processing.

**Design Principles**:
1. **Simplicity over zero-copy**: One copy per message is acceptable
2. **Clean separation**: Transport decodes, channels process
3. **No shared state**: Channels get independent buffers
4. **Large reads**: Minimize syscalls (major bottleneck)
5. **Efficient memory**: Pool buffers, predictable usage

**Benefit**: Simple, efficient, secure architecture with acceptable overhead.
