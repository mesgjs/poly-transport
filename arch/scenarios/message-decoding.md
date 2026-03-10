# Scenario: Message Decoding

**Status**: Complete
**Last Updated**: 2026-01-17

## Overview

This scenario documents how PolyTransport decodes binary messages received from byte-stream transports. The decoding process extracts header fields and data payloads from incoming buffers, validating protocol compliance and preparing data for application consumption.

**Key Implementation Details**:
- **Incremental decoding**: Handles partial headers and data (streaming input)
- **Three header types**: ACK (0), channel control (1), channel data (2)
- **DataView-compatible API**: VirtualBuffer provides getUint8/16/32 methods for decoding
- **Remaining size decoding**: Converts encoded size byte to total header bytes
- **Protocol validation**: Detects invalid header types and malformed messages

## Purpose

Message decoding enables:
- **Binary protocol reception**: Parse efficient byte-stream format from all transports
- **Incremental processing**: Handle partial messages in streaming scenarios
- **Protocol compliance**: Validate header format and detect violations
- **Flow control integration**: Extract ACK information for budget restoration, sequence numbers for tracking

## Key Components

- **Protocol Layer** ([`src/protocol.esm.js`](../../src/protocol.esm.js)): Decoding functions
- **VirtualBuffer** ([`src/virtual-buffer.esm.js`](../../src/virtual-buffer.esm.js)): Zero-copy read interface
- **ChannelFlowControl** ([`src/channel-flow-control.esm.js`](../../src/channel-flow-control.esm.js)): Processes ACK information
- **Transport** ([`src/transport/base.esm.js`](../../src/transport/base.esm.js)): Receives and buffers incoming data

## Header Type vs Message Type

**Critical Distinction**:
- **Header type** (first byte, offset 0): Determines header parsing (0=ACK, 1=control, 2=data)
- **Message type ID** (2-byte field at offset 16 in channel headers): Numeric ID for reader filtering
- **Message type** (string): Optional, if message type ID is registered/mapped to a name

**Example**:
```javascript
// Header type 2 (channel data) with message type ID 1024 (user-defined)
const headerType = buffer.getUint8(0);        // 2 (channel data)
const messageTypeId = buffer.getUint16(16);   // 1024 (numeric ID)

// If registered/mapped:
const messageType = channel.getMessageTypeName(messageTypeId);  // 'userMessage' (string)
```

## Remaining Size Decoding

**Formula**: `totalBytes = (encodedRemaining << 1) + 4`

**Rationale**:
- Encoded size byte counts 16-bit words after first 2 bytes
- Assumes at least one 16-bit word (minimum 4 bytes total)
- Decoding reverses the encoding formula: `(totalBytes - 4) >> 1`

**Example**:
- Encoded size byte: 7
- Decode: `(7 << 1) + 4 = 14 + 4 = 18` bytes total
- Verify: `(18 - 4) >> 1 = 7` ✓

## Scenario 1: ACK Message Decoding

### Initial State

- Transport receives bytes from network/pipe/worker
- Bytes buffered in input buffer (VirtualBuffer)
- At least 2 bytes available (header type + size byte)

### Step-by-Step Flow

#### 1. Determine Header Size

**Actor**: Protocol Layer

```javascript
import { decodeHeaderSizeFromPrefix, HDR_TYPE_ACK } from './protocol.esm.js';

// Check if we have enough bytes to determine header size
if (inputBuffer.length < 2) {
  // Wait for more data
  return null;
}

const headerSize = decodeHeaderSizeFromPrefix(inputBuffer, 0);
// headerSize = 16 (for example with 3 range bytes)
```

**State**:
- `headerSize` = total header bytes needed
- For ACK: `headerSize = (sizeByte << 1) + 4`
- For channel: `headerSize = 18` (fixed)

**Implementation** (protocol.esm.js:243-269):
```javascript
export function decodeHeaderSizeFromPrefix (buffer, offset = 0) {
  const length = buffer.length || buffer.byteLength;
  if (length - offset < 2) {
    return null;  // Incomplete
  }

  const type = buffer.getUint8(offset);
  const sizeByte = buffer.getUint8(offset + 1);

  if (type === HDR_TYPE_ACK) {
    return encAddlToTotal(sizeByte);  // (sizeByte << 1) + 4
  }

  if (type === HDR_TYPE_CHAN_CONTROL || type === HDR_TYPE_CHAN_DATA) {
    return DATA_HEADER_BYTES;  // Always 18
  }

  throw new Error(`Unknown message type: ${type}`);
}
```

#### 2. Wait for Complete Header

**Actor**: Transport

```javascript
// Check if we have complete header
if (inputBuffer.length < headerSize) {
  // Wait for more data
  return null;
}

// We have complete header, proceed with decoding
```

**State**:
- Input buffer contains at least `headerSize` bytes
- Ready to decode header fields

#### 3. Decode ACK Header Fields

**Actor**: Protocol Layer

```javascript
import { decodeHeader } from './protocol.esm.js';

const header = decodeHeader(inputBuffer);
// header = {
//   type: 0,              // HDR_TYPE_ACK
//   headerSize: 16,       // Total header bytes
//   flags: 0,             // No flags defined for ACKs
//   channelId: 42,        // Channel ID
//   baseSequence: 5,      // Base sequence (ACK'd independently)
//   rangeCount: 3,        // Number of range bytes
//   ranges: [3, 1, 2]     // +3 after base, skip 1, +2
// }
```

**Decoding Details** (protocol.esm.js:278-307):

**Byte-by-byte extraction**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          0 (HDR_TYPE_ACK)
1       1B    Encoded remaining    6 (decode: (6<<1)+4 = 16)
2       2B    Flags                0x0000
4       4B    Channel ID           42
8       4B    Base sequence        5
12      1B    Range count          3
13      1B    Range[0] (include)   3 (+3 after base: 6-8)
14      1B    Range[1] (skip)      1 (skip 9)
15      1B    Range[2] (include)   2 (+2: 10-11)
Total: 16 bytes
```

**Implementation**:
```javascript
function decodeAckHeaderFrom (buffer, offset) {
  const headerSize = decodeHeaderSizeFromPrefix(buffer, offset);
  const length = buffer.length || buffer.byteLength;
  if (headerSize === null || length - offset < headerSize) {
    throw new Error('Buffer too small for ACK header');
  }

  let o = offset;
  const type = buffer.getUint8(o++);
  const sizeByte = buffer.getUint8(o++);
  const flags = buffer.getUint16(o); o += 2;
  const channelId = buffer.getUint32(o); o += 4;
  const baseSequence = buffer.getUint32(o); o += 4;
  const rangeCount = buffer.getUint8(o++);

  const ranges = [];
  for (let i = 0; i < rangeCount; i++) {
    ranges.push(buffer.getUint8(o++));
  }

  return {
    type,
    headerSize: encAddlToTotal(sizeByte),
    flags,
    channelId,
    baseSequence,
    rangeCount,
    ranges
  };
}
```

#### 4. Interpret ACK Ranges

**Actor**: Application/Transport

```javascript
// Interpret ranges: base is independent, ranges describe sequences after base
// header.baseSequence = 5
// header.ranges = [3, 1, 2]

// Interpretation:
// - Base 5: ACK sequence 5 (independent)
// - +3: ACK sequences 6, 7, 8 (3 sequences after base)
// - Skip 1: Skip sequence 9
// - +2: ACK sequences 10, 11 (2 sequences)
// Total ACK'd: 5, 6, 7, 8, 10, 11
```

**Critical**: The base sequence is **independent** - it is ACK'd on its own. The first range **never includes the base**. The ranges describe sequences **after** the base.

#### 5. Process ACK (Restore Budget)

**Actor**: ChannelFlowControl

```javascript
// Get channel for this ACK
const channel = transport.getChannel(header.channelId);
const flowControl = channel.flowControl;

// Process ACK to restore budget
const bytesFreed = flowControl.processAck(
  header.baseSequence,
  header.ranges
);

// bytesFreed = total bytes freed from in-flight map
// Budget automatically restored for future writes
```

**State**:
- In-flight chunks removed from tracking map
- Sending budget increased by `bytesFreed`
- Waiting writes may be unblocked

#### 6. Consume Header Bytes

**Actor**: Transport

```javascript
// Remove header from input buffer
inputBuffer.consume(header.headerSize);
// or advance read pointer by header.headerSize
```

**State**:
- Header bytes consumed from input buffer
- Buffer ready for next message
- ACK processing complete (no data payload)

### ACK Message Characteristics

**Transport-Level Message**:
- ACKs are transport-level, not channel-level
- Do NOT count toward channel budget
- Do NOT count toward transport budget (fire-and-forget)
- No data payload (header only)

**No ACK-on-ACK**:
- ACKs are not acknowledged by remote
- Receiver does not send ACK for received ACKs
- Simpler protocol, no infinite ACK loops

**Budget Restoration**:
- ACKs restore channel budget on sender side (local)
- ACKs restore transport budget on sender side (local)
- Receiver processes ACK to free in-flight tracking

## Scenario 2: Channel Control Message Decoding

### Initial State

- Transport receives bytes from network/pipe/worker
- Bytes buffered in input buffer (VirtualBuffer)
- At least 2 bytes available (header type + size byte)

### Step-by-Step Flow

#### 1. Determine Header Size

**Actor**: Protocol Layer

```javascript
import { decodeHeaderSizeFromPrefix, HDR_TYPE_CHAN_CONTROL } from './protocol.esm.js';

const headerSize = decodeHeaderSizeFromPrefix(inputBuffer, 0);
// headerSize = 18 (always for channel messages)
```

**State**:
- `headerSize` = 18 bytes (DATA_HEADER_BYTES)
- Fixed size for all channel messages

#### 2. Wait for Complete Header

**Actor**: Transport

```javascript
if (inputBuffer.length < headerSize) {
  // Wait for more data
  return null;
}
```

**State**:
- Input buffer contains at least 18 bytes
- Ready to decode header fields

#### 3. Decode Channel Control Header

**Actor**: Protocol Layer

```javascript
const header = decodeHeader(inputBuffer);
// header = {
//   type: 1,                    // HDR_TYPE_CHAN_CONTROL
//   headerSize: 18,             // Total header bytes
//   dataSize: 45,               // Payload size in bytes
//   flags: 0x0001,              // FLAG_EOM (control messages always single-chunk)
//   channelId: 42,              // Channel ID
//   sequence: 7,                // Remote sequence number
//   messageTypeId: 3,           // TCC_CTLM_MESG_TYPE_REG_REQ (numeric ID)
//   messageType: 'mesgTypeReq', // Registered name (if mapped)
//   eom: true                   // Convenience flag (derived from flags)
// }
```

**Decoding Details** (protocol.esm.js:316-342):

**Byte-by-byte extraction**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          1 (HDR_TYPE_CHAN_CONTROL)
1       1B    Encoded remaining    7 (always for 18-byte header)
2       4B    Data size            45
6       2B    Flags                0x0001 (FLAG_EOM)
8       4B    Channel ID           42
12      4B    Sequence             7
16      2B    Message type         3 (TCC_CTLM_MESG_TYPE_REG_REQ)
Total: 18 bytes (DATA_HEADER_BYTES)
```

**Implementation**:
```javascript
function decodeChannelHeaderFrom (buffer, offset) {
  const length = buffer.length || buffer.byteLength;
  if (length - offset < DATA_HEADER_BYTES) {
    throw new Error('Buffer too small for channel header');
  }

  let o = offset;
  const type = buffer.getUint8(o++);
  o++;  // Skip size byte (always 7 for channel headers)
  
  const dataSize = buffer.getUint32(o); o += 4;
  const flags = buffer.getUint16(o); o += 2;
  const channelId = buffer.getUint32(o); o += 4;
  const sequence = buffer.getUint32(o); o += 4;
  const messageTypeId = buffer.getUint16(o); o += 2;

  // Look up registered message type name (if mapped)
  const channel = transport.getChannel(channelId);
  const messageType = channel?.getMessageTypeName(messageTypeId);

  return {
    type,
    headerSize: DATA_HEADER_BYTES,
    dataSize,
    flags,
    channelId,
    sequence,
    messageTypeId,
    messageType,  // String name (if registered), otherwise undefined
    eom: (flags & FLAG_EOM) !== 0
  };
}
```

#### 4. Wait for Complete Data Payload

**Actor**: Transport

```javascript
const totalBytes = header.headerSize + header.dataSize;
if (inputBuffer.length < totalBytes) {
  // Wait for more data
  return null;
}
```

**State**:
- Input buffer contains complete message (header + data)
- Ready to extract data payload

#### 5. Extract Data Payload

**Actor**: Transport

```javascript
// Extract data payload (zero-copy slice)
const dataPayload = inputBuffer.slice(
  header.headerSize,
  header.headerSize + header.dataSize
);

// dataPayload is VirtualBuffer view (zero-copy)
// Can be decoded as string, JSON, SLID, or kept as binary
```

**State**:
- `dataPayload` is VirtualBuffer view of data bytes
- Zero-copy extraction (no allocation)
- Original buffer unchanged

#### 6. Validate Sequence Number

**Actor**: ChannelFlowControl

```javascript
// Get channel for this message
const channel = transport.getChannel(header.channelId);
const flowControl = channel.flowControl;

// Validate sequence number (must be consecutive)
try {
  flowControl.recordReceived(header.sequence, totalBytes);
} catch (err) {
  if (err.name === 'ProtocolViolationError') {
    // Out-of-order or over-budget
    transport.emit('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: header.channelId
    });
    // Handler decides action (close channel, close transport, etc.)
    return;
  }
  throw err;
}
```

**State**:
- Sequence validated (must be consecutive)
- Buffer usage updated
- Protocol violations detected and reported

#### 7. Decode Data Payload (Application)

**Actor**: Application

```javascript
// Control messages are typically JSON
const jsonString = dataPayload.decode({ label: 'utf-8' });
const controlData = JSON.parse(jsonString);

// Example: Message-type registration request
// controlData = { request: ['userAction', 'systemEvent'] }
```

**State**:
- Data payload decoded to application format
- Ready for processing

#### 8. Process Control Message

**Actor**: Channel

```javascript
// Process based on message type ID
switch (header.messageTypeId) {
  case TCC_CTLM_MESG_TYPE_REG_REQ:
    // Handle message-type registration request
    await handleMessageTypeRegistration(controlData);
    break;
  
  case TCC_CTLM_MESG_TYPE_REG_RESP:
    // Handle message-type registration response
    await handleMessageTypeResponse(controlData);
    break;
  
  // ... other control message types
}

// Or use string name if preferred:
if (header.messageType === 'mesgTypeReq') {
  await handleMessageTypeRegistration(controlData);
}
```

**State**:
- Control message processed
- Channel state updated as needed

#### 9. Mark Chunk as Consumed

**Actor**: ChannelFlowControl

```javascript
// Mark chunk as consumed (application finished processing)
flowControl.recordConsumed(header.sequence);

// Check if ACK should be generated
if (flowControl.bufferUsed < lowBufferBytes) {
  const ackInfo = flowControl.getAckInfo();
  if (ackInfo) {
    // Generate and send ACK
    await sendAck(header.channelId, ackInfo);
  }
}
```

**State**:
- Chunk marked as consumed
- Buffer usage decreased
- ACK generated if below low-water mark

#### 10. Consume Message Bytes

**Actor**: Transport

```javascript
// Remove message from input buffer
inputBuffer.consume(totalBytes);
// or advance read pointer by totalBytes
```

**State**:
- Message bytes consumed from input buffer
- Buffer ready for next message

### Channel Control Message Characteristics

**Channel-Level Message**:
- Control messages count toward channel budget
- Control messages count toward transport budget
- Must be ACK'd by receiver (budget restoration)

**Always Single-Chunk**:
- Control messages always have EOM flag set
- No multi-chunk control messages
- Simplifies control message processing

**Message Types** (for filtering):
- 3: TCC_CTLM_MESG_TYPE_REG_REQ (message-type registration request)
- 4: TCC_CTLM_MESG_TYPE_REG_RESP (message-type registration response)
- Additional types as needed

## Scenario 3: Channel Data Message Decoding

### Initial State

- Transport receives bytes from network/pipe/worker
- Bytes buffered in input buffer (VirtualBuffer)
- May be single-chunk or multi-chunk message

### Step-by-Step Flow

#### 1. Determine Header Size

**Actor**: Protocol Layer

```javascript
const headerSize = decodeHeaderSizeFromPrefix(inputBuffer, 0);
// headerSize = 18 (always for channel messages)
```

**State**:
- `headerSize` = 18 bytes (DATA_HEADER_BYTES)

#### 2. Wait for Complete Header

**Actor**: Transport

```javascript
if (inputBuffer.length < headerSize) {
  return null;  // Wait for more data
}
```

#### 3. Decode Channel Data Header

**Actor**: Protocol Layer

```javascript
const header = decodeHeader(inputBuffer);
// header = {
//   type: 2,                    // HDR_TYPE_CHAN_DATA
//   headerSize: 18,             // Total header bytes
//   dataSize: 1024,             // Payload size in bytes
//   flags: 0x0000,              // No EOM (intermediate chunk)
//   channelId: 42,              // Channel ID
//   sequence: 8,                // Remote sequence number
//   messageTypeId: 1024,        // User-defined message type ID (numeric)
//   messageType: 'userMessage', // Registered name (if mapped)
//   eom: false                  // Not end of message
// }
```

**Decoding Details**:

**Byte-by-byte extraction**:
```
Offset  Size  Field                Value (example)
------  ----  -------------------  ---------------
0       1B    Header type          2 (HDR_TYPE_CHAN_DATA)
1       1B    Encoded remaining    7 (always for 18-byte header)
2       4B    Data size            1024
6       2B    Flags                0x0000 (no EOM)
8       4B    Channel ID           42
12      4B    Sequence             8
16      2B    Message type         1024 (for filtering)
Total: 18 bytes (DATA_HEADER_BYTES)
```

#### 4. Wait for Complete Data Payload

**Actor**: Transport

```javascript
const totalBytes = header.headerSize + header.dataSize;
if (inputBuffer.length < totalBytes) {
  return null;  // Wait for more data
}
```

#### 5. Extract Data Payload

**Actor**: Transport

```javascript
// Extract data payload (zero-copy slice)
const dataPayload = inputBuffer.slice(
  header.headerSize,
  header.headerSize + header.dataSize
);
```

**State**:
- `dataPayload` is VirtualBuffer view (zero-copy)
- No allocation or copying

#### 6. Validate Sequence Number

**Actor**: ChannelFlowControl

```javascript
const channel = transport.getChannel(header.channelId);
const flowControl = channel.flowControl;

try {
  flowControl.recordReceived(header.sequence, totalBytes);
} catch (err) {
  if (err.name === 'ProtocolViolationError') {
    transport.emit('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: header.channelId
    });
    return;
  }
  throw err;
}
```

**State**:
- Sequence validated (consecutive)
- Buffer usage updated
- Protocol violations detected

#### 7. Queue Chunk for Application

**Actor**: Channel

```javascript
// Queue chunk for application consumption
channel.queueChunk({
  sequence: header.sequence,
  messageTypeId: header.messageTypeId,
  messageType: header.messageType,  // String name (if registered)
  data: dataPayload,
  eom: header.eom,
  totalBytes: totalBytes
});

// Wake any waiting readers
channel.notifyReaders();
```

**State**:
- Chunk queued in channel buffer
- Readers notified of new data
- Application can read chunk

#### 8. Application Reads Chunk

**Actor**: Application

```javascript
// Read chunk (may filter by message type ID or name)
const chunk = await channel.read({ only: 1024 });  // Filter by ID
// or
const chunk = await channel.read({ only: 'userMessage' });  // Filter by name

// chunk = {
//   data: VirtualBuffer,
//   eom: false,
//   messageTypeId: 1024,
//   messageType: 'userMessage',  // String name (if registered)
//   process: async (fn) => { ... },
//   done: () => { ... }
// }

// Process chunk data
await chunk.process(async (data) => {
  // Decode and process data
  const text = data.decode({ label: 'utf-8' });
  console.log('Received:', text);
});

// Mark chunk as done (triggers consumption)
chunk.done();
```

**State**:
- Chunk data processed by application
- Chunk marked as consumed
- Buffer usage decreased

#### 9. Generate ACK (If Needed)

**Actor**: ChannelFlowControl

```javascript
// Check if ACK should be generated
if (flowControl.bufferUsed < lowBufferBytes) {
  const ackInfo = flowControl.getAckInfo();
  if (ackInfo) {
    await sendAck(header.channelId, ackInfo);
  }
}
```

**State**:
- ACK generated if below low-water mark
- Remote's budget will be restored

#### 10. Consume Message Bytes

**Actor**: Transport

```javascript
// Remove message from input buffer
inputBuffer.consume(totalBytes);
```

**State**:
- Message bytes consumed from input buffer
- Buffer ready for next message

### Channel Data Message Characteristics

**Channel-Level Message**:
- Data messages count toward channel budget
- Data messages count toward transport budget
- Must be ACK'd by receiver (budget restoration)

**Multi-Chunk Support**:
- Large messages split into multiple chunks
- EOM flag only on last chunk
- Intermediate chunks have no EOM flag
- All chunks have same message type (for filtering)

**Message Type Filtering**:
- Application can filter by message type ID (numeric) or message type (string name)
- `channel.read({ only: 1024 })` waits for specific ID
- `channel.read({ only: 'userMessage' })` waits for specific name
- Enables multiplexing different message streams on same channel

## Scenario 4: Multi-Chunk Message Decoding

### Initial State

- Application expects multi-chunk message
- First chunk already received (no EOM flag)
- Subsequent chunks arriving

### Step-by-Step Flow

#### 1. Decode First Chunk

**Actor**: Transport/Channel

```javascript
// Decode first chunk (as in Scenario 3)
const chunk1 = decodeHeader(inputBuffer);
// chunk1.eom = false (intermediate chunk)
// chunk1.sequence = 8
// chunk1.messageTypeId = 1024
// chunk1.messageType = 'userMessage'
```

**State**:
- First chunk decoded and queued
- Application can start processing
- More chunks expected (no EOM)

#### 2. Application Reads First Chunk

**Actor**: Application

```javascript
const chunk = await channel.read({ only: 1024 });  // Filter by ID
// or
const chunk = await channel.read({ only: 'userMessage' });  // Filter by name
// chunk.eom = false (more chunks coming)

await chunk.process(async (data) => {
  // Process first chunk
  // May accumulate in buffer or stream to output
});

chunk.done();
```

**State**:
- First chunk processed
- Application knows more chunks coming (no EOM)
- May accumulate or stream

#### 3. Decode Subsequent Chunks

**Actor**: Transport/Channel

```javascript
// Decode second chunk
const chunk2 = decodeHeader(inputBuffer);
// chunk2.eom = false (still intermediate)
// chunk2.sequence = 9 (consecutive)
// chunk2.messageTypeId = 1024 (same as first)
// chunk2.messageType = 'userMessage' (same as first)

// Decode third chunk
const chunk3 = decodeHeader(inputBuffer);
// chunk3.eom = true (last chunk)
// chunk3.sequence = 10 (consecutive)
// chunk3.messageTypeId = 1024 (same as first)
// chunk3.messageType = 'userMessage' (same as first)
```

**State**:
- All chunks decoded and queued
- Sequences validated (consecutive)
- Last chunk has EOM flag

#### 4. Application Reads Remaining Chunks

**Actor**: Application

```javascript
// Read second chunk
const chunk2 = await channel.read({ only: 1024 });
await chunk2.process(async (data) => {
  // Process second chunk
});
chunk2.done();

// Read third chunk (last)
const chunk3 = await channel.read({ only: 1024 });
// chunk3.eom = true (end of message)

await chunk3.process(async (data) => {
  // Process last chunk
  // Message complete
});
chunk3.done();
```

**State**:
- All chunks processed
- Message complete (EOM detected)
- Application can finalize processing

#### 5. Generate ACKs

**Actor**: ChannelFlowControl

```javascript
// ACKs generated as chunks consumed
// May batch multiple chunks in single ACK

// After chunk 1 consumed:
// ackInfo = { baseSeq: 8, ranges: [] }

// After chunk 3 consumed:
// ackInfo = { baseSeq: 10, ranges: [] }
// (or batched: { baseSeq: 8, ranges: [2] } for 8-10)
```

**State**:
- ACKs sent to restore remote's budget
- Remote can send more data

### Multi-Chunk Message Characteristics

**Chunk Ordering**:
- Chunks must arrive in sequence order
- Out-of-order is protocol violation
- ChannelFlowControl validates sequences

**EOM Flag**:
- Only last chunk has EOM flag
- Intermediate chunks have no EOM
- Application uses EOM to detect message boundaries

**Message Type Consistency**:
- All chunks have same message type
- Enables filtering entire message
- Simplifies application logic

**Streaming vs Buffering**:
- **Streaming**: Process each chunk as received (memory efficient)
- **Buffering**: Accumulate chunks until EOM (simpler logic)
- Application chooses strategy based on needs

## Incremental Decoding

### Handling Partial Headers

**Actor**: Transport

```javascript
// Receive partial data
const bytesReceived = await transport.receive(inputBuffer);

// Try to decode header
const headerSize = decodeHeaderSizeFromPrefix(inputBuffer, 0);
if (headerSize === null) {
  // Not enough bytes for header size determination
  // Wait for more data
  return null;
}

if (inputBuffer.length < headerSize) {
  // Not enough bytes for complete header
  // Wait for more data
  return null;
}

// Complete header available, decode it
const header = decodeHeader(inputBuffer);
```

**State**:
- Partial data buffered
- Waiting for more bytes
- No allocation or copying

### Handling Partial Data Payloads

**Actor**: Transport

```javascript
// Have complete header, check for complete data
const totalBytes = header.headerSize + header.dataSize;
if (inputBuffer.length < totalBytes) {
  // Not enough bytes for complete message
  // Wait for more data
  return null;
}

// Complete message available, extract it
const dataPayload = inputBuffer.slice(
  header.headerSize,
  header.headerSize + header.dataSize
);
```

**State**:
- Partial message buffered
- Waiting for more bytes
- Zero-copy extraction when complete

### Buffer Management

**Actor**: Transport

```javascript
// Input buffer grows as data arrives
// Consume messages as they're decoded

while (inputBuffer.length >= 2) {
  // Try to decode next message
  const message = decodeNextMessage(inputBuffer);
  if (!message) {
    // Incomplete message, wait for more data
    break;
  }
  
  // Process message
  await processMessage(message);
  
  // Consume message bytes
  inputBuffer.consume(message.totalBytes);
}
```

**State**:
- Buffer contains only incomplete message
- Efficient memory usage
- No wasted space

## Integration Points

### With VirtualBuffer

```javascript
// Zero-copy decoding from VirtualBuffer
const header = decodeHeader(virtualBuffer);

// Zero-copy data extraction
const dataPayload = virtualBuffer.slice(
  header.headerSize,
  header.headerSize + header.dataSize
);

// Decode string data
const text = dataPayload.decode({ label: 'utf-8' });
```

### With ChannelFlowControl

```javascript
// Validate sequence number
flowControl.recordReceived(header.sequence, totalBytes);

// Mark chunk as consumed
flowControl.recordConsumed(header.sequence);

// Generate ACK information
const ackInfo = flowControl.getAckInfo();
```

### With Transport

```javascript
// Receive data into buffer
const bytesReceived = await transport.receive(inputBuffer);

// Decode messages
while (inputBuffer.length >= 2) {
  const message = decodeNextMessage(inputBuffer);
  if (!message) break;
  
  await processMessage(message);
  inputBuffer.consume(message.totalBytes);
}
```

## Protocol Validation

### Invalid Header Type

```javascript
try {
  const header = decodeHeader(inputBuffer);
} catch (err) {
  if (err.message.includes('Unknown message type')) {
    // Invalid header type (not 0, 1, or 2)
    transport.emit('protocolViolation', {
      reason: 'InvalidHeaderType',
      details: { type: inputBuffer.getUint8(0) }
    });
    // Handler decides action
  }
}
```

### Out-of-Order Sequence

```javascript
try {
  flowControl.recordReceived(header.sequence, totalBytes);
} catch (err) {
  if (err.reason === 'OutOfOrder') {
    // Sequence not consecutive
    transport.emit('protocolViolation', {
      reason: 'OutOfOrder',
      details: err.details,
      channelId: header.channelId
    });
  }
}
```

### Over-Budget Chunk

```javascript
try {
  flowControl.recordReceived(header.sequence, totalBytes);
} catch (err) {
  if (err.reason === 'OverBudget') {
    // Chunk exceeds available buffer
    transport.emit('protocolViolation', {
      reason: 'OverBudget',
      details: err.details,
      channelId: header.channelId
    });
  }
}
```

## Key Takeaways

1. **Incremental Decoding**: Handles partial headers and data (streaming input)
2. **Three Header Types**: ACK (0), channel control (1), channel data (2) - first byte determines parsing
3. **Message Types**: Field in channel headers (offset 16) for reader filtering
4. **Remaining Size Decoding**: Converts encoded size byte to total bytes: `(sizeByte << 1) + 4`
5. **Zero-Copy Extraction**: VirtualBuffer slices for data payloads (no allocation)
6. **Sequence Validation**: ChannelFlowControl validates consecutive sequences
7. **Protocol Violations**: Detected and reported via events (application decides action)
8. **ACK Processing**: Restores budget on sender side (local)
9. **Multi-Chunk Messages**: EOM flag only on last chunk, intermediate chunks have no EOM
10. **Message Type Filtering**: Application can filter by message type for multiplexing
11. **Streaming vs Buffering**: Application chooses strategy based on needs
12. **Buffer Management**: Consume messages as decoded, efficient memory usage

## Related Scenarios

- [`message-encoding.md`](message-encoding.md) - Message encoding (inverse of decoding)
- [`virtual-buffer-operations.md`](virtual-buffer-operations.md) - VirtualBuffer read operations used for decoding
- [`simple-read.md`](simple-read.md) - Single-chunk read flow using decoding
- [`streaming-read.md`](streaming-read.md) - Multi-chunk read flow with decoding
- [`ack-generation-processing.md`](ack-generation-processing.md) - ACK processing after decoding
- [`receive-flow-control.md`](receive-flow-control.md) - Flow control integration with decoding
- [`protocol-violation.md`](protocol-violation.md) - Protocol violation detection during decoding
