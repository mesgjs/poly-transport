# Scenario: Message Encoding

**Status**: Complete
**Last Updated**: 2026-01-17

## Overview

This scenario documents how PolyTransport encodes messages into binary format for transmission over byte-stream transports. The encoding process uses zero-copy techniques by writing directly into output ring buffer reservations via VirtualRWBuffer.

**Key Implementation Details**:
- **Zero-copy encoding**: Headers and data written directly into ring buffer reservations
- **Three header types**: ACK (0), channel control (1), channel data (2)
- **Message types**: Field in channel headers (offset 16) for reader filtering
- **DataView-compatible API**: VirtualRWBuffer provides setUint8/16/32 methods for encoding
- **Even-padded headers**: All headers padded to even length for alignment and size encoding
- **Remaining size encoding**: Counts 16-bit words, assumes at least one word after type+size bytes

## Purpose

Message encoding enables:
- **Binary protocol transmission**: Efficient byte-stream format for all transports
- **Zero-copy performance**: Direct encoding into ring buffer without intermediate buffers
- **Protocol compliance**: Correct header format with proper field encoding
- **Flow control integration**: ACK headers for budget restoration, data headers for content transfer

## Key Components

- **Protocol Layer** ([`src/protocol.esm.js`](../../src/protocol.esm.js)): Encoding functions
- **OutputRingBuffer** ([`src/output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js)): Provides reservations
- **VirtualRWBuffer** ([`src/virtual-buffer.esm.js`](../../src/virtual-buffer.esm.js)): Zero-copy write interface
- **ChannelFlowControl** ([`src/channel-flow-control.esm.js`](../../src/channel-flow-control.esm.js)): Generates ACK information

## Header Type vs Message Type

**Critical Distinction**:
- **Header type** (first byte, offset 0): Determines header parsing (0=ACK, 1=control, 2=data)
- **Message type** (2-byte field at offset 16 in channel headers): For reader filtering

**Example**:
```javascript
// Header type 2 (channel data) with message type 1024 (user-defined)
buffer[0] = 2;              // Header type: channel data
buffer[16-17] = 1024;       // Message type: for filtering
```

## Remaining Size Encoding

**Formula**: `encodedRemaining = (totalBytes - 4) >> 1`

**Rationale**:
- After reading type byte (1B) and size byte (1B), we've read 2 bytes
- Remaining bytes = totalBytes - 2
- Assume at least 2 more bytes (one 16-bit word minimum)
- Encode as 16-bit words: `(remaining - 2) / 2 = (totalBytes - 4) / 2`
- This allows encoding up to 514 bytes total in a single size byte (255 * 2 + 4)

**Decoding**: `totalBytes = (encodedRemaining << 1) + 4`

**Example**:
- Total header: 18 bytes
- Encoded: `(18 - 4) >> 1 = 14 >> 1 = 7`
- Decode: `(7 << 1) + 4 = 14 + 4 = 18` ✓

## Scenario 1: ACK Message Encoding

### Initial State

- Channel has consumed chunks and buffer usage dropped below low-water mark
- ChannelFlowControl has ACK information ready: `{ baseSeq, ranges }`
- Transport needs to send ACK to restore remote's budget

### Step-by-Step Flow

#### 1. Generate ACK Information

**Actor**: ChannelFlowControl

```javascript
// Check if ACK should be generated (low-water mark trigger)
if (flowControl.bufferUsed < lowBufferBytes) {
  const ackInfo = flowControl.getAckInfo();
  // ackInfo = { baseSeq: 5, ranges: [3, 1, 2] }
  // Means: ACK base 5, +3 (6-8), skip 1 (9), +2 (10-11)
}
```

**State**:
- `ackInfo.baseSeq` = 5 (base sequence, ACK'd independently)
- `ackInfo.ranges` = [3, 1, 2] (include 3 after base, skip 1, include 2)
- Range count = 3 (odd, as required)

**Critical**: The base sequence is **independent** - it is ACK'd on its own. The first range **never includes the base**. The ranges describe sequences **after** the base.

**Interpretation**:
- Base 5: ACK sequence 5
- +3: ACK sequences 6, 7, 8 (3 sequences after base)
- Skip 1: Skip sequence 9
- +2: ACK sequences 10, 11 (2 sequences)
- **Total ACK'd**: 5, 6, 7, 8, 10, 11

#### 2. Calculate ACK Header Size

**Actor**: Protocol Layer

```javascript
import { ackHeaderSize, toEven } from './protocol.esm.js';

const rangeCount = ackInfo.ranges.length; // 3
const headerSize = ackHeaderSize(rangeCount);
// headerSize = toEven(13 + 3) = toEven(16) = 16 bytes
```

**Formula**:
- Base size: 13 bytes (type + size + flags + channelId + baseSeq + rangeCount)
- Range bytes: `rangeCount` bytes
- Total: `toEven(13 + rangeCount)` bytes
- Example: `toEven(13 + 3) = 16` bytes (already even)

#### 3. Reserve Ring Buffer Space (ACK-Specific)

**Actor**: OutputRingBuffer

```javascript
// ACK messages use exact: true to bypass RESERVE_ACK_BYTES requirement
const reservation = await ringBuffer.reserveAsync(headerSize, { exact: true });
// reservation is VirtualRWBuffer with 16 bytes
```

**Critical**: ACKs use `exact: true` parameter:
- **Data messages**: Reserve `length + RESERVE_ACK_BYTES` (ensure ACKs can be sent) - default behavior with `exact: false`
- **ACK messages**: Reserve exactly `length` (no extra space needed) - use `exact: true`
- **Rationale**: ACKs are fire-and-forget, no ACK-on-ACK, so no budget restoration needed

**State**:
- Ring buffer: 16 bytes reserved at current writeHead
- `reservation.length` = 16
- `reservation.segmentCount` = 1 or 2 (depending on wrap-around)

#### 4. Encode ACK Header

**Actor**: Protocol Layer

```javascript
import { encodeAckHeaderInto, HDR_TYPE_ACK, totalToEncAddl } from './protocol.esm.js';

const fields = {
  channelId: 42,           // Channel ID (for sequence context)
  baseSequence: 5,         // Base sequence (ACK'd independently)
  flags: 0,                // No flags defined for ACKs
  ranges: [3, 1, 2]        // +3 after base, skip 1, +2
};

const bytesWritten = encodeAckHeaderInto(reservation, 0, fields);
// bytesWritten = 16
```

**Encoding Details** (requirements.md:442-456):

**Byte-by-byte layout**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          0 (HDR_TYPE_ACK)
1       1B    Encoded remaining    6 (= (16-4)>>1)
2       2B    Flags                0x0000
4       4B    Channel ID           42
8       4B    Base sequence        5
12      1B    Range count          3
13      1B    Range[0] (include)   3 (+3 after base: 6-8)
14      1B    Range[1] (skip)      1 (skip 9)
15      1B    Range[2] (include)   2 (+2: 10-11)
Total: 16 bytes
```

**Remaining Size Calculation**:
- Formula: `encodedRemaining = (totalBytes - 4) >> 1`
- Example: `(16 - 4) >> 1 = 12 >> 1 = 6`
- Decoding: `totalBytes = (encodedRemaining << 1) + 4 = (6 << 1) + 4 = 16` ✓

**Range Encoding**:
- **Base is independent**: ACK'd on its own, not included in first range
- Range count should be 0 or odd (never even)
- Alternating include/skip/include pattern
- Always ends with include (never skip)
  - Note: An even, non-zero range count is not (currently) considered a protocol violation, it's just inefficient (ending with a "skip" byte is pointless and increases the header size needlessly)
- Example: [3, 1, 2] means "+3 after base, skip 1, +2"

#### 5. Commit Reservation

**Actor**: OutputRingBuffer

```javascript
ringBuffer.commit(reservation);
```

**State**:
- Ring buffer: `#count += 16` (committed bytes)
- Ring buffer: `#reserved -= 16` (no longer reserved)
- Ring buffer: `#pendingReservation = null` (slot freed)
- ACK message ready to send

#### 6. Get Buffers for I/O

**Actor**: Transport

```javascript
const buffers = ringBuffer.getBuffers(16);
// buffers = [Uint8Array] (1 or 2 arrays if wrapped)

// Send to transport
await transport.write(buffers);
```

**State**:
- `buffers` is array of 1 or 2 Uint8Array views
- Single array if no wrap-around
- Two arrays if data wraps around ring boundary

#### 7. Consume Sent Data

**Actor**: Transport (after successful send)

```javascript
ringBuffer.consume(16);
```

**State**:
- Ring buffer: `#count -= 16` (bytes consumed)
- Ring buffer: `#readHead` advanced by 16 (with wrap-around)
- Consumed space zeroed for security (zero-after-write)
- Space available for next reservation

### ACK Message Characteristics

**Transport-Level Message**:
- ACKs are transport-level, not channel-level
- Do NOT count toward channel budget
- Do NOT count toward transport budget (fire-and-forget)
- Only consume ring buffer space (freed immediately after send)

**No ACK-on-ACK**:
- ACKs are not acknowledged by remote
- If ACKs used transport budget, that budget would never be restored
- Ring buffer space is freed immediately after send
- Simpler and more efficient than transport budget tracking

**Budget Restoration**:
- ACKs restore channel budget on sender side (remote)
- ACKs restore transport budget on sender side (remote)
- But ACKs don't consume transport budget on sender side (local)

## Scenario 2: Channel Control Message Encoding

### Initial State

- Channel needs to send control message (e.g., message-type registration request)
- Control messages count toward channel budget (unlike ACKs)
- Transport has sufficient budget available

### Step-by-Step Flow

#### 1. Prepare Control Message Data

**Actor**: Channel

```javascript
// Example: Message-type registration request
const messageType = 3; // TCC_CTLM_MESG_TYPE_REG_REQ
const data = JSON.stringify({ request: ['userAction', 'systemEvent'] });
const dataBytes = new TextEncoder().encode(data);
const dataSize = dataBytes.length;
```

**State**:
- `messageType` = 3 (TCC_CTLM_MESG_TYPE_REG_REQ - for filtering)
- `dataSize` = length of JSON string in bytes
- `dataBytes` = UTF-8 encoded JSON

#### 2. Calculate Total Chunk Size

**Actor**: Channel

```javascript
import { MAX_DATA_HEADER_BYTES } from './protocol.esm.js';

const headerSize = MAX_DATA_HEADER_BYTES; // Always 18 bytes
const chunkBytes = headerSize + dataSize;
```

**State**:
- `headerSize` = 18 bytes (fixed for all channel messages)
- `chunkBytes` = 18 + dataSize (total over-the-wire size)

#### 3. Reserve Budgets (Channel and Transport)

**Actor**: ChannelFlowControl and Transport

```javascript
// Reserve channel budget (atomic, provisional)
await flowControl.reserveBudget(chunkBytes);

// Reserve transport budget (atomic, provisional, FIFO round-robin)
await transport._reserveBudget(chunkBytes);
```

**State**:
- Channel budget: `chunkBytes` reserved (provisional)
- Transport budget: `chunkBytes` reserved (provisional)
- Both reservations atomic (no budget theft)

#### 4. Reserve Ring Buffer Space

**Actor**: OutputRingBuffer

```javascript
// Data messages reserve extra space for ACKs
const reservation = await ringBuffer.reserveAsync(chunkBytes);
// Actually reserves: chunkBytes + RESERVE_ACK_BYTES
```

**State**:
- Ring buffer: `chunkBytes + RESERVE_ACK_BYTES` reserved
- `reservation.length` = `chunkBytes` (user-visible length)
- Extra `RESERVE_ACK_BYTES` ensures ACKs can be sent

#### 5. Assign Sequence Number

**Actor**: ChannelFlowControl

```javascript
const sequence = flowControl.assignSequence(chunkBytes);
// sequence = next sequence number (e.g., 1, 2, 3, ...)
```

**State**:
- Sequence number assigned and incremented
- In-flight map updated: `inFlight.set(sequence, chunkBytes)`

#### 6. Encode Channel Control Header

**Actor**: Protocol Layer

```javascript
import { encodeChannelHeaderInto, HDR_TYPE_CHAN_CONTROL, totalToEncAddl } from './protocol.esm.js';

const fields = {
  dataSize: dataSize,      // Payload size in bytes
  flags: 0x0001,           // FLAG_EOM (control messages are always single-chunk)
  channelId: 42,           // Channel ID
  sequence: sequence,      // Local sequence number
  messageType: 3           // TCC_CTLM_MESG_TYPE_REG_REQ (for filtering)
};

const bytesWritten = encodeChannelHeaderInto(
  reservation,
  0,
  HDR_TYPE_CHAN_CONTROL,  // Header type (first byte)
  fields
);
// bytesWritten = 18
```

**Encoding Details** (requirements.md:469-480):

**Byte-by-byte layout**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          1 (HDR_TYPE_CHAN_CONTROL)
1       1B    Encoded remaining    7 (= (18-4)>>1)
2       4B    Data size            dataSize
6       2B    Flags                0x0001 (FLAG_EOM)
8       4B    Channel ID           42
12      4B    Sequence             sequence
16      2B    Message type         3 (TCC_CTLM_MESG_TYPE_REG_REQ)
Total: 18 bytes (MAX_DATA_HEADER_BYTES)
```

**Remaining Size**:
- Always 7 for channel headers: `(18 - 4) >> 1 = 7`
- Fixed size simplifies parsing

#### 7. Encode Data Payload

**Actor**: Channel

```javascript
// Copy data after header
reservation.set(dataBytes, 18);
```

**State**:
- Reservation now contains: [18-byte header][data payload]
- Total size: `chunkBytes` bytes

#### 8. Commit Reservation

**Actor**: OutputRingBuffer

```javascript
ringBuffer.commit(reservation);
```

**State**:
- Ring buffer: `#count += chunkBytes` (committed bytes)
- Ring buffer: `#reserved -= chunkBytes` (no longer reserved)
- Ring buffer: `#pendingReservation = null` (slot freed)
- Control message ready to send

#### 9. Send and Consume

**Actor**: Transport

```javascript
// Get buffers for I/O
const buffers = ringBuffer.getBuffers(chunkBytes);

// Send to transport
await transport.write(buffers);

// Consume sent data
ringBuffer.consume(chunkBytes);
```

**State**:
- Message sent over transport
- Ring buffer space freed and zeroed
- Budget remains reserved until ACK received

### Channel Control Message Characteristics

**Channel-Level Message**:
- Control messages count toward channel budget
- Control messages count toward transport budget
- Must be ACK'd by remote (budget restoration)

**Always Single-Chunk**:
- Control messages always have EOM flag set
- No multi-chunk control messages
- Simplifies control message processing

**Message Types** (for filtering):
- 3: TCC_CTLM_MESG_TYPE_REG_REQ (message-type registration request)
- 4: TCC_CTLM_MESG_TYPE_REG_RESP (message-type registration response)
- Additional types as needed

## Scenario 3: Channel Data Message Encoding

### Initial State

- Application calls `channel.write(data, { eom, type })`
- Data may be string or Uint8Array
- May require multiple chunks if data exceeds `maxChunkBytes`

### Step-by-Step Flow

#### 1. Prepare Data for Encoding

**Actor**: Channel

```javascript
// Example: String data
const data = "Hello, World!";
const messageType = 'userMessage'; // Named message type (for filtering)

// Determine encoding strategy
const isString = typeof data === 'string';
const maxDataBytes = maxChunkBytes - MAX_DATA_HEADER_BYTES;
```

**State**:
- `isString` = true (string data)
- `maxDataBytes` = maximum data payload per chunk
- `messageType` = named type (requires lookup)

#### 2. Lookup Message Type ID

**Actor**: Channel

```javascript
// Get numeric message type ID (for filtering)
const messageTypeId = channel.getMessageTypeId(messageType);
// messageTypeId = 1024 (or whatever was assigned)
```

**State**:
- `messageTypeId` = numeric ID for named type
- If not registered, must register first (async operation)

#### 3. Calculate Chunk Size (String Encoding)

**Actor**: Channel

```javascript
// For strings: over-allocate for worst-case UTF-8 encoding
const remaining = data.length - offset; // UTF-16 code units
const worstCase = remaining * 3; // Worst-case UTF-8 bytes
const reserveSize = Math.min(worstCase, maxDataBytes);
const chunkBytes = MAX_DATA_HEADER_BYTES + reserveSize;
```

**State**:
- `reserveSize` = worst-case bytes for this chunk
- `chunkBytes` = header + worst-case data
- May shrink after actual encoding

#### 4. Reserve Budgets and Ring Space

**Actor**: ChannelFlowControl, Transport, OutputRingBuffer

```javascript
// Reserve channel budget (atomic, provisional)
await flowControl.reserveBudget(chunkBytes);

// Reserve transport budget (atomic, provisional, FIFO round-robin)
await transport._reserveBudget(chunkBytes);

// Reserve ring buffer space (with ACK reserve)
const reservation = await ringBuffer.reserveAsync(chunkBytes);
```

**State**:
- All three resources reserved atomically
- Prevents budget theft and deadlocks
- Provisional until chunk completes

#### 5. Assign Sequence Number

**Actor**: ChannelFlowControl

```javascript
const sequence = flowControl.assignSequence(chunkBytes);
```

**State**:
- Sequence number assigned
- In-flight map updated (provisional)

#### 6. Encode Channel Data Header

**Actor**: Protocol Layer

```javascript
import { encodeChannelHeaderInto, HDR_TYPE_CHAN_DATA, FLAG_EOM } from './protocol.esm.js';

const isLastChunk = (offset + reserveSize >= data.length);
const fields = {
  dataSize: reserveSize,   // Provisional (may shrink)
  flags: isLastChunk ? FLAG_EOM : 0,
  channelId: 42,           // Channel ID
  sequence: sequence,      // Local sequence number
  messageType: messageTypeId  // For filtering
};

const bytesWritten = encodeChannelHeaderInto(
  reservation,
  0,
  HDR_TYPE_CHAN_DATA,  // Header type (first byte)
  fields
);
// bytesWritten = 18
```

**Encoding Details**:

**Byte-by-byte layout**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          2 (HDR_TYPE_CHAN_DATA)
1       1B    Encoded remaining    7 (= (18-4)>>1)
2       4B    Data size            reserveSize (provisional)
6       2B    Flags                0x0001 if EOM, else 0x0000
8       4B    Channel ID           42
12      4B    Sequence             sequence
16      2B    Message type         messageTypeId (for filtering)
Total: 18 bytes (MAX_DATA_HEADER_BYTES)
```

**EOM Flag**:
- Set on last chunk of message
- Not set on intermediate chunks
- Receiver uses to detect message boundaries

#### 7. Encode Data Payload (String)

**Actor**: VirtualRWBuffer

```javascript
// Encode string directly into reservation
const result = reservation.encodeFrom(data, offset, 'utf-8');
// result = { read: 13, written: 13 }
```

**State**:
- `result.read` = UTF-16 code units consumed from string
- `result.written` = bytes written to buffer
- Actual encoding may be less than worst-case

#### 8. Shrink Reservation (If Needed)

**Actor**: VirtualRWBuffer and OutputRingBuffer

```javascript
const actualDataSize = result.written;
const actualChunkBytes = MAX_DATA_HEADER_BYTES + actualDataSize;

if (actualChunkBytes < chunkBytes) {
  // Update header with actual data size
  reservation.setUint32(2, actualDataSize, false);
  
  // Shrink reservation
  reservation.shrink(actualChunkBytes);
  
  // Release unused budget
  const freed = chunkBytes - actualChunkBytes;
  flowControl.releaseBudget(freed);
  transport._releaseBudget(freed);
}
```

**State**:
- Reservation shrunk to actual size
- Header updated with actual data size
- Unused budget released (available for next chunk)

#### 9. Commit Reservation

**Actor**: OutputRingBuffer

```javascript
ringBuffer.commit(reservation);
```

**State**:
- Ring buffer: committed bytes updated
- Reservation slot freed
- Message ready to send

#### 10. Send and Consume

**Actor**: Transport

```javascript
// Get buffers for I/O
const buffers = ringBuffer.getBuffers(actualChunkBytes);

// Send to transport
await transport.write(buffers);

// Consume sent data
ringBuffer.consume(actualChunkBytes);
```

**State**:
- Message sent over transport
- Ring buffer space freed and zeroed
- Budget remains reserved until ACK received

### Channel Data Message Characteristics

**Channel-Level Message**:
- Data messages count toward channel budget
- Data messages count toward transport budget
- Must be ACK'd by remote (budget restoration)

**Multi-Chunk Support**:
- Large messages automatically chunked
- EOM flag only on last chunk
- Intermediate chunks have no EOM flag
- All chunks have same message type (for filtering)

**String Encoding**:
- Over-allocate for worst-case UTF-8 (3 bytes per code unit)
- Encode directly into ring buffer (zero-copy)
- Shrink reservation to actual size
- Release unused budget

**Binary Data**:
- No over-allocation needed (size known)
- Copy directly into ring buffer
- No shrinking needed

## Scenario 4: Multi-Chunk Message Encoding

### Initial State

- Application calls `channel.write(largeData, { eom: true, type })`
- Data exceeds `maxChunkBytes` and requires multiple chunks
- Each chunk must be encoded separately

### Step-by-Step Flow

#### 1. Determine Chunking Strategy

**Actor**: Channel

```javascript
const isString = typeof data === 'string';
const maxDataBytes = maxChunkBytes - MAX_DATA_HEADER_BYTES;

if (isString) {
  // String: dynamic chunking (variable-length UTF-8)
  let offset = 0;
  while (offset < data.length) {
    // Encode one chunk at a time
    await encodeStringChunk(data, offset, maxDataBytes);
    offset += result.read; // Advance by UTF-16 code units consumed
  }
} else {
  // Binary: pre-calculate chunks (fixed-length)
  const chunks = Math.ceil(data.length / maxDataBytes);
  for (let i = 0; i < chunks; i++) {
    const start = i * maxDataBytes;
    const end = Math.min(start + maxDataBytes, data.length);
    await encodeBinaryChunk(data.subarray(start, end), i === chunks - 1);
  }
}
```

**Key Differences**:
- **String**: Dynamic chunking (cannot pre-plan due to variable-length UTF-8)
- **Binary**: Pre-calculated chunks (fixed-length, known size)

#### 2. Encode Each Chunk

**Actor**: Channel (loop)

For each chunk:
1. Reserve budgets (channel, transport, ring)
2. Assign sequence number
3. Encode header (EOM flag only on last chunk)
4. Encode data payload
5. Shrink if needed (strings only)
6. Commit reservation
7. Send and consume

**State**:
- Each chunk is independent
- Chunks may interleave with other messages (fairness)
- All chunks have same message type (for filtering)
- Only last chunk has EOM flag

#### 3. EOM Flag Handling

**Actor**: Channel

```javascript
// Determine if this is the last chunk
const isLastChunk = (offset + chunkSize >= data.length);
const flags = isLastChunk ? FLAG_EOM : 0;
```

**State**:
- Intermediate chunks: `flags = 0` (no EOM)
- Last chunk: `flags = FLAG_EOM` (end of message)
- Receiver uses EOM to detect message boundaries

#### 4. Chunk Interleaving

**Actor**: Transport (TaskQueue)

```javascript
// Chunks from different messages can interleave
// Example: Message A (3 chunks), Message B (1 chunk), Message C (1 chunk)
// Possible order: A1, B1, A2, C1, A3
// FIFO ordering at chunk level (fairness)
```

**State**:
- TaskQueue serializes chunks within channel
- Transport TaskQueue serializes budget across channels
- Natural interleaving for fairness

## Integration Points

### With OutputRingBuffer

```javascript
// Reserve space (data messages reserve extra for ACKs)
const reservation = await ringBuffer.reserveAsync(chunkBytes);

// Encode header and data
encodeChannelHeaderInto(reservation, 0, headerType, fields);
reservation.set(dataBytes, 18);

// Shrink if needed
reservation.shrink(actualSize);

// Commit
ringBuffer.commit(reservation);

// Get buffers for I/O
const buffers = ringBuffer.getBuffers(actualSize);

// Consume after send
ringBuffer.consume(actualSize);
```

### With ChannelFlowControl

```javascript
// Reserve budget (atomic, provisional)
await flowControl.reserveBudget(chunkBytes);

// Assign sequence number
const sequence = flowControl.assignSequence(chunkBytes);

// Release unused budget after shrinking
flowControl.releaseBudget(freed);

// Generate ACK information
const ackInfo = flowControl.getAckInfo();
```

### With Transport

```javascript
// Reserve transport budget (FIFO round-robin)
await transport._reserveBudget(chunkBytes);

// Release unused transport budget
transport._releaseBudget(freed);

// Send buffers
await transport.write(buffers);
```

## Key Takeaways

1. **Zero-Copy Encoding**: Headers and data written directly into ring buffer reservations
2. **Three Header Types**: ACK (0), channel control (1), channel data (2) - first byte determines parsing
3. **Message Types**: Field in channel headers (offset 16) for reader filtering
4. **Remaining Size Encoding**: Counts 16-bit words, assumes at least one word: `(totalBytes - 4) >> 1`
5. **ACKs Are Special**: Fire-and-forget, ring buffer only, no transport budget
6. **ACK Base Is Independent**: Base sequence ACK'd on its own, ranges describe sequences after base
7. **Even-Padded Headers**: All headers padded to even length for alignment and size encoding
8. **Atomic Reservations**: Channel budget, transport budget, ring space reserved atomically
9. **String Encoding**: Over-allocate, encode, shrink, release unused budget
10. **Multi-Chunk Messages**: Dynamic chunking for strings, pre-calculated for binary
11. **EOM Flag**: Only on last chunk, intermediate chunks have no EOM
12. **Chunk Interleaving**: Fairness via chunk-level serialization
13. **DataView-Compatible API**: VirtualRWBuffer provides setUint8/16/32 methods

## Related Scenarios

- [`virtual-buffer-operations.md`](virtual-buffer-operations.md) - VirtualRWBuffer write operations used for encoding
- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - OutputRingBuffer reservation lifecycle
- [`simple-write.md`](simple-write.md) - Single-chunk write flow using encoding
- [`multi-chunk-write.md`](multi-chunk-write.md) - Multi-chunk write flow with chunking
- [`ack-generation-processing.md`](ack-generation-processing.md) - ACK generation that triggers encoding
- [`send-flow-control.md`](send-flow-control.md) - Budget reservation before encoding
- [`message-decoding.md`](message-decoding.md) - Decoding received messages (TODO)
