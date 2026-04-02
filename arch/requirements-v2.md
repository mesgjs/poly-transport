# PolyTransport Requirements - Version 2

**Date**: 2026-04-02
**Status**: Current
**Supersedes**: `arch/requirements.md` (archived)

## Document Purpose

This document is the authoritative requirements and architectural specification for PolyTransport. It consolidates all requirements and architectural decisions, incorporating:

- Original requirements from `requirements.md` (archived)
- Bidirectional channel model from `bidi-chan-even-odd-update.md` (archived)
- Flow control architecture from `flow-control-model.md` (archived)
- Writer serialization from `writer-serialization.md` (archived)
- Transport input processing from [`transport-input-overview.md`](transport-input-overview.md) and [`transport-input-processing.md`](transport-input-processing.md)
- Control channel refactoring from [`control-channel-refactoring.md`](control-channel-refactoring.md)
- Buffer management updates from `requirements-update-2026-03-01-impact.md` (archived)
- Channel close architecture from [`channel-close-architecture.md`](channel-close-architecture.md)

**Note**: The source code is the definitive implementation reference. This document describes the intended design; when discrepancies exist, the source code takes precedence and this document should be updated.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Core Concepts](#core-concepts)
3. [Transport Types](#transport-types)
4. [Protocol Specification](#protocol-specification)
5. [Flow Control Architecture](#flow-control-architecture)
6. [Buffer Management](#buffer-management)
7. [Channel Lifecycle](#channel-lifecycle)
8. [Message Types](#message-types)
9. [API Specification](#api-specification)
10. [Implementation Details](#implementation-details)
11. [Security and Validation](#security-and-validation)
12. [JSMAWS Integration](#jsmaws-integration)

---

## Project Overview

### Goal

Provide a versatile, easy-to-use, bidirectional, multi-transport, content-streaming facility with sliding-window flow control for reliable data transfer.

### Initial Application

Communication between various parts of JSMAWS (JavaScript Multi-Applet Web Server), applets, and web clients. Web clients and applets are considered untrusted and potentially malicious.

### Key Requirements

- Support simple HTTP(S) requests with fixed-length responses
- Support streaming connections (media, SSE)
- Support bidirectional connections (WebSockets, with extensibility for future transports)
- Prevent misbehaving or hostile connections from disrupting other users
- Provide backpressure/flow control to prevent buffer overflow
- Enable zero-copy operations where possible
- Support nested transports (PolyTransport-over-channel, "PTOC")

---

## Core Concepts

### Transports

A **transport** is a communication pathway between two endpoints. Each transport:

- Has a unique transport ID (UUID v4)
- Assigns itself a role (ROLE_EVEN or ROLE_ODD) based on lexicographic comparison of transport IDs
- Manages multiple bidirectional channels
- Implements flow control at the transport level
- Starts and stops (not "opens" and "closes" - that terminology is for channels)

**Transport Roles**:
- **ROLE_EVEN**: Transport with lexicographically lower UUID, assigns even IDs (0, 2, 4, ...)
- **ROLE_ODD**: Transport with lexicographically higher UUID, assigns odd IDs (1, 3, 5, ...)

### Channels

A **channel** is a logical bidirectional communication stream over a transport. Each channel:

- Has a unique name (string) and one or two numeric IDs (even and/or odd)
- Supports bidirectional data flow (both sides can send and receive)
- Has independent flow control (send and receive budgets)
- Can be opened and closed independently of the transport
- Supports message-type registration for structured communication

**Channel IDs**:
- Channels may have 0, 1, or 2 IDs (stored in ascending order)
- IDs assigned by accepting transport when request is accepted
- ROLE_EVEN assigns even IDs, ROLE_ODD assigns odd IDs
- Sender uses lowest ID when sending (ID may "settle" after bidirectional requests)

### Messages and Chunks

A **message** is an application-defined unit of content. Each message:

- Has an associated message type (numeric or registered string)
- May be split into one or more chunks
- Last chunk marked with EOM (end-of-message) flag
- Can be filtered by message type when reading

A **chunk** is a protocol-level unit of transmission. Each chunk:

- Has a sequence number (per channel, per direction)
- Has a maximum size (`maxChunkBytes` - header + data)
- Includes a header (18 bytes for channel messages)
- May contain data (0 to `maxDataBytes` bytes)

### Flow Control

PolyTransport uses **two-layer resource coordination** to prevent buffer overflow:

1. **Channel Budget** (Layer 1): Per-channel flow control, prevents overwhelming remote's channel buffer
   - Budget consumed when chunks sent
   - Budget restored when remote sends ACKs (acknowledges consumption)
   - Prevents misbehaving channels from blocking other channels
2. **Ring Buffer Space** (Layer 2, byte-stream only): Local output buffer for zero-copy encoding
   - Space consumed when data reserved
   - Space freed when data sent (immediate)
   - No ACK-based restoration

**Object-Stream Transports**: Only Layer 1 (channel budget), no ring buffer

**Critical Design Decision** (2026-03-01-A): No shared transport budget across channels. This prevents malicious channels from DOS attacking the transport by sending data and never processing it (no ACKs → no budget restoration). Each channel's budget is independent, so a misbehaving channel only affects itself.

**ACK Messages**: Fire-and-forget messages that restore channel budgets but don't consume them (use ring buffer space only).

---

## Transport Types

### Byte-Stream Transports

**Characteristics**:
- Binary protocol with headers and data
- Use output ring buffer for zero-copy encoding
- Ring buffer space is local resource (Layer 2)
- Text encoding required (`needsEncodedText = true`)

**Supported Types**:
1. **HTTP/HTTPS**: Standard web protocols
2. **WebSocket**: Full-duplex over TCP
3. **IPC Pipes**: Process communication via stdin/stdout/stderr
4. **Nested Transport (PTOC)**: PolyTransport-over-channel

### Object-Stream Transports

**Characteristics**:
- JavaScript objects via `postMessage`
- No ring buffer (synchronous send)
- No Layer 2 (only channel budget)
- No text encoding required (`needsEncodedText = false`)

**Supported Types**:
1. **Web Worker**: Browser-based message passing with buffer transfer

### Virtual Transport

**Purpose**: Testing and development

**Characteristics**:
- In-memory transport for unit tests
- Configurable behavior (delays, errors, etc.)

---

## Protocol Specification

### Handshake (Byte-Stream Transports)

**Phase 1: Send Local Configuration**

```
\x02PolyTransport:{JSON}\x03\n
```

- **STX** (`\x02`): Start of text marker
- **Greeting**: `PolyTransport:`
- **Configuration**: JSON object (see below)
- **ETX** (`\x03`): End of text marker
- **Newline** (`\n`): Line terminator

**Configuration JSON**:
```json
{
  "transportId": "uuid-v4-string",
  "c2cEnabled": true,
  "minChannelId": 2,
  "minMessageTypeId": 256,
  "version": 1
}
```

**Phase 2: Configuration Reception**

- Reader loop receives greeting+config line
- Validates STX/ETX markers and newline
- Parses JSON configuration
- Calls `#onRemoteConfig()` handler

**Phase 3: Local Setup (Triggered by Remote Config Reception)**

Handler (`#onRemoteConfig()`) performs:
1. Validate remote configuration
2. Calculate operating values (role, channel IDs, etc.)
3. Determine role (ROLE_EVEN or ROLE_ODD) based on transport ID comparison
4. Initialize `nextChannelId` (even or odd based on role)
5. Create TCC (Transport Control Channel, channel 0)
6. Create C2C (Console Content Channel, channel 1) if enabled
7. Start TCC reader loop
8. Send byte stream marker

**Phase 4: Byte Stream Marker**

```
\x02\x01\x03\n
```

- **STX** (`\x02`): Start of text marker
- **Marker** (`\x01`): Byte stream start marker
- **ETX** (`\x03`): End of text marker
- **Newline** (`\n`): Line terminator

**Phase 5: Byte Stream Marker Reception**

- Reader loop receives marker line
- Validates STX/ETX markers and newline
- Switches to binary message processing

### Binary Message Format (Byte-Stream Transports)

**Message Types** (first byte after byte stream starts):
- **0**: ACK message (transport-level)
- **1**: Channel control message
- **2**: Channel data message

#### ACK Message Format

```
Offset  Size  Field
------  ----  -----
0       1B    Type (0)
1       1B    Remaining size ((additionalBytes - 2) >> 1)
2       2B    Flags (none defined)
4       4B    Channel ID
8       4B    Base remote sequence number
12      1B    Include count (0 or # of include ranges)
13+     var   Ranges (alternating include/skip bytes)
```

**Total Size**: 14 bytes (if includeCount=0) to 514 bytes (maximum allowed, at includeCount=251)

**Range Encoding**:
- Include count of 0 means no ranges (just base sequence)
- Include count N means N include ranges and N-1 skip ranges (2N-1 range bytes)
- Ranges always end with "include" byte (never "skip")
- Example: includeCount=1 → 1 byte (include)
- Example: includeCount=2 → 3 bytes (include, skip, include)
- Example: includeCount=251 → 501 bytes

#### Channel Control/Data Message Format

```
Offset  Size  Field
------  ----  -----
0       1B    Type (1=control, 2=data)
1       1B    Remaining size ((additionalBytes - 2) >> 1)
2       4B    Data size (bytes)
6       2B    Flags (+1: EOM)
8       4B    Channel ID
12      4B    Local sequence number
16      2B    Message type ID
```

**Total Header Size**: 18 bytes
**Followed by**: Data segment (0 to `dataSize` bytes)

### Object Message Format (Object-Stream Transports)

**Handshake** (sent as structured object via `postMessage`):
```javascript
{
  protocol: 'PolyTransport',
  header: { type: 'handshake' },
  data: { transportId, version, c2cEnabled, minChannelId, minMessageTypeId }
}
```

**ACK Message** (sent as structured object):
```javascript
{
  protocol: 'PolyTransport',
  header: {
    type: 0,           // HDR_TYPE_ACK
    channelId: number,
    baseSequence: number,
    ranges: number[]
  }
}
```

**Channel Control/Data Message** (sent as structured object):
```javascript
{
  protocol: 'PolyTransport',
  header: {
    type: 1 | 2,       // HDR_TYPE_CHAN_CONTROL or HDR_TYPE_CHAN_DATA
    channelId: number,
    sequence: number,
    messageType: number,
    flags: number      // EOM, etc.
  },
  data: string | Uint8Array[]  // String (UTF-16) or array of Uint8Array segments
}
```

**Accounting**:
- Header size = byte-stream equivalent (18 bytes for channel messages, 14+ for ACKs)
- String data size = `string.length * 2` (UTF-16 code units)
- Binary data size = actual byte length

---

## Flow Control Architecture

### Two-Layer Resource Coordination

**Critical Design Decision** (2026-03-01-A): PolyTransport uses a **two-layer model** (not three-layer) to prevent DOS attacks. There is **NO shared transport budget** across channels. This prevents malicious channels from blocking other channels by sending data and never processing it (no ACKs → no budget restoration → only that channel blocks, not all channels).

#### Layer 1: Channel Budget (Per-Channel)

**Purpose**: Prevents overwhelming remote's channel buffer

**Managed by**: [`ChannelFlowControl`](../src/channel-flow-control.esm.js)

**Key Concepts**:
- Each channel has independent send and receive budgets
- Write budget = remote's `writeLimit` - bytes written but not yet ACK'd
- Read budget = local `readLimit` - bytes received but not yet processed
- Budget restored when remote sends ACK (acknowledges consumption)
- Sequence numbers track in-flight chunks
- **Independent per channel**: Misbehaving channel only affects itself, not other channels

**Validation**:
- Chunks must arrive in consecutive sequence order (out-of-order is protocol violation)
- Chunks must not exceed available budget (over-budget is protocol violation)

**Why No Shared Transport Budget**:
- Prevents DOS attack: Malicious channel sends data, never processes (no ACKs)
- Without shared budget: Only that channel blocks (exhausts its own budget)
- With shared budget: All channels block (transport budget exhausted)
- **Security**: Channel isolation is critical for untrusted code (JSMAWS applets)

#### Layer 2: Ring Buffer Space (Byte-Stream Only)

**Purpose**: Provides zero-copy encoding space before send

**Managed by**: [`OutputRingBuffer`](../src/output-ring-buffer.esm.js)

**Key Concepts**:
- Fixed-size circular buffer (default 256KB)
- Available space = total size - committed bytes (0 if reservation pending)
- Space freed when data sent (immediate, no ACK required)
- Single pending reservation at a time
- Zero-after-write security
- **Local resource only**: Not affected by remote behavior

**Object-Stream Transports**: No Layer 2 (synchronous send, no ring buffer)

### Writer Serialization

**Problem**: Multi-writer scenarios create race conditions

**Solution**: Chunk-level serialization using TaskQueue

**Architecture** (Byte-Stream, `together: true` default):
```
User calls channel.write()
    ↓
Channel TaskQueue (single task for all chunks)
    ↓
Loop for each chunk:
    ↓
    Wait for channel write budget (flowControl.writable())
        ↓
    Pass chunk to transport (transport.sendChunk())
        ↓
    Record bytes sent (flowControl.sent())
        ↓
    Next chunk
```

**Architecture** (Byte-Stream, `together: false`):
```
User calls channel.write()
    ↓
Loop for each chunk:
    ↓
    Channel TaskQueue (separate task per chunk)
        ↓
    Wait for channel write budget (flowControl.writable())
        ↓
    Pass chunk to transport (transport.sendChunk())
        ↓
    Record bytes sent (flowControl.sent())
        ↓
    Next chunk
```

**Architecture** (Object-Stream, `together: true` default):
```
User calls channel.write()
    ↓
Channel TaskQueue (single task for all chunks)
    ↓
Loop for each chunk:
    ↓
    Wait for channel write budget (flowControl.writable())
        ↓
    Send message (synchronous via postMessage)
        ↓
    Record bytes sent (flowControl.sent())
        ↓
    Next chunk
```

**Architecture** (Object-Stream, `together: false`):
```
User calls channel.write()
    ↓
Loop for each chunk:
    ↓
    Channel TaskQueue (separate task per chunk)
        ↓
    Wait for channel write budget (flowControl.writable())
        ↓
    Send message (synchronous via postMessage)
        ↓
    Record bytes sent (flowControl.sent())
        ↓
    Next chunk
```

**Key Principles**:
1. Serialize at chunk level (not write-operation level) for fairness
2. Dynamic string chunking (cannot pre-plan UTF-8 encoding)
3. Wait for maximum budget needed, consume actual bytes sent
4. FIFO ordering at each level
5. Single waiter model (TaskQueue ensures serialization)
6. Fixed resource acquisition order (channel budget → ring for byte-stream, channel budget only for object-stream)
7. `together: true` (default): All chunks sent in a single channel task — keeps smaller messages together, reducing fragmentation risk
8. `together: false`: Each chunk sent in a separate channel task — allows streaming content to interleave with other channel content

### ACK Messages

**Special Case**: ACKs are transport-level messages that restore channel budget but don't consume it

**ACK Scheduling** (managed by `ChannelFlowControl`):
- `#scheduleAcks()` is called when chunks are marked processed
- ACKs are sent when:
  - Unprocessed read bytes drop below `lowReadBytes` (low-water mark), AND
  - Either: no batching delay (`ackBatchTime = 0`), OR
  - Force threshold reached: `ackableBytes >= forceAckBytes` OR `ackableChunks >= forceAckChunks`
- After sending ACKs, a batching timer (`ackBatchTime` msec) prevents immediate re-ACKing
- Channel write queue checks `#readyToAck` flag before each chunk; if set, sends ACK first

**Sending ACKs** (Transport B):
```
1. Application marks chunk as processed (flowControl.markProcessed(seq))
2. ChannelFlowControl schedules ACK via ackCallback
3. Channel queues ACK send task (or sends immediately if queue empty)
4. Transport encodes ACK header into ring buffer (byte-stream) or sends via postMessage
5. flowControl.clearReadAckInfo() clears processed entries
```

**Processing ACKs** (Transport A):
```
1. Receive ACK message from transport B
2. channel.receiveMessage() → flowControl.clearWriteAckInfo()
3. Write budget restored (written -= ACK'd bytes)
4. Wake waiting writer (if budget now available)
```

**Why ACKs are Special**:
- Fire-and-forget (no ACK-on-ACK)
- Ring buffer only (Layer 2, byte-stream), not Layer 1
- Immediate release (ring space freed right after send)
- Budget restoration (restore Layer 1 only - channel budget)
- No rate limiting (can send as fast as ring buffer allows)
- **No shared transport budget**: ACKs don't restore transport budget (there isn't one)

### Data Message and ACK Reservation

**ACK priority**: Before each data chunk is sent, the channel write loop checks `#readyToAck`. If set, an ACK is sent first (via `#sendAckMessage(true)`), then the data chunk proceeds. This ensures ACKs are not starved by data writes.

**Data message reservation** (byte-stream):
```javascript
// Data message reservation (via ByteTransport.reservable())
await reservable(bytesToReserve);  // bytesToReserve = DATA_HEADER_BYTES + chunkSize
const chunkBuffer = outputBuffer.reserve(bytesToReserve);
```

**ACK message reservation** (byte-stream):
```javascript
// ACK message reservation
await reservable(RESERVE_ACK_BYTES);
const ackBuffer = outputBuffer.reserve(RESERVE_ACK_BYTES);
```

**Constants**:
- `DATA_HEADER_BYTES = 18` (channel message header size)
- `RESERVE_ACK_BYTES = 514` (maximum ACK message size)
- `MIN_DATA_RES_BYTES = 4` (minimum data reservation)

---

## Buffer Management

### Thread-Local Buffer Pools

**Architecture** (Update 2026-03-01-A):
- Each thread allocates and releases its own buffers
- Low and high water-mark conditions handled locally in-thread
- No transfers to/from main thread for water-mark management
- Buffers CAN transfer between threads due to normal messaging (become part of receiving thread's dirty pool)

**Managed by**: [`BufferPool`](../src/buffer-pool.esm.js)

**Standard Size Classes**:
- 1KB (1024 bytes)
- 4KB (4096 bytes)
- 16KB (16384 bytes)
- 64KB (65536 bytes)

**Lifecycle**:
1. Allocate below low-water mark
2. Use for I/O operations
3. Lazy-zero-on-release (via dirty pool) for security
   - Buffers may be scrubbed routinely during pool management or demand-scrubbed
4. Release above high-water mark (eased release)

### Output Ring Buffer

**Purpose**: Zero-copy encoding for byte-stream transports

**Managed by**: [`OutputRingBuffer`](../src/output-ring-buffer.esm.js)

**Lifecycle**:
```
1. reserve(length) → VirtualRWBuffer or null (if insufficient space)
2. Encode header and data into VirtualRWBuffer
3. commit() → Mark as ready to send (advances writeHead)
4. await sendable() → Wait until committed bytes are available
5. getBuffers(length) → Uint8Array[] for writing (1 or 2 if wrapped)
6. release(length) → Zero consumed space and advance readHead
```

**Key Features**:
- Count-based full/empty distinction (no wasted byte)
- Reserved bytes tracking (separate from committed)
- Single pending reservation at a time (throws if reservation already pending)
- Synchronous reserve (returns null if insufficient space)
- `available` property returns 0 while reservation is pending
- Zero-after-write security (release() zeroes the space)
- `sendable()` async method for waiting until committed bytes are available

**API**:
```javascript
class OutputRingBuffer {
  constructor(size = 256 * 1024, options = {})

  // Properties
  get available()    // Free space (0 if reservation pending)
  get committed()    // Bytes committed and ready to send
  get size()         // Total ring buffer size

  // Lifecycle methods
  reserve(length)    // Returns VirtualRWBuffer or null if insufficient space
  commit()           // Mark reservation as ready to send
  async sendable()   // Wait until committed bytes are available
  getBuffers(length) // Get Uint8Array[] for writing (1 or 2 if wrapped)
  release(length)    // Zero and release sent bytes

  // Statistics
  getStats()         // Get ring buffer statistics
  stop()             // Reject any pending sendable() waiter
}
```

### Virtual Buffers

**Purpose**: Zero-copy buffer views spanning multiple segments

**Classes**:
- **VirtualBuffer**: Read-only views with DataView-compatible interface
- **VirtualRWBuffer**: Read/write views for zero-copy writing

**Managed by**: [`virtual-buffer.esm.js`](../src/virtual-buffer.esm.js)

**Key Features**:
- Span multiple segments (ring buffer wrap-around, pool buffers)
- DataView-compatible methods (getUint8/16/32, setUint8/16/32)
- Text encoding/decoding (UTF-8)
- Security: No privilege escalation (VirtualBuffer cannot become VirtualRWBuffer)

**Text Decoding**:
- Single segment: Zero-copy decode directly from buffer
- Multiple segments: Streaming `TextDecoder` with `stream: true` (4-5x faster than copy-first)

**Text Encoding**:
- `encodeFrom(str, offset, label)` → `{ read, written }`
- Enables multi-chunk encoding of large strings
- Returns UTF-16 code units consumed and bytes written

---

## Channel Lifecycle

### States

- **open**: Normal operation, data flowing (initial state)
- **closing**: Close initiated by either side, both sides working on closure
- **localClosing**: Remote sent `chanClosed`, we're still finishing our side
- **remoteClosing**: We sent `chanClosed`, waiting for remote's `chanClosed`
- **closed**: Both `chanClosed` exchanged, fully closed (can be reopened)

### Channel Request Flow

**Requester (Transport A)**:
```
1. User calls transport.requestChannel(name, options)
2. Validate transport state (must be STATE_ACTIVE)
3. Check if channel already exists and open (return existing)
4. Check if request already pending (return existing promise)
5. Create pending request entry (promise + resolve/reject + options)
6. Send TCC data message (type: chanReq, JSON body)
7. Return promise (resolves when channel ready or rejects on failure)
```

**Acceptor (Transport B)**:
```
1. Receive TCC data message (type: chanReq)
2. Parse JSON body (channelName, maxBufferBytes, maxChunkBytes)
3. Check if channel already exists and open (reject if so)
4. Emit 'newChannel' event with accept/reject methods
5. Wait for all event handlers to complete
6. If accepted:
   a. Create channel (or use existing if created during event)
   b. Assign channel ID (next even or odd based on role)
   c. Send TCC data message (type: chanResp, accepted: true, id, limits)
   d. Resolve local pending request if exists (bidirectional case)
7. If rejected:
   a. Send TCC data message (type: chanResp, accepted: false)
   b. Don't reject local pending request (wait for response to OUR request)
```

**Response Handling (Transport A)**:
```
1. Receive TCC data message (type: chanResp)
2. Parse JSON body (name, accepted, id?, limits?)
3. Lookup pending request (protocol violation if not found)
4. If accepted:
   a. Check if channel already exists (created by accepting remote request)
   b. If exists: Add second role ID (perform ID switch if remote ID lower)
   c. If not exists: Create channel with remote's ID and limits
   d. Resolve promise (if not already resolved)
5. If rejected:
   a. Check if channel already exists (we accepted, they rejected)
   b. If exists: "First accept" rule - channel valid, don't reject promise
   c. If not exists: Reject promise
6. Delete pending request (lifecycle complete)
```

### Bidirectional Requests

**"First Accept or Last Reject" Rule**:
- Pending request tracks OUR outgoing request lifecycle (independent of channel availability)
- Channel may be created (by accepting a remote request) before we receive response to our request
- Entry created when we send request, deleted only when we receive response to OUR request
- If either side accepts, channel is valid (even if other side rejects)

**Scenarios**:

**Bidirectional Accept** (both sides accept):
```
We send request → pending entry created
Remote request arrives → we accept → channel created, promise resolved
Pending entry NOT deleted (still waiting for response to OUR request)
Response arrives (accepted) → add second role ID → delete pending entry
```

**Asymmetric Accept** (we accept, they reject):
```
We send request → pending entry created
Remote request arrives → we accept → channel created, promise resolved
Pending entry NOT deleted (still waiting for response to OUR request)
Response arrives (rejected) → channel exists, promise already resolved
"First accept" rule: channel valid, don't reject promise → delete pending entry
```

**Asymmetric Accept** (they accept, we reject):
```
We send request → pending entry created
Remote request arrives → we reject → send rejection response
Pending entry NOT deleted (still waiting for response to OUR request)
Response arrives (accepted) → channel created, promise resolved → delete pending entry
"First accept" rule: their acceptance creates valid channel despite our rejection
```

**Mutual Reject** (both sides reject):
```
We send request → pending entry created
Remote request arrives → we reject → send rejection response
Pending entry NOT deleted (still waiting for response to OUR request)
Response arrives (rejected) → no channel exists, reject promise → delete pending entry
```

### Channel Closure

**Closure Initiation**:
```
1. User calls channel.close({ discard })
2. Validate channel state (must be open)
3. Transition to 'closing' state
4. Send TCC data message (type: chanClose, discard flag) via transport.sendTccMessage()
5. Emit 'beforeClose' event
6. If discard mode: immediately ACK and discard all buffered input
7. Wait for all in-flight writes to be ACK'd (flowControl.allWritesAcked())
8. Send TCC data message (type: chanClosed) via transport.sendTccMessage()
9. Transition to 'remoteClosing' (if remote hasn't sent chanClosed yet)
   OR finalize closure (if remote already sent chanClosed → 'localClosing' state)
10. Emit 'closed' event when both sides send chanClosed
11. Clear message type registrations
12. Notify transport to null the channel record
```

**Closure Conditions**:

**Graceful Closure** (`discard: false`):
- Wait for all in-flight chunks to be ACK'd (output complete)
- Wait for all received chunks to be consumed (input complete)
- Generate and send final ACKs

**Discard Input Closure** (`discard: true`):
- Input: Generate ACKs immediately for all received data (treat as consumed)
- Output: Wait for all in-flight chunks to be ACK'd (must complete)
- Cannot discard from write ring (impractical)
- Data must leave sender's ring → become receiver's input → receiver discards (but still ACKs)

**Cross-Close Handling**:
- Either side can initiate closure at any time
- Both sides can close simultaneously with different `discard` values
- If remote sends `discard: true`, local side switches to discard input mode
- Remote's `discard: true` takes precedence

### Channel "Reopening"

- "Reopening" requires new channel request (standard flow)
- This is actually a completely new channel with the same name/token/ids
- Fresh message type registrations
- Reopened channel starts fresh in `open` state
- No generation tracking needed (synchronized `closed` state is sufficient)
- Transport keeps a "nulled record" (name, ID, token, state=closed) after closure to support reopening

---

## Message Types

### Message Type Registration

**Purpose**: Map string names to numeric IDs for structured communication

**Scope**: Per-channel; potentially-directional ids settle in the same way as channel ids

**Lifecycle**: Registrations persist for open lifetime of channel, cleared at `closed`

**Request Flow**:
```
1. User calls channel.addMessageTypes([type1, type2, ...])
2. Check current status of each type:
   a. If already has ID: Skip (already registered)
   b. If pending request: Wait on existing promise
   c. If new: Create pending entry with promise
3. Send channel control message (type: mesgTypeReq, JSON body)
4. Return Promise.allSettled(promises)
```

**Response Flow**:
```
1. Receive channel control message (type: mesgTypeReq)
2. Parse JSON body ({ request: [type1, type2, ...] })
3. For each type:
   a. Emit 'newMessageType' event (cancelable)
   b. If not prevented:
      - Check for existing registration (reuse ID if found)
      - Otherwise assign new ID (next even or odd based on role)
      - Add to accept list
   c. If prevented: Add to reject list
4. Send channel control message (type: mesgTypeResp, JSON body)
```

**Response Handling**:
```
1. Receive channel control message (type: mesgTypeResp)
2. Parse JSON body ({ accept: { type: id, ... }, reject: [type, ...] })
3. For accepted types:
   a. Add ID to existing entry (handles jitter settlement)
   b. Create reverse mapping (ID → entry)
   c. Resolve waiting promise
4. For rejected types:
   a. Reject waiting promise
   b. Delete entry
```

### Pre-Loaded TCC Message Types

**Shared between TCC data messages and control messages for all channels**:

- **0**: `tranStop` - Transport shutdown initiation and progress
- **1**: `chanReq` - Channel setup request
- **2**: `chanResp` - Channel setup response (accept/reject)
- **3**: `mesgTypeReq` - Message-type registration request
- **4**: `mesgTypeResp` - Message-type registration response
- **5**: `chanClose` - Channel close initiation (with `discard` flag)
- **6**: `chanClosed` - Channel close completion (both sides must send)

**Note**: Message-type mapping for all channel control messages based on TCC channel mappings

### ID Jitter and Settlement

**Jitter**: Temporary state where resource has two IDs (higher-valued ID processed first)

**Settlement**: Automatic convergence to lowest ID after both request round-trips complete

**Mechanism**:
- IDs stored in ascending order
- Sender uses first (lowest) ID when sending
- Settlement happens automatically as by-product of ID sorting and selection

---

## API Specification

### Transport API

#### Constructor

```javascript
constructor(options = {})
```

**Options**:
- `bufferPool`: Buffer pool instance
- `c2c`: C2C channel options `{ lowBufferBytes, maxChunkBytes }`
- `c2cSymbol`: Symbol for C2C channel access (if locally enabled)
- `logger`: Logger instance (default: console)
- `lowBufferBytes`: ACK threshold (default: 16KB)
- `maxChunkBytes`: Maximum chunk size (default: 16KB)
- `tcc`: TCC channel options `{ lowBufferBytes, maxChunkBytes }`

#### Lifecycle Methods

```javascript
async start()
```
- Starts transport (begins reading and writing)
- Returns promise that resolves when transport is active (after handshake)
- Throws `StateError` if transport is stopping or stopped

```javascript
async stop({ discard = false, timeout } = {})
```
- Stops transport (closes all channels)
- `discard`: If true, discard pending data
- `timeout`: Maximum time to wait (msec)
- Resolves when stopped or rejects on error/timeout

#### Channel Methods

```javascript
async requestChannel(name, options = {})
```
- Requests a new channel
- `name`: Channel name (string)
- `options`: Channel options (maxBufferBytes, maxChunkBytes, lowBufferBytes)
- Returns: Promise<Channel>
- Throws `StateError` if transport is not active

```javascript
getChannel(name)
```
- Gets existing channel by name or symbol
- Returns: Channel or undefined
- Note: Public access by numeric ID is NOT permitted

```javascript
async sendTccMessage(token, messageType, options = {})
```
- Sends a TCC message on behalf of a channel (used for chanClose/chanClosed)
- `token`: Channel token (for authorization and ID lookup)
- `messageType`: Must be `TCC_DTAM_CHAN_CLOSE[0]` or `TCC_DTAM_CHAN_CLOSED[0]`
- `options`: Additional message fields (e.g. `{ discard }`)

#### State Properties

```javascript
get state()
```
- Returns: Numeric state constant (STATE_CREATED, STATE_STARTING, STATE_ACTIVE, STATE_STOPPING, STATE_STOPPED)

```javascript
get stateString()
```
- Returns: String state ('created', 'starting', 'active', 'stopping', 'stopped')

```javascript
get id()
```
- Returns: Transport UUID

```javascript
get logger()
```
- Returns: Logger instance

```javascript
get maxChunkBytes()
```
- Returns: Transport-level maximum chunk size

```javascript
get needsEncodedText()
```
- Returns: `true` if transport requires UTF-8 text encoding (byte-stream)
- Returns: `false` if transport sends strings directly as UTF-16 (object-stream)
- Default: `true` (overridden by `PostMessageTransport` to `false`)

```javascript
get logChannelId()
```
- Returns: Symbol for accessing the log channel

#### Events

**`newChannel`**: Emitted when remote requests a channel
```javascript
transport.addEventListener('newChannel', (event) => {
  const { channelName, remoteLimits, accept, reject } = event.detail;
  // Call accept(options) or reject()
});
```

**`beforeStopping`**: Emitted before transport stops
```javascript
transport.addEventListener('beforeStopping', (event) => {
  // Cleanup before stop
});
```

**`stopped`**: Emitted after transport stopped
```javascript
transport.addEventListener('stopped', (event) => {
  // Final cleanup
});
```

**`protocolViolation`**: Emitted on protocol violations
```javascript
transport.addEventListener('protocolViolation', (event) => {
  const { type, description } = event.detail;
  // Handle violation (default: stop transport)
});
```

**`outOfBandData`**: Emitted for non-PolyTransport data on shared pipe
```javascript
transport.addEventListener('outOfBandData', (event) => {
  const { data } = event.detail;
  // Handle out-of-band data (e.g., console output before handshake)
});
```

### Channel API

#### Properties

```javascript
get id()
```
- Returns: Currently-active channel ID (lowest)

```javascript
get ids()
```
- Returns: Copy of all channel IDs (array)

```javascript
get name()
```
- Returns: Channel name (string)

```javascript
get state()
```
- Returns: Channel state ('open', 'closing', 'localClosing', 'remoteClosing', 'closed')

#### Message Type Methods

```javascript
async addMessageTypes(types)
```
- Registers message types
- `types`: Array of string type names
- Returns: Promise.allSettled(promises)
- Throws `StateError` if channel is closing or closed

```javascript
getMessageType(type)
```
- Gets message type info
- `type`: String name or numeric ID
- Returns: `{ ids: number[], name: string }`

#### Write Methods

```javascript
write(messageType, source, options = {})
```
- Writes data to channel (returns Promise)
- `messageType`: String name or numeric ID
- `source`: String, Uint8Array, VirtualBuffer, function, or null
- `options`:
  - `eom`: End-of-message flag (default: true)
  - `byteLength`: Data size for function source (required if source is function)
  - `together`: Send all chunks in a single channel task (default: true)
- Returns: Promise (resolves when all chunks queued)
- Throws `StateError` if channel is closing or closed

**Source Types**:
- **String** (with `needsEncodedText = true`): UTF-8 encoded into ring buffer
- **String** (with `needsEncodedText = false`): Sent as UTF-16 string via postMessage
- **Uint8Array**: Normalized to VirtualBuffer, then binary data
- **VirtualBuffer**: Zero-copy buffer view
- **Function**: `(offset, end, buffer) => void` - Fills buffer with data
- **null**: Empty message (header only)

#### Read Methods

```javascript
async read(options = {})
```
- Reads next matching message/chunk
- `options`:
  - `only`: Message type filter (string, number, array, or Set)
  - `timeout`: Maximum wait time (msec)
  - `dechunk`: Return complete message (default: true)
  - `decode`: Auto-decode binary data to text (default: false)
  - `withHeaders`: Include chunk headers (default: false)
- Returns: Message object or null (if channel closed)

```javascript
readSync(options = {})
```
- Synchronous read (returns immediately)
- `options`: Same as `read()`
- Returns: Message object or null (if no matching message available)

**Message Object**:
```javascript
{
  messageType: string | number,  // Name if registered, otherwise ID
  messageTypeId: number,          // Numeric ID
  text: string | undefined,       // Concatenated text chunks (if any)
  data: VirtualBuffer | undefined, // Concatenated binary chunks (if any)
  dataSize: number,               // Total bytes (text.length * 2 + data.length)
  eom: boolean,                   // EOM flag from last chunk (always true if dechunked)
  done: () => void,               // Mark all sequences as processed
  process: async (callback) => void,  // Try callback, finally call done
  headers: Array<Object>          // Chunk headers (if withHeaders: true)
}
```

**Header Object** (if `withHeaders: true`):
```javascript
{
  type: number,
  headerSize: number,
  dataSize: number,
  flags: number,
  channelId: number,
  sequence: number,
  messageType: number,
  eom: boolean
}
```

#### Lifecycle Methods

```javascript
async close(options = {})
```
- Closes channel
- `options`:
  - `discard`: Discard input (default: false)
- Returns: Promise (resolves when closed)
- If called again while closing: switches to discard mode if `discard: true`, returns same promise

```javascript
hasReader(only = null)
```
- Checks for conflicting readers
- `only`: Message type filter (same as read)
- Returns: true if conflicting reader exists

#### Events

**`beforeClose`**: Emitted before channel closes
```javascript
channel.addEventListener('beforeClose', (event) => {
  // Cleanup before close
});
```

**`closed`**: Emitted after channel closed
```javascript
channel.addEventListener('closed', (event) => {
  // Final cleanup
});
```

**`newMessageType`**: Emitted when remote requests message type registration
```javascript
channel.addEventListener('newMessageType', (event) => {
  const { name } = event.detail;
  // Call event.preventDefault() to reject
});
```

**`protocolViolation`**: Emitted on channel-level protocol violations
```javascript
channel.addEventListener('protocolViolation', (event) => {
  const { duplicateAcks, prematureAcks } = event.detail;
  // Handle violation (default: close channel with discard)
  // Call event.preventDefault() to prevent default action
});
```

---

## Implementation Details

### Transport Input Processing

**Architecture**: Transport acts as lexical analyzer, splitting byte stream into tokens (headers + data)

**Key Principles**:
- Simplicity over zero-copy (one copy per message is acceptable)
- Transport MUST decode headers to route to channels (no duplicate work)
- VirtualRWBuffer for accumulation (append, DataView interface, toPool, release)
- Large reads (64KB) minimize syscalls (major bottleneck)
- Syscall overhead typically exceeds copy overhead

**Data Flow**:
```
Byte Stream → Transport → VirtualRWBuffer → Protocol Decoder → Channels → Application
```

**Process**:
1. Receive system-supplied input buffers (BYOB not universally supported; avoids migrate-from-ring complexity)
2. Accumulate in VirtualRWBuffer (incremental decoding)
3. Decode headers (transport-level parsing)
4. Copy data to pool buffers (one copy per message)
5. Route to channels (pre-parsed header objects + pool buffers)
6. ACKs routed to channels (channels manage sequence tracking)

### Channel De-chunking

**Default Behavior** (`dechunk: true`):
- Channel accumulates chunks until EOM
- `channel.read()` returns complete message
- Most common use case - simplifies application code
- TCC reader gets complete JSON messages automatically

**Opt-Out for Relay** (`dechunk: false`):
- Channel returns individual chunks
- Enables PTOC relay: read chunk → write chunk (no reassembly)
- Only needed for specialized use cases (relay, streaming)
- Reduces memory overhead for pass-through scenarios

**Chunking Model**:
- **At Transport Level**: Chunks from different channels can be interleaved
- **At Channel Level**: Chunks from same message are never interleaved
  - Channel write queue ensures atomic multi-chunk sends (when `together: true`)
  - Each channel's reader sees only that channel's chunks in order

**Data Structures**:

**Control Messages**:
- `controlChunks`: Array of control-message chunk descriptors `{ header, data }`
- Accumulated until EOM
- Assembled, dispatched, and marked processed when complete

**Data Messages**:
- `mesgTypeRemapping`: Map of higher-id-to-lower-id for message-type ID settlement
- `dataChunks`: Set of data-message chunk descriptors `{ activeType, header, data, eom, next, nextEOM }`
- `eomChunks`: Subset of `dataChunks` for which eom is true
- `typeChain`: Map of active-type to `{ read, readEOM, write, writeEOM }`
- `allReader`: `{ waiting: boolean }` for unfiltered readers
- `filteredReaders`: Map of active-type to `{ waiting: boolean, resolve }` for filtered readers

**Strategies**:
- If message-type ID settles to lower value, update all data structures and waiters
- Adding chunks: Always add to `dataChunks`, link into `typeChain`, add to `eomChunks` if EOM
- Removing chunks: Remove from `dataChunks`, update `typeChain`, remove from `eomChunks` if EOM
- Unfiltered reader (message mode): Wait for first EOM chunk, assemble and dispatch
- Unfiltered reader (chunk mode): Return first chunk
- Filtered reader (message mode): Find first EOM chunk matching filter, assemble and dispatch
- Filtered reader (chunk mode): Find first chunk matching filter, return it

### Text Encoding Decision

**Channel checks `transport.needsEncodedText`**:
- **Byte-stream transports**: `needsEncodedText = true` (encode to UTF-8)
- **Object-stream transports**: `needsEncodedText = false` (send as UTF-16 string)

**String Data Size**:
- **Byte-stream**: Actual encoded bytes (variable, 1-4 bytes per code point)
- **Object-stream**: `string.length * 2` (UTF-16 code units)

### Write Timeout Semantics

**Note**: Write timeout is not currently implemented.

**Intended semantics** (for future implementation):
- Timeout applies to first chunk only
- Once first chunk sent, remaining chunks MUST be sent without further timeout
- No protocol provision for partial messages
- Prevents protocol violations from incomplete sends

### Chunk Interleaving

**"Together" Option**:
- `write(data, { together: true })` (default): Send all chunks in same write-queue task
- `write(data, { together: false })`: Allow interleaving with other messages

**Conceptual Outlines**:

**Together: true** (single task, inner chunk iteration):
```
Queue channel-write task
  Iterate over chunks
    Wait for channel send-budget
    Pass chunk to transport
```

**Together: false** (outer chunk iteration, task-per-chunk):
```
Iterate over chunks
  Queue channel-write task
    Wait for channel send-budget
    Pass chunk to transport
```

---

## Security and Validation

### Buffer Zeroing

**Ring Buffer**: Zero-after-write (prevents data leakage across iterations)

**Buffer Pool**: "Separate dirty-buffer pool" strategy cleans dirty buffers just-in-time to meet allocation demand if necessary, otherwise buffers are cleaned between other tasks

### Protocol Violations

**Types**:
- **Out-of-Order Sequence**: Chunks must arrive in consecutive order
- **Over-Budget Chunk**: Chunk exceeds available channel budget
- **Duplicate ACK**: ACKing same sequence twice
- **Premature ACK**: ACKing sequence that hasn't been sent yet
- **Unknown Channel**: ACK or data for channel that doesn't exist
- **Unsolicited Response**: Response without pending request

**Detection**:
- `ChannelFlowControl.received()`: Out-of-order, over-budget
- `ChannelFlowControl.clearWriteAckInfo()`: Duplicate ACK, premature ACK
- Transport: Unknown channel, unsolicited response

**Handling**:
- Emit `protocolViolation` event on transport or channel
- Event includes details for context
- Handler decides action (close channel, close transport, log, etc.)
- Default action: Close transport (transport) or close channel with discard (channel)

### Input Validation

**Handshake**:
- Validate STX/ETX markers
- Validate JSON structure
- Validate configuration values (ranges, types)
- Validate transport ID (UUID v4 format)

**Messages**:
- Validate header structure (size, type, flags)
- Validate channel ID (exists, open)
- Validate sequence number (consecutive, not duplicate)
- Validate budget (not over-budget)
- Validate message type (registered or numeric)

### Resource Limits

**Per-Channel**:
- `maxChunkBytes`: Maximum chunk size (default: 16KB)
- `lowBufferBytes`: Low-water mark for ACK generation (default: 16KB)
- `localLimit`: Maximum channel buffer we're willing to receive
- `remoteLimit`: Maximum channel buffer remote is willing to receive

**Per-Transport**:
- `maxChunkBytes`: Maximum chunk size (default: 16KB)
- `lowBufferBytes`: ACK threshold (default: 16KB)

**Enforcement**:
- Channel budget enforced by `ChannelFlowControl`
- Ring buffer space enforced by `OutputRingBuffer` (byte-stream only)
- Violations trigger `protocolViolation` events

---

## JSMAWS Integration

### Use Cases

#### Operator Process

**Connections**:
- Reads: client ←TCP← operator
- Reads: client ←PTOC via operator← applet (for WebSocket)
- Reads: operator ←worker/IPC← router
- Reads: operator ←IPC/PTOC← responder
- Writes: operator →TCP/PTOC→ client
- Writes: operator →worker/IPC→ router
- Writes: operator →IPC/PTOC→ responder

**Console**: Console and uncaught-exception messages go to console and/or syslog logger (configurable)

#### Responder Process

**Connections**:
- Reads: responder ←IPC← operator
- Reads: responder ←worker/PTOC← applet
- Writes: responder →IPC→ operator
- Writes: responder →worker/PTOC→ applet

**Console**: Console and uncaught-exception messages forwarded via C2C channel to operator for logging

#### Applet Worker

**Connections**:
- Reads: applet ←worker← responder
- Reads: applet ←PTOC via responder← client (for WebSocket)
- Writes: applet →worker→ responder
- Writes: applet →PTOC via responder→ client (for WebSocket)

**Console**: Console and uncaught-exception messages forwarded via C2C channel to responder (then to operator) for logging

**Security**:
- Applets are untrusted, user-supplied code
- Bootstrap module exposes single bidirectional transport channel at startup
- Applets must not gain direct access to buffers, other channels, or transport
- For WebSocket connections, JSMAWS creates PTOC between client and applet (relaying through operator and responder)

### Request Handling

#### Initial Request

**Operator**:
1. Selects responder based on request routing
2. Requests unique request/response channel over operator ↔ responder transport
3. Accepts return request for same channel
4. Accepts atomic or streaming response on same channel
5. Sends small atomic responses as single response
6. Sends larger or streaming responses as streamed response

**Responder**:
1. Accepts req/res-unique operator channel request and requests one back
2. Requests responder →write→ applet channel `primary`
3. Requests responder →write→ applet bootstrap channel `bootstrap`
4. Accepts responder ←read← applet channel `primary`
5. Accepts responder ←read← applet channel `console`
6. Sends bootstrap parameters on `bootstrap` channel to applet bootstrap module
7. Forwards request on `primary` channel to applet main module
8. Forwards atomic or streaming response to operator

**Applet Bootstrap Module**:
1. Requests applet →write→ responder channel `primary` (presented as `self.polyTransportChannel`)
2. Requests bootstrap →write→ responder channel `console` (uses console intercept)
3. Accepts bootstrap ←read← responder channel `bootstrap` to receive bootstrap parameters
4. Disables or intercepts `self.onmessage` and `self.postMessage`

**Applet**:
1. Receives request on `primary` channel (only external access)
2. Sends atomic response, begins streaming response, or agrees to upgrade to bidi

#### WebSocket Bidi Upgrade

**Operator**:
1. Creates WebSocket PT to communicate with WS client
2. Creates channel-hosted PT to communicate with applet and attaches to req/res channel with type `client`
3. Accepts responder's return request
4. Relays between client WS PT and applet PTOC in both directions

**Responder**:
1. Relays `client`-type chunks between operator and applet PTOCs in both directions

**Applet**:
1. Creates channel-hosted PT to communicate with client and attaches to primary channel with type `client`
2. Client and applet can now communicate over channel-hosted PolyTransport with operator and responder relaying chunks

### Reserved Channels

**Channel 0 (TCC)**: Transport Control Channel
- Meta channel for transport maintenance, channel setup/teardown
- Only accessible within transport implementation (no direct user access)
- Data messages used for channel setup (new channel not yet established)
- Data messages used for channel closure (in case channel unstable)
- Comes and goes with transport (cannot be closed separately)

**Channel 1 (C2C)**: Console Content Channel
- User-accessible via configurable symbol `c2cSymbol` option
- Applet bootstrap typically removes access during environment sanitization
- Pre-defined message types:
  - **0**: `trace` - Trace-level messages
  - **1**: `debug` - Debug-level messages
  - **2**: `info` - Info/log-level messages
  - **3**: `warn` - Warning-level messages
  - **4**: `error` - Error-level messages

---

## Appendix: Constants and Defaults

### Protocol Constants

```javascript
// Header types
HDR_TYPE_ACK = 0
HDR_TYPE_CHAN_CONTROL = 1
HDR_TYPE_CHAN_DATA = 2
HDR_TYPE_HANDSHAKE = 'handshake'  // Object-stream only

// Header sizes
DATA_HEADER_BYTES = 18
MIN_ACK_BYTES = 14
MAX_ACK_BYTES = 514
MAX_ACK_RANGES = 501
RESERVE_ACK_BYTES = 514

// Minimum sizes
MIN_DATA_RES_BYTES = 4

// Flags
FLAG_EOM = 0x0001  // End-of-message

// Handshake markers
GREET_CONFIG_PREFIX = '\x02PolyTransport:'
GREET_CONFIG_SUFFIX = '\x03\n'
START_BYTE_STREAM = '\x02\x01\x03\n'
```

### TCC Message Types

```javascript
TCC_DTAM_TRAN_STOP = [0, 'tranStop']
TCC_DTAM_CHAN_REQUEST = [1, 'chanReq']
TCC_DTAM_CHAN_RESPONSE = [2, 'chanResp']
TCC_CTLM_MESG_TYPE_REG_REQ = [3, 'mesgTypeReq']
TCC_CTLM_MESG_TYPE_REG_RESP = [4, 'mesgTypeResp']
TCC_DTAM_CHAN_CLOSE = [5, 'chanClose']
TCC_DTAM_CHAN_CLOSED = [6, 'chanClosed']
```

### C2C Message Types

```javascript
C2C_MESG_TRACE = [0, 'trace']
C2C_MESG_DEBUG = [1, 'debug']
C2C_MESG_INFO = [2, 'info']
C2C_MESG_WARN = [3, 'warn']
C2C_MESG_ERROR = [4, 'error']
```

### Default Values

```javascript
// Transport defaults
DEFAULT_MAX_CHUNK_BYTES = 16 * 1024    // 16KB
DEFAULT_LOW_BUFFER_BYTES = 16 * 1024   // 16KB
DEFAULT_RING_SIZE = 256 * 1024         // 256KB

// Channel defaults
DEFAULT_CHANNEL_MAX_CHUNK_BYTES = 16 * 1024   // 16KB
DEFAULT_CHANNEL_LOW_BUFFER_BYTES = 16 * 1024  // 16KB

// Configuration defaults
DEFAULT_MIN_CHANNEL_ID = 2
DEFAULT_MIN_MESSAGE_TYPE_ID = 256
DEFAULT_PROTOCOL_VERSION = 1
DEFAULT_C2C_ENABLED = false

// Buffer pool sizes
POOL_SIZE_1KB = 1024
POOL_SIZE_4KB = 4096
POOL_SIZE_16KB = 16384
POOL_SIZE_64KB = 65536
```

---

## Appendix: Error Classes

```javascript
class StateError extends Error {
  // Thrown when operation invalid for current state
  // Examples: write on closing channel, request on stopped transport
  constructor(message, details)
  get name()  // 'StateError'
}

class TimeoutError extends Error {
  // Thrown when operation times out
  // Examples: channel request timeout, read timeout, close timeout
}

class ProtocolViolationError extends Error {
  constructor(description, details)
  // Thrown internally for protocol violations
  // description/reason: 'Out of order' | 'Over budget' | 'Duplicate ACK' | 'Premature ACK'
  // details: Additional context
  // Note: User code should not catch this directly (handled via events)
  get name()  // 'ProtocolViolationError'
}

class RingBufferReservationError extends Error {
  // Thrown for ring buffer reservation errors
  // Examples: reservation already pending, invalid length
}
```

---

## Appendix: Related Documents

### Architecture Documents

- [`arch/channel-close-architecture.md`](channel-close-architecture.md) - Channel close state machine and protocol
- [`arch/control-channel-refactoring.md`](control-channel-refactoring.md) - Control channel simplification and "First Accept or Last Reject" rule
- [`arch/transport-input-overview.md`](transport-input-overview.md) - Line-based handshake overview
- [`arch/transport-input-processing.md`](transport-input-processing.md) - Transport as lexical analyzer

### Implementation Files

- [`src/transport/base.esm.js`](../src/transport/base.esm.js) - Transport base class
- [`src/transport/byte.esm.js`](../src/transport/byte.esm.js) - Byte-stream transport
- [`src/transport/post-message.esm.js`](../src/transport/post-message.esm.js) - Object-stream transport
- [`src/channel.esm.js`](../src/channel.esm.js) - Channel implementation
- [`src/control-channel.esm.js`](../src/control-channel.esm.js) - Control channel (simplified)
- [`src/con2-channel.esm.js`](../src/con2-channel.esm.js) - Console content channel
- [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js) - Channel flow control
- [`src/protocol.esm.js`](../src/protocol.esm.js) - Protocol encoding/decoding
- [`src/buffer-pool.esm.js`](../src/buffer-pool.esm.js) - Buffer pool management
- [`src/output-ring-buffer.esm.js`](../src/output-ring-buffer.esm.js) - Output ring buffer
- [`src/virtual-buffer.esm.js`](../src/virtual-buffer.esm.js) - Virtual buffer views

---

## Document History

- **2026-04-02**: Updated to current implementation state; removed DRAFT status; fixed all known discrepancies; archived superseded documents
- **2026-03-20**: Initial draft consolidating all architectural documents
- **Supersedes**: `arch/requirements.md` (archived)

---

**End of Requirements Document**
