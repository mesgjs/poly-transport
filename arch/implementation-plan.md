# PolyTransport Implementation Plan

**Status**: Active
**Created**: 2026-01-03
**Last Updated**: 2026-01-07

## Overview

This document outlines the implementation plan for PolyTransport with the correct bidirectional channel architecture. Each channel is a container that may have one or both directions active, with independent flow control per direction.

## Core Architecture Principles

### Channel Directionality Model

From [`arch/requirements.md`](requirements.md):
> "Each channel may be unidirectional (user data travels only in one direction) or bidirectional (user data travels in both directions)" (line 15)

**How directionality is determined** (lines 306-308):
- **Unidirectional**: One transport requests, the other accepts
  - Appears "write-only" on request side (cannot receive data)
  - Appears "read-only" on accept side (cannot send data)
- **Bidirectional**: Both transports request AND both accept
  - Both sides can send and receive data

**Key Insight**: A `Channel` object is a bidirectional container that may have:
- Read direction only (unidirectional inbound)
- Write direction only (unidirectional outbound)
- Both read and write directions (bidirectional)

Each direction has:
- Independent flow control state
- Independent buffer management
- Independent lifecycle (can close one direction while keeping the other open)

## Implementation Phases

### Phase 1: Foundation Components

#### 1.1 VirtualBuffer Class
**File**: [`src/virtual-buffer.esm.js`](../src/virtual-buffer.esm.js)

**Purpose**: Zero-copy buffer management with views into underlying storage (lines 153-158)

**Key Features**:
- Wraps Uint8Array or ring buffer segments
- Supports slicing without copying
- Pin/unpin mechanism for ring buffer integration (lines 165-193)
- Efficient concatenation and splitting
- Automatic migration when underlying storage moves (line 163)

**API**:
```javascript
class VirtualBuffer {
  constructor(source, offset = 0, length = source.length)
  get length()
  get byteLength()
  slice(start, end)
  toUint8Array()  // May copy if needed
  pin()           // Prevent ring buffer reclamation
  unpin()         // Allow ring buffer reclamation
  concat(other)   // Create new VirtualBuffer spanning both
  decode({ start=0, end=length, label='utf-8', fatal=false, ignoreBOM=false })  // Text decoding
}
```

**Text Decoding** (requirements.md:623-627):
- Combines slice-like range selection with text decoding
- **Single-segment optimization**: Zero-copy decode directly from buffer
- **Multi-segment optimization**: Uses streaming `TextDecoder` to process segments without intermediate copy
- Streaming decoder handles multi-byte UTF-8 sequences split across segments
- 4-5x faster than copy-first approach for multi-segment buffers

#### 1.1b VirtualRWBuffer Class
**File**: [`src/virtual-rw-buffer.esm.js`](../src/virtual-rw-buffer.esm.js)

**Purpose**: Read/write subclass of VirtualBuffer for zero-copy writing to ring buffers (requirements.md:618-619)

**Key Features**:
- Extends VirtualBuffer with write operations
- Supports writing directly to ring buffer (potentially split around wrap-around)
- Provides `set`, `fill`, and text encoding methods
- Used for output ring buffer reservations

**API**:
```javascript
class VirtualRWBuffer extends VirtualBuffer {
  // Write bytes from source
  set(source, offset = 0)  // source: Uint8Array or VirtualBuffer
  
  // Fill with repeated byte value
  fill(value, start = 0, end = this.length)
  
  // Encode string directly into buffer
  // Returns { read, written } like TextEncoder.encodeInto()
  encodeFrom(str, offset = 0, label = 'utf-8')
  
  // Shrink buffer to actual used size (for over-allocated reservations)
  shrink(newLength)
}
```

**String Encoding** (requirements.md:621-622):
- Uses `TextEncoder.encodeInto()` for efficient encoding
- Returns `{ read, written }` to track UTF-16 code units consumed and bytes written
- Enables multi-chunk encoding of large strings
- Over-allocates reservation (worst-case: min(remaining_string.length * 3, maxChunkBytes))
- Shrinks reservation to actual encoded size after encoding
- Avoids intermediate buffer allocation

**Multi-Chunk String Encoding Example**:
```javascript
let offset = 0;
while (offset < str.length) {
  // Reserve space for this chunk (worst-case for remaining string)
  const remaining = str.length - offset;
  const maxBytes = Math.min(remaining * 3, maxChunkBytes);
  const reservation = await ringBuffer.reserve(maxBytes);
  
  // Encode as much as fits
  const { read, written } = reservation.encodeFrom(str, offset);
  
  // Release unused space
  reservation.shrink(written);
  
  // Send chunk
  await sendChunk(reservation, { eom: offset + read >= str.length });
  
  // Advance offset by UTF-16 code units consumed
  offset += read;
}
```

#### 1.2 BufferPool Class
**File**: [`src/buffer-pool.esm.js`](../src/buffer-pool.esm.js)

**Purpose**: Reusable buffer allocation to reduce GC pressure (lines 519-528)

**Key Features**:
- Multiple size classes: 1KB, 4KB, 16KB, 64KB (line 521)
- Additional 1K for overhead (headers, ACKs) (line 522)
- Allocate below low-water mark (line 523)
- "Eased" release above high-water mark (line 524)
- Worker support with separate water marks (lines 525-528)
- **Buffers zeroed on release, not allocation** (requirements.md:845-850)
  - Better timing: buffer ready when needed
  - Less time pressure when releasing
  - Potentially detect premature-release issues earlier

**API**:
```javascript
class BufferPool {
  constructor(sizeClasses = [1024, 4096, 16384, 65536])
  allocate(minSize)  // Returns Uint8Array (already zeroed from previous release)
  release(buffer)    // Zero buffer and return to pool
  clear()            // Empty all pools
  
  // Worker support
  requestFromMain()  // Request additional buffers
  sendToMain(buffer) // Return excess buffers
}
```

#### 1.3 OutputRingBuffer Class
**File**: [`src/output-ring-buffer.esm.js`](../src/output-ring-buffer.esm.js)

**Purpose**: Circular buffer for streaming output with zero-copy writing (requirements.md:853-905, 904-979)

**Key Features**:
- Output-only ring buffer (no input ring, no pinning, no migration)
- Reserve → commit → getBuffers → consume lifecycle
- Zero-after-write security (prevents data leakage)
- Count-based full/empty distinction (no wasted byte)
- Single pending reservation at a time (prevents overlap issues)
- Integration with VirtualRWBuffer for zero-copy writing
- Default 256K size (configurable)

**API**:
```javascript
class OutputRingBuffer {
  constructor(size = 256 * 1024, options = {})
  
  // Properties
  get available()                 // Bytes committed but not yet consumed
  get space()                     // Bytes available to reserve
  get size()                      // Total ring buffer size
  get epoch()                     // Wrap-around counter
  
  // Lifecycle methods
  reserve(length)                 // Returns VirtualRWBuffer or null if insufficient space
  commit(reservation)             // Mark reservation as ready to send
  getBuffers(length)              // Get Uint8Array[] for writing (1 or 2 if wrapped)
  consume(length)                 // Consume sent data and zero the space
  shrinkReservation(reservation, newLength)  // Shrink pending reservation
  
  // Statistics
  getStats()                      // Get ring buffer statistics
}

class RingBufferReservationError extends Error {
  // Custom error for reservation-specific errors
}
```

**Key Design Decisions** (requirements.md:904-979):

1. **Count-Based Full/Empty Distinction**:
   - Uses separate `#count` field to track committed bytes
   - Eliminates ambiguity between full and empty states
   - Allows full capacity utilization (no wasted byte)
   - `available = count`, `space = size - count - reserved`

2. **Reserved Bytes Tracking**:
   - Separate `#reserved` field tracks reserved-but-not-committed bytes
   - Prevents over-reservation
   - Enables accurate space calculation

3. **Single Pending Reservation**:
   - Only one reservation allowed at a time
   - Prevents overlap issues when shrinking reservations
   - Simplifies implementation and reasoning
   - Throws `RingBufferReservationError` if reservation already pending

4. **Synchronous Reserve**:
   - `reserve()` is synchronous, returns `null` if insufficient space
   - Transport layer handles waiting and retry logic
   - Simpler than async reservation with waiting

5. **VirtualRWBuffer Integration**:
   - Reservations return `VirtualRWBuffer` for zero-copy writing
   - Supports DataView methods (setUint8/16/32) for protocol headers
   - Supports string encoding via `encodeFrom()`
   - `shrink()` calls `ring.shrinkReservation()` to update tracking

6. **getBuffers() for Actual Writing**:
   - Returns array of 1 or 2 `Uint8Array` views
   - Single array if data doesn't wrap
   - Two arrays if data wraps around ring boundary
   - Provides actual buffer access for transport layer writing

7. **Zero-After-Write Security**:
   - `consume()` zeros consumed space before advancing readHead
   - Prevents leaking bytes from previous iterations
   - Aligns with BufferPool zero-on-release strategy (requirements.md:845-850)

### Phase 2: Protocol Layer

#### 2.1 Protocol Class
**File**: [`src/protocol.esm.js`](../src/protocol.esm.js)

**Purpose**: Message encoding/decoding with binary format (lines 415-517)

**Buffer Type Requirements** (requirements.md:1050-1088):
- All protocol functions require VirtualBuffer or DataView with DataView-compatible API
- No Uint8Array support (removed for simplicity and consistency)
- Encoding functions require target with `setUint8/16/32()` methods
- Decoding functions require buffer with `getUint8/16/32()` methods
- All functions validate buffer has required API and throw `TypeError` if not

**Transport Handshake** (lines 395-404):
1. Transport-identifier: `\x02PolyTransport\x03` (15B)
2. Transport-configuration: `\x02{"...}\x03` (JSON, variable length)
3. Switch to binary stream: `\x01` (1B)

**Transport Configuration** (lines 406-413):
- `c2cEnabled`: Enable console-content channel
- `c2cMaxBuffer`: Optional C2C buffer size limit
- `c2cMaxCount`: Optional C2C message count limit
- `minChannelId`: Minimum auto-assigned channel id (default 256)
- `minMessageTypeId`: Minimum auto-assigned message-type id (default 1024)
- `version`: Protocol version (default 1)

**Message Types** (lines 415-421):
- 0: ACK message
- 1: Channel control message
- 2: Channel data message

**Constants** (requirements.md:633-638):
- `DATA_HEADER_BYTES` = 18 (current bytestream data format)
- `MIN_DATA_RES_BYTES` = 4 (minimum data reservation)
- `RESERVE_ACK_BYTES` = 514 (maximum ACK message size)
- Requirement: `maxChunkBytes >= DATA_HEADER_BYTES + MIN_DATA_RES_BYTES`
- `maxDataBytes = maxChunkBytes - DATA_HEADER_BYTES`

**ACK Message Format** (lines 430-456):
```
1B: 0 (ACK type)
1B: remaining message size
2B: flags
4B: transport local channel number
4B: base remote sequence number
1B: range count (0-255)
  Alternating (up to range-count):
  1B: Include quantity (0-255)
  1B: Skip quantity (0-255)
```

**Channel Control/Data Header Format** (lines 458-480):
```
1B: 1 (control) or 2 (data)
1B: remaining header size
4B: total data size (bytes)
2B: flags (+1: EOM)
4B: remote transport channel number
4B: local channel sequence number
2B: remote message type
Total: 18 bytes (DATA_HEADER_BYTES)
Followed by data segment if data-segment size > 0
```

**Note**: `maxChunkBytes` is the "over-the-wire" size limit (header + data payload). All data chunking must be based on `maxDataBytes = maxChunkBytes - DATA_HEADER_BYTES` (requirements.md:636-640).

**API**:
```javascript
// Encoding functions (write directly into VirtualRWBuffer/DataView)
export function encodeAckHeaderInto(target, offset, fields)
export function encodeChannelHeaderInto(target, offset, type, fields)
export function encodeHandshakeInto(target, offset, config)

// Decoding functions (read from VirtualBuffer/DataView)
export function decodeHeaderSizeFromPrefix(buffer, offset = 0)
export function decodeHeader(buffer, offset = 0)
export function decodeHandshake(buffer, offset = 0)
export function decodeHandshake(buffer)  // offset = 0

// Test wrappers (allocate Uint8Array for convenience)
export function encodeAckHeader(fields)  // Returns Uint8Array
export function encodeChannelHeader(type, fields)  // Returns Uint8Array
```

**Transport-Control Channel (TCC)** (lines 482-493):
- Permanent channel 0 (opens/closes with transport)
- Message types:
  - 0: Transport state-changes
  - 1: New-channel requests
  - 2: New-channel responses (accept/reject with local channel id)

**Console-Content Channel (C2C)** (lines 495-505):
- Permanent channel 1 (if `c2cEnabled: true` in handshake)
- Message types:
  - 0: Uncaught-exception messages
  - 1: `debug`-level messages
  - 2: `info/log`-level messages
  - 3: `warn`-level messages
  - 4: `error`-level messages

**Channel Control Messages (CCM)** (lines 507-517):
- Message types:
  - 0: Channel-message-type registration request
  - 1: Channel-message-type registration response

**TCC Additional Message Types** (requirements.md:668):
- `chanNoReq`: Reply to late/unsolicited `chanReqAcc` indicating no active request
  - Triggers implied directional channel auto-close on accepting transport

### Phase 3: Flow Control

#### 3.1 ChannelFlowControl Class
**File**: [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js)

**Purpose**: Per-direction budget-based flow control (lines 21-24, 249-252)

**Key Features**:
- Bi-level budget system (transport + channel) (line 599)
- Chunk sequence tracking (line 261)
- In-flight chunk map
- Budget calculation
- Acknowledgment processing with range support (lines 444-456)

**ACK Handling** (requirements.md:642-647):
- ACKs are transport-level messages, not channel-level
- ACKs require transport-level budget, but NOT channel-level budget
- Ready ACKs should be batched using range + skip encoding
- Ready ACKs MUST be sent before ready data
- If data is ready but no ACKs ready, transport reservation should require `RESERVE_ACK_BYTES` more than data alone
- Prevents data from blocking potentially-critical ACKs

**Budget System** (lines 21-24):
- Chunks may not be sent until sufficient budget available
- Budget consumed when chunks sent
- Budget restored upon receipt of ACKs
- ACKs indicate chunks completely processed by recipient

**API**:
```javascript
class ChannelFlowControl {
  constructor(localMaxBufferBytes, remoteMaxBufferBytes)
  
  // Sending side
  canSend(dataSize)                    // Returns boolean
  async waitForBudget(dataSize)        // Waits until budget available
  recordSent(seq, dataSize)            // Track in-flight chunk
  processAck(baseSeq, ranges)          // Update budget from ACK
  
  // Receiving side
  recordReceived(seq, dataSize)        // Track buffer usage
  recordConsumed(seq, dataSize)        // Track buffer freed
  getAckInfo()                         // Returns { baseSeq, ranges }
  
  // State
  get sendingBudget()                  // Available budget for sending
  get bufferUsed()                     // Current buffer usage
  get bufferAvailable()                // Available buffer space
}
```

**Chunk Tracking**:
- Each chunk has sequence number (per channel and direction) (line 477)
- Sender maintains map: sequence → chunk size
- Receiver acknowledges chunks with range-based ACKs (lines 444-456)
- Sender calculates budget: remote budget - in-flight data

**Type-Based Filtering** (lines 589-591):
- Filtered reads must not impact other filtered reads
- Chunks may be read/released/ACK'd out of sequence
- Typed messages are "light-weight channels" within channels

**Transport-Level Budget Waiting** (requirements.md:609-614):
- Use `TaskQueue` for FIFO round-robin queueing of ready channels
- Ensures fair transport-level budget allocation
- Import: `import { TaskQueue } from '@task-queue';`
- See [`resources/task-queue/src/task-queue.esm.js`](../resources/task-queue/src/task-queue.esm.js) for interface details
- First ensure channel has sending budget (prevents deadlock)
- Second ensure transport has sending budget in FIFO order

### Phase 4: Channel Implementation

#### 4.1 Channel Class
**File**: [`src/channel.esm.js`](../src/channel.esm.js)

**Purpose**: Bidirectional container with direction management

**Key Architecture**:
```javascript
class Channel extends EventTarget {
  constructor(transport, channelId, name, options) {
    this.#transport = transport;
    this.#channelId = channelId;
    this.#name = name;
    
    // Direction state
    this.#readDirection = null;   // ChannelDirection or null
    this.#writeDirection = null;  // ChannelDirection or null
  }
}

class ChannelDirection {
  constructor(channel, direction, flowControl, ringBuffer) {
    this.#channel = channel;
    this.#direction = direction;  // 'read' or 'write'
    this.#flowControl = flowControl;
    this.#ringBuffer = ringBuffer;
    this.#state = 'closed';  // State machine per direction
  }
}
```

**Direction State Machine** (lines 268-281):
- Local reader: `closed` → `open` → `closing` → {`localClosing`, `remoteClosing`} → `closed`
- Local reader: `closed` → `rejected` (permanent final state)
- Local writer: `closed` → `requested` → `open` → `closing` → {`localClosing`, `remoteClosing`} → `closed`
- Local writer: `closed` → `requested` → `rejected` (permanent final state)
- `localClosing`: Remote signaled done but local still closing
- `remoteClosing`: Local done but remote not yet signaled done
- Closed channels may repeat request/accept cycle unless rejected

**API**:
```javascript
class Channel extends EventTarget {
  // Properties
  get id()
  get name()
  get hasReadDirection()
  get hasWriteDirection()
  get isBidirectional()
  
  // Writing (requires write direction)
  async write(type, data, { eom = true })  // line 372
  // data can be: Uint8Array, VirtualBuffer, or string (auto-encoded)
  
  // Reading (requires read direction)
  async read({ timeout, only })            // line 380 (was readChunk)
  readSync({ only })                       // line 382 (was readChunkSync)
  
  // Pin management helpers (requirements.md:660-662)
  readSyncAndRelease(callback)             // Calls callback(chunk), then releases pin
  async readAndRelease(callback)           // Awaits callback(chunk), then releases pin
  
  // Flow control
  async clear({ chunk, direction, only })  // line 344
  
  // Lifecycle
  async close({ direction, discard = false, timeout })  // line 351
  
  // Message type registration
  async addMessageType(type)               // line 367
  
  // Events (lines 283-321)
  // 'newMessageType' - { type, preventDefault() }
  // 'newChunk' - { chunk, type, eom }
  // 'beforeClosing' - { direction }
  // 'closed' - { direction }
  // 'error' - { error, direction }
}
```

**Direction Parameter** (lines 344-361):
- `undefined`: Operate on both directions (default)
- `'read'`: Operate only on read direction
- `'write'`: Operate only on write direction

**Examples**:
```javascript
// Close write direction only (half-close)
await channel.close({ direction: 'write' });

// Clear read buffer
await channel.clear({ direction: 'read' });

// Write to channel (requires write direction)
await channel.write(0, data, { eom: true });

// Read from channel (requires read direction)
const { type, data, eom } = await channel.read();

// Filtered read (only specific message types)
const chunk = await channel.read({ only: [1, 2, 3] });
```

**Duplicate Reader Detection/Prevention** (requirements.md:677-688):
- Detect and prevent duplicate channel readers
- Create meta object for each reader with `stale` flag (initially false)
- Keep scalar for unfiltered async readers
- Keep map for filtered readers (by message type)
- If unfiltered reader exists and any other read attempted: reject with `DuplicateReaderError`
- For filtered readers:
  - Attempt to register reader for each message type
  - If non-stale reader already registered for type:
    - Mark new reader stale (invalidates all prior registrations)
    - Reject with `DuplicateReaderError`
  - If no reader or existing reader is stale: register new reader
- When reader activated by new chunk: set meta state to stale
- Reader must initiate new read (new meta object) to read another chunk

**String Encoding in channel.write** (requirements.md:621-622):
```javascript
async write(type, data, { eom = true }) {
  if (typeof data === 'string') {
    // Multi-chunk string encoding
    let offset = 0;
    while (offset < data.length) {
      // Reserve space for this chunk (worst-case for remaining string)
      const remaining = data.length - offset;
      const maxBytes = Math.min(remaining * 3, this.#maxChunkBytes);
      const reservation = await this.#reserveSpace(maxBytes);
      
      // Encode as much as fits
      const { read, written } = reservation.encodeFrom(data, offset);
      
      // Release unused space
      reservation.shrink(written);
      
      // Determine if this is the last chunk
      const isLastChunk = (offset + read >= data.length);
      
      // Send chunk
      await this.#sendChunk(type, reservation, { eom: eom && isLastChunk });
      
      // Advance offset by UTF-16 code units consumed
      offset += read;
    }
  } else {
    // Binary data path (Uint8Array or VirtualBuffer)
    // May also need chunking if data exceeds maxChunkBytes
    await this.#sendChunk(type, data, { eom });
  }
}
```

**Important Notes**:
- No `readMessage` or `writeMessage` methods (line 590)
- `write` must automatically chunk writes exceeding chunk limit (line 591)
- `maxMessageBytes` is informational only (line 592)
- Filtered reads don't impact other filtered reads (line 593)
- Individual chunks written atomically, but large writes need not be (lines 596-597)
- String data automatically encoded using `TextEncoder.encodeInto()` with multi-chunk support
- `encodeFrom()` returns `{ read, written }` to track progress through string

### Phase 5: Transport Layer

#### 5.1 Transport Base Class
**File**: [`src/transport/base.esm.js`](../src/transport/base.esm.js)

**Purpose**: Abstract base for all transport types

**Key Features**:
- Channel management (lines 245-267)
- Request/accept flow (lines 291-308, 362-366)
- Event dispatching (lines 283-321)
- Lifecycle management (lines 268-281)
- Bi-level flow control (transport + channel) (line 599)

**API**:
```javascript
class Transport extends EventTarget {
  constructor(options)
  
  // Configuration
  setChannelDefaults(options = {})         // line 337
  
  // Lifecycle
  async start()                            // line 339
  async close({ discard, timeout })        // line 341
  
  // Channel operations
  async requestChannel(idOrName, { timeout })  // line 362
  
  // State
  get isStarted()
  get isClosed()
  get channels()  // Map of active channels
  
  // Events (lines 283-321)
  // 'outofBandData' - { data } (line 288)
  // 'newChannel' - { request, accept(options), reject(reason) } (line 291)
  // 'beforeClosing' (line 311)
  // 'closed' (line 312)
  // 'error' - { error }
  
  // Abstract methods (implemented by subclasses)
  async _start()
  async _close()
  async _sendMessage(channelId, message)
  _handleIncomingMessage(message)
}
```

**Channel Accept Options** (lines 293-299):
- `maxBufferBytes`: Max buffer size (byte count); 0 = unlimited
- `maxChunkBytes`: Max size of single chunk; 0 = none (transport limit applies)
- `maxMessageBytes`: Max size of individual message; 0 = unlimited
- `lowBufferBytes`: Buffer size low-water mark for ACKs

**Event Handling** (lines 283-321):
- `addEventListener`/`removeEventListener` model (line 285)
- Event dispatches must `await` handler execution (line 286)
- Some events support `event.preventDefault()` (line 287)
- Event order when closing (lines 313-317):
  1. Transport `beforeClosing`
  2. Each channel `beforeClosing`
  3. Each channel `closed`
  4. Transport `closed`

#### 5.2 Transport Implementations

**HTTP Transport** - [`src/transport/http.esm.js`](../src/transport/http.esm.js)
- Request/response model (line 30)
- Typically unidirectional channels
- Polling or long-polling for bidirectional

**WebSocket Transport** - [`src/transport/websocket.esm.js`](../src/transport/websocket.esm.js)
- Full-duplex communication (line 31)
- Natural fit for bidirectional channels
- Binary frame support

**Worker Transport** - [`src/transport/worker.esm.js`](../src/transport/worker.esm.js)
- postMessage API (line 34)
- Structured clone for data transfer
- Bidirectional by nature

**Pipe Transport** - [`src/transport/pipe.esm.js`](../src/transport/pipe.esm.js)
- stdin/stdout/stderr (line 35)
- Process communication
- Typically bidirectional (stdin/stdout)

**Nested Transport (PTOC)** - [`src/transport/nested.esm.js`](../src/transport/nested.esm.js)
- PolyTransport over PolyTransport channel (lines 36, 323-330)
- Each PTOC assigned unique message type (line 326)
- Wraps outbound traffic, unwraps inbound traffic (lines 327-328)
- Must be hosted on bidirectional channels (line 330)
- Critical for JSMAWS routing

**Virtual Transport** - [`src/transport/virtual.esm.js`](../src/transport/virtual.esm.js)
- For testing (line 37)
- Direct in-memory communication
- No actual I/O

### Phase 6: Testing Strategy

#### 6.1 Unit Tests

**VirtualBuffer Tests** - [`test/unit/virtual-buffer.test.js`](../test/unit/virtual-buffer.test.js)
- Construction and slicing
- Pin/unpin mechanics
- Concatenation
- Migration when underlying storage moves
- Edge cases

**BufferPool Tests** - [`test/unit/buffer-pool.test.js`](../test/unit/buffer-pool.test.js)
- Allocation and release
- Size class selection
- Pool limits (low/high water marks)
- Memory reuse
- Worker support

**OutputRingBuffer Tests** - [`test/unit/output-ring-buffer.test.js`](../test/unit/output-ring-buffer.test.js)
- Reserve/commit/consume operations
- Wrap-around behavior
- Single pending reservation enforcement
- Security invariant (zero-after-write)
- VirtualRWBuffer integration (DataView methods, string encoding)
- Full buffer scenarios
- Error conditions

**Protocol Tests** - [`test/unit/protocol.test.js`](../test/unit/protocol.test.js)
- Handshake encoding/decoding
- ACK message format with ranges
- Channel control/data message format
- TCC and C2C message types
- CCM message types
- Edge cases and errors

**ChannelFlowControl Tests** - [`test/unit/channel-flow-control.test.js`](../test/unit/channel-flow-control.test.js)
- Budget calculation
- Chunk tracking
- Range-based acknowledgment processing
- Budget updates
- Blocking behavior
- Bi-level (transport + channel) limits
- Out-of-sequence ACKs for typed messages

**Channel Tests** - [`test/unit/channel.test.js`](../test/unit/channel.test.js)
- Unidirectional channels (read-only, write-only)
- Bidirectional channels
- Direction-specific operations
- Half-close scenarios
- State machine transitions
- Flow control integration
- Event dispatching
- Type-based filtering
- Automatic chunking of large writes

**Transport Tests** - [`test/unit/transport/*.test.js`](../test/unit/transport/)
- Base class behavior
- Each transport implementation
- Channel request/accept flow
- Message routing
- Error handling
- Out-of-band data handling

#### 6.2 Integration Tests

**End-to-End Tests** - [`test/integration/e2e.test.js`](../test/integration/e2e.test.js)
- Full communication scenarios
- Multiple channels
- Bidirectional streaming
- Flow control under load
- Error recovery

**JSMAWS Scenarios** - [`test/integration/jsmaws.test.js`](../test/integration/jsmaws.test.js)
- Operator ↔ Router (lines 68-73)
- Router ↔ Responder (lines 76-83)
- Responder ↔ Applet (lines 86-98)
- Nested transport (PTOC)
- Console logging pipeline (C2C)
- WebSocket bidi upgrade (lines 130-141)

## Implementation Order

### Sprint 1: Foundation (Week 1)
1. ✅ Create implementation plan
2. ✅ Implement VirtualBuffer and VirtualRWBuffer (88 tests passing)
3. ✅ Implement BufferPool (24 tests passing)
4. ✅ Implement OutputRingBuffer (24 tests passing)
5. ✅ Implement Protocol layer (60 tests passing)
6. ✅ Implement FlowControl (46 tests passing)
7. ✅ **Total: 242 tests passing**

### Sprint 2: Transport & Channel (Week 2)
1. ✅ Implement Transport base class (21 tests passing)
2. ✅ **Total: 254 tests passing**
3. Implement Channel class
4. Write tests for channel
5. Integration testing of transport + channel + flow control

### Sprint 3: Channel (Week 2)
1. Implement ChannelDirection
2. Implement Channel with bidirectional support
3. Write comprehensive channel tests
4. Test unidirectional vs bidirectional scenarios

### Sprint 4: Transport Base (Week 3)
1. Implement Transport base class
2. Implement channel request/accept flow
3. Write transport base tests
4. Test channel lifecycle

### Sprint 5: Transport Implementations (Week 3-4)
1. Implement Virtual transport (simplest for testing)
2. Implement WebSocket transport
3. Implement Worker transport
4. Implement Pipe transport
5. Implement HTTP transport
6. Implement Nested transport (PTOC)

### Sprint 6: Integration & Polish (Week 4)
1. End-to-end integration tests
2. JSMAWS scenario tests
3. Performance testing
4. Documentation
5. Examples

## Key Design Decisions

### 1. Channel as Bidirectional Container
**Decision**: Channel object contains both directions, not separate objects per direction

**Rationale**:
- Matches requirements specification (lines 15, 306-308)
- Simplifies API (single channel object)
- Allows direction-specific operations via parameter
- Supports half-close scenarios naturally

### 2. Independent Flow Control Per Direction
**Decision**: Each direction has its own FlowControl instance

**Rationale**:
- Read and write have different buffer constraints
- Prevents deadlock scenarios
- Allows asymmetric buffer sizes
- Bi-level control (transport + channel) (line 599)

### 3. Ring Buffer with Pin/Unpin
**Decision**: Use ring buffer with explicit pin/unpin for zero-copy (lines 165-193)

**Rationale**:
- Minimizes memory allocation
- Reduces GC pressure
- Supports high-throughput streaming
- Pin/unpin prevents premature reclamation
- Targeted migration callbacks avoid broadcast overhead

### 4. VirtualBuffer Abstraction
**Decision**: Separate VirtualBuffer class for buffer views (lines 153-158)

**Rationale**:
- Decouples buffer management from storage
- Supports multiple storage types (Uint8Array, ring buffer)
- Enables zero-copy slicing
- Simplifies pin/unpin implementation
- Automatic migration when storage moves (line 163)

### 5. Range-Based ACKs
**Decision**: ACK messages use base sequence + include/skip ranges (lines 444-456)

**Rationale**:
- Supports out-of-sequence ACKs for typed messages (lines 589-591)
- Minimizes ACK message size
- Allows efficient batch acknowledgments
- Prevents DoS via duplicate ACKs (lines 436-439)

### 6. No readMessage/writeMessage
**Decision**: Only chunk-level read/write operations (line 590)

**Rationale**:
- Simplifies implementation
- Automatic chunking in write handles large messages (line 591)
- Applications can assemble messages from chunks if needed
- Reduces memory overhead for large messages

### 7. Bi-Level Flow Control
**Decision**: Flow control at both transport and channel levels (line 599)

**Rationale**:
- Prevents single channel from consuming all transport bandwidth
- Allows per-channel limits within transport limits
- Channel limits may not exceed transport limits

## Critical Implementation Notes

### Channel Request Flow (lines 306-308, 362-366)
1. Transport A calls `requestChannel(idOrName, { timeout })`
2. Transport B receives `newChannel` event
3. Transport B calls `event.accept(options)` or lets request timeout
4. If accepted:
   - Transport A gets write direction
   - Transport B gets read direction
   - Transport B assigns local channel id and sends in accept response
5. If Transport B also calls `requestChannel` for same channel:
   - Both transports get both directions
   - Channel becomes bidirectional

### ACK Processing (lines 430-456)
1. Receiver processes incoming chunks
2. Updates buffer state
3. Sends ACK with:
   - Local channel number
   - Base remote sequence number
   - Range count with include/skip quantities
4. Sender receives ACK
5. Removes acknowledged chunks from in-flight map
6. Recalculates local sending budget
7. Unblocks waiting writes if budget available

### Automatic Chunking (line 591)
- `write` must automatically split large writes into chunks
- Each chunk written atomically with header
- Large writes need not be atomic (lines 596-597)
- Example: Two types A and B writing 128K might interleave chunks

### Type-Based Filtering (lines 589-591)
- Filtered reads don't impact other filtered reads
- Chunks may be read/released/ACK'd out of sequence
- Typed messages are "light-weight channels" within channels
- `only` parameter accepts single value, array, or Set (line 387)

## Updates & Clarifications 2026-01-04-A

### Terminology: "Size" → "Bytes"
For better clarity, parameter names use "bytes" instead of "size" where applicable (requirements.md:635):
- `maxChunkSize` → `maxChunkBytes`
- `maxMessageSize` → `maxMessageBytes`
- `maxBufferSize` → `maxBufferBytes`
- `lowBufferSize` → `lowBufferBytes`

### Timeout Handling (requirements.md:664-674)

**`requestChannel` timeout**:
- Rejects locally with `TimeoutError`
- Late/unsolicited `chanReqAcc` triggers `chanNoReq` TCC reply message
- `chanNoReq` triggers implied directional channel auto-close on accepting transport

**`read` timeout**:
- Rejects with `TimeoutError`
- Unlike `readSync`, `null` implies EOF

**`close` timeout**:
- Force-close if orderly close times out

### Channel Rejection (requirements.md:690-693)
- Channel rejection only directly affects the requested direction
- Rejected requestor must explicitly close any previously established reverse direction if desired

### Channel And Message-Type Exhaustion/Reuse (requirements.md:695-710)
- Channel ids: 32 bits
- Message-type ids: 16 bits
- Configuration parameters readable but not modifiable by user code
- `minChannelId` and `minMessageTypeId` are minimum ids where *mapping* begins, not minimum usable
- **Channel state** (including name-mappings) maintained for life of transport:
  - Named channel closed and re-opened (same direction) gets same channel id
  - Channel ids never reassigned to different name
  - New name mappings never assigned active channel ids
- **Named-message-type mappings** retained for life of channel direction:
  - Mappings restart fresh for direction that closed and reopened
  - Re-requesting existing mapping (within direction not closed) returns existing id
- **Numeric-only message-types** don't require state storage:
  - Not always possible to determine if particular id is "active"
  - Applications needing > 1024 unmapped numeric ids should manage own mapping

### Buffer Pool Management (requirements.md:648)
- Operates on relative-demand basis (not fixed maximums)
- Ring-to-pool migration failures are fatal (close entire transport)
- Total buffer demand application-managed via configuration and avoiding unrestricted channel acceptance
- All buffer sizes configurable unless format-specific (like header sizes)

### Managing Channels And Message Types (requirements.md:654-656)
- Trusted clients should use `newChannel` and `newMessageType` events
- Detect malicious/errant/unexpected use
- Shut down problematic channels or transports accordingly

## Update 2026-01-07-A

### Buffer Zeroing Strategy Change (requirements.md:845-850)

**Change**: Shared buffers should be zeroed when *released* and returned to the pool, not when allocated.

**Rationale**:
- **Better timing**: Buffer is already ready when needed; potentially less time pressure when releasing
- **Earlier issue detection**: Potentially detect premature-release issues earlier
- **Consistency**: Aligns with zero-after-write pattern for output ring buffer

**Impact on Components**:

**BufferPool**:
- `release(buffer)` must zero the buffer before returning it to the pool
- `allocate(minSize)` returns already-zeroed buffer (from previous release)
- New buffers allocated from system already have their contents set to zero (per ArrayBuffer constructor spec)

**RingBuffer (Output)**:
- Zero-after-write: After data is written and sent, zero the ring buffer space
- Ensures next reservation doesn't expose previous data
- Aligns with pool buffer zeroing strategy

**RingBuffer (Input)**:
- No zeroing needed: Data arrives from external source
- Ring buffer filled by incoming data, not reused reservations

**Security Implications**:
- Maintains security invariant: prevents leaking bytes from previous iterations
- Timing change doesn't affect security guarantees
- May facilitate development by detecting premature reuse earlier

## Update 2026-01-07-B

### Simplified Ring Buffer Architecture: Output-Only (requirements.md:852-905)

**Date**: 2026-01-07

**Decision**: Remove BYOB input ring buffer support. Ring buffers will only be used for output (writing).

**Rationale**:
- BYOB input ring adds significant complexity with minimal benefit:
  - Pin management and migration callbacks
  - Migration failure handling
  - Out-of-order release tracking
  - Coalescing adjacent free space
  - Epoch tracking across wrap-around
- For input, transports can use reader-allocated buffers directly (no ring needed)
- Simplifies implementation significantly while maintaining zero-copy output path

**Impact on Implementation**:

**Input Path** (reading from external sources):
- **No input ring buffer**
- Use reader-allocated buffers directly (from BufferPool)
- Parse headers and data directly from these buffers
- Create VirtualBuffer views as needed
- No pinning, no migration, no reclamation complexity

**Output Path** (writing to external destinations):
- **Output ring buffer only** for zero-copy writing
- Reserve space, write data, commit, send, consume (zero after write)
- No pinning needed (output is immediate or queued in pool buffers)
- Simpler lifecycle: reserve → commit → send → consume

**OutputRingBuffer API** (requirements.md:904-979):
```javascript
class OutputRingBuffer {
  constructor(size = 256 * 1024, options = {})
  
  // Properties
  get available()                 // Bytes committed but not yet consumed
  get space()                     // Bytes available to reserve
  get size()                      // Total ring buffer size
  get epoch()                     // Wrap-around counter
  
  // Lifecycle methods
  reserve(length)                 // Returns VirtualRWBuffer or null if insufficient space
  commit(reservation)             // Mark reservation as ready to send
  getBuffers(length)              // Get Uint8Array[] for writing (1 or 2 if wrapped)
  consume(length)                 // Consume sent data and zero the space
  shrinkReservation(reservation, newLength)  // Shrink pending reservation
  
  // Statistics
  getStats()                      // Get ring buffer statistics
}

class RingBufferReservationError extends Error {
  // Custom error for reservation-specific errors
}
```

**VirtualBuffer Changes**:
- `toUint8Array(buffer?)` - Accept optional user-supplied buffer parameter
- If buffer provided, copy into it; otherwise allocate new buffer
- Enables efficient copying into pre-allocated buffers

**Removed Complexity**:
- No pin registry for input ring
- No targeted migration callbacks
- No migration failure handling
- No out-of-order consumption tracking
- No epoch-based overlap detection for pins
- No coalescing of freed space
- No BYOB view management
- No early wrap detection for input

**Retained Features**:
- Output ring buffer with reserve/commit/consume cycle
- Zero-after-write security for output ring
- VirtualBuffer and VirtualRWBuffer for zero-copy views
- BufferPool for managing reusable buffers
- Wrap-around handling for output ring

**Testing Impact**:
- Simpler test suite for OutputRingBuffer (output-only scenarios)
- No need to test pin/unpin mechanics
- No need to test migration callbacks
- No need to test BYOB view management
- Focus on reserve/commit/getBuffers/consume cycle
- Test wrap-around behavior
- Test zero-after-write security
- Test single pending reservation enforcement
- Test VirtualRWBuffer integration (DataView methods, string encoding)

## Success Criteria

1. ✅ All unit tests pass (target: 200+ tests)
2. ✅ All integration tests pass
3. ✅ Supports unidirectional and bidirectional channels
4. ✅ Flow control prevents buffer overflow
5. ✅ Zero-copy buffer management works correctly
6. ✅ All transport types implemented
7. ✅ Nested transport (PTOC) works
8. ✅ JSMAWS scenarios validated
9. ✅ Performance meets requirements
10. ✅ Documentation complete

## References

All references are to [`arch/requirements.md`](requirements.md):
- Lines 15: Channel directionality
- Lines 21-24: Flow control system
- Lines 153-158: VirtualBuffer class
- Lines 165-193: Ring buffer pin/unpin
- Lines 232-236: Security invariant
- Lines 245-267: Channels, chunks, messages
- Lines 268-281: Channel state transitions
- Lines 283-321: Events
- Lines 323-330: PTOCs
- Lines 337-391: Interface specification
- Lines 395-404: Transport handshake
- Lines 406-413: Transport configuration
- Lines 415-421: Message types
- Lines 430-456: ACK message format
- Lines 458-480: Channel message format
- Lines 482-493: Transport-Control Channel (TCC)
- Lines 495-505: Console-Content Channel (C2C)
- Lines 507-517: Channel Control Messages (CCM)
- Lines 519-528: Buffer pools
- Lines 558-577: Ring buffer strategies
- Lines 589-599: Updates & clarifications 2026-01-02-A
- Lines 845-850: Update 2026-01-07-A (buffer zeroing strategy)
