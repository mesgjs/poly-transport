# Streaming Read Scenario (Multi-Chunk Messages)

## Overview

This scenario documents the process of reading a multi-chunk message from a channel. It covers the complete flow from the user calling [`channel.read()`](../../src/channel.esm.js) multiple times to assemble a complete message, processing chunks as they arrive, and generating ACKs to restore the sender's budget.

**Key Point**: [`channel.read()`](../../src/channel.esm.js) returns chunks one at a time. The user is responsible for detecting end-of-message (EOM) and assembling chunks into complete messages if needed. The channel handles all buffer management, sequence validation, and ACK generation automatically.

**Streaming Strategy**: Users can process chunks as they arrive (streaming) or assemble them into complete messages (buffering). The choice depends on the application's needs.

## Preconditions

- Transport is started and connected
- Channel is open (bidirectional)
- Remote has sent (or will send) a multi-chunk message

**Note**: Channel automatically handles buffer management and ACK generation - no preconditions required from user.

## Actors

- **User Code**: Calls [`channel.read()`](../../src/channel.esm.js) multiple times to read chunks
- **Channel**: Orchestrates entire read operation, handles all complexity
- **ChannelFlowControl**: Validates sequence order, tracks received chunks, generates ACK information
- **VirtualBuffer**: Provides zero-copy view of received data
- **Protocol**: Decodes message headers
- **Transport**: Receives data from remote, sends ACKs back

## Step-by-Step Sequence

### 1. User Initiates First Read

**Action**: User calls `await channel.read({ timeout, only })` to read first chunk

**Parameters**:
- `timeout`: Maximum time to wait for data (milliseconds)
- `only`: Optional message type filter (number, string, array, or Set)

**Responsible Module**: User code

**Example**:
```javascript
// Read first chunk of message
const chunk1 = await channel.read({ timeout: 5000, only: 'largeFile' });
console.log('Chunk 1:', chunk1.type, 'EOM:', chunk1.eom, 'Size:', chunk1.data.length);

// Check if message is complete
if (chunk1.eom) {
  console.log('Single-chunk message');
  // Process complete message
  await chunk1.process(async (chunk) => {
    const data = chunk.data.decode();
    console.log('Complete message:', data);
  });
} else {
  console.log('Multi-chunk message, reading more...');
  // Continue reading chunks (see below)
}
```

**Note**: This scenario focuses on multi-chunk messages. For single-chunk, see [`simple-read.md`](simple-read.md).

### 2. Channel Delivers First Chunk

**Action**: Channel delivers first chunk to user (same as simple-read scenario)

**Logic**:
- Validate state (channel must be open or closing)
- Check for duplicate readers
- Register reader
- Check receive buffer for matching chunk
- If not available, wait for incoming chunk
- Validate and record received chunk (sequence order, budget)
- Add chunk to receive buffer (if not delivered immediately)
- Return chunk to user

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Returns**: Chunk object `{ seq, type, eom, data, process, done }`
- `eom: false` (not end-of-message, more chunks to follow)

**Note**: See [`simple-read.md`](simple-read.md) for detailed steps.

### 3. User Checks EOM Flag

**Action**: User checks if message is complete

**Logic**:
- Check `chunk.eom` flag
- If `eom: true`, message is complete (single-chunk, skip to step 10)
- If `eom: false`, more chunks to follow (continue to step 4)

**Responsible Module**: User code

**Example**:
```javascript
if (chunk.eom) {
  // Single-chunk message, process immediately
  await chunk.process(async (chunk) => {
    processCompleteMessage(chunk.data);
  });
} else {
  // Multi-chunk message, continue reading
  const chunks = [chunk];
  while (!chunk.eom) {
    chunk = await channel.read({ timeout: 5000, only: chunk.type });
    chunks.push(chunk);
  }
  // Process complete message (see step 10)
}
```

**Note**: User must check EOM flag to detect multi-chunk messages.

### 4. User Decides Processing Strategy

**Action**: User chooses streaming or buffering strategy

**Strategies**:

**Streaming (Process Each Chunk Immediately)**:
- Process each chunk as it arrives
- Minimal memory usage
- Suitable for large messages (e.g., video streaming, file downloads)
- Cannot reassemble complete message (chunks processed independently)

**Buffering (Assemble Complete Message)**:
- Store chunks until EOM received
- Assemble into complete message
- Higher memory usage
- Suitable for messages that need complete data (e.g., JSON, images)

**Responsible Module**: User code

**Example (Streaming)**:
```javascript
// Process each chunk immediately (streaming)
let chunk = await channel.read({ timeout: 5000, only: 'video' });
while (true) {
  await chunk.process(async (c) => {
    // Process chunk data immediately
    videoPlayer.appendChunk(c.data.toUint8Array());
  });
  
  if (chunk.eom) break;
  chunk = await channel.read({ timeout: 5000, only: 'video' });
}
```

**Example (Buffering)**:
```javascript
// Assemble complete message (buffering)
const chunks = [];
let chunk = await channel.read({ timeout: 5000, only: 'json' });
while (true) {
  chunks.push(chunk);
  if (chunk.eom) break;
  chunk = await channel.read({ timeout: 5000, only: 'json' });
}

// Assemble and process complete message
const totalLength = chunks.reduce((sum, c) => sum + c.data.length, 0);
const completeData = new Uint8Array(totalLength);
let offset = 0;
for (const c of chunks) {
  completeData.set(c.data.toUint8Array(), offset);
  offset += c.data.length;
  c.done();  // Mark chunk as consumed
}

const json = new TextDecoder().decode(completeData);
const obj = JSON.parse(json);
console.log('Complete message:', obj);
```

**Note**: Choice depends on application needs and message characteristics. Application designers should be aware that buffering large messages (compared to channel buffer size) or multiple types is likely to lead to channel deadlock.

### 5. User Initiates Subsequent Reads (Loop)

**Action**: User calls `await channel.read()` repeatedly until EOM

**Logic**:
- Loop until `chunk.eom === true`
- Each iteration reads one chunk
- Same message type filter (to avoid reading chunks from other messages)
- Same timeout for each chunk

**Responsible Module**: User code

**Example**:
```javascript
const chunks = [firstChunk];
let chunk = firstChunk;

while (!chunk.eom) {
  // Read next chunk (same message type)
  chunk = await channel.read({ timeout: 5000, only: chunk.type });
  chunks.push(chunk);
}

console.log(`Received ${chunks.length} chunks total`);
```

**Note**: User must continue reading until EOM flag is set.

### 6. Channel Delivers Subsequent Chunks

**Action**: Channel delivers each subsequent chunk (same as first chunk)

**Logic**:
- Same process as first chunk (see step 2)
- Validate state, check for duplicate readers, register reader
- Check receive buffer or wait for incoming chunk
- Validate and record received chunk (sequence order, budget)
- Return chunk to user

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Returns**: Chunk object `{ seq, type, eom, data, process, done }`
- `eom: false` for intermediate chunks
- `eom: true` for final chunk

**Note**: Each chunk is delivered independently, one at a time.

### 7. User Processes Chunks (Streaming or Buffering)

**Action**: User processes chunks according to chosen strategy

**Streaming Strategy**:
```javascript
// Process each chunk immediately
while (true) {
  const chunk = await channel.read({ timeout: 5000, only: 'stream' });
  
  await chunk.process(async (c) => {
    // Process chunk data immediately
    await processChunkData(c.data);
  });
  
  if (chunk.eom) break;
}
```

**Buffering Strategy**:
```javascript
// Collect all chunks first
const chunks = [];
let chunk = await channel.read({ timeout: 5000, only: 'buffer' });

while (true) {
  chunks.push(chunk);
  if (chunk.eom) break;
  chunk = await channel.read({ timeout: 5000, only: 'buffer' });
}

// Assemble complete message
const completeMessage = assembleChunks(chunks);

// Mark all chunks as consumed
for (const c of chunks) {
  c.done();
}

// Process complete message
await processCompleteMessage(completeMessage);
```

**Responsible Module**: User code

**Note**: Streaming processes chunks immediately, buffering waits for complete message.

### 8. Mark Chunks as Consumed

**Action**: User indicates chunks have been completely processed

**Logic**:
- **Streaming**: Call `chunk.process()` for each chunk (automatic)
- **Buffering**: Call `chunk.done()` for each chunk after assembling complete message
- Each call marks chunk as consumed in flow control
- Chunks remain tracked until ACK is sent

**Responsible Module**: User code, [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Example (Streaming)**:
```javascript
// Automatic consumption via process()
await chunk.process(async (c) => {
  await processChunkData(c.data);
});
// Chunk automatically marked consumed after callback completes
```

**Example (Buffering)**:
```javascript
// Manual consumption via done()
for (const chunk of chunks) {
  chunk.done();  // Mark each chunk as consumed
}
```

**Note**: Streaming uses `process()` (automatic), buffering uses `done()` (manual).

### 9. Generate and Send ACKs (Periodically)

**Action**: Channel generates and sends ACKs as buffer usage drops

**Logic**:
- After each chunk consumed, check buffer usage
- If `bufferUsed < lowBufferBytes`, generate ACK
- Call [`flowControl.getAckInfo()`](../../src/channel-flow-control.esm.js)
- Encode and send ACK to remote
- Clear ACK'd chunks from tracking

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`ChannelFlowControl`](../../src/channel-flow-control.esm.js), [`Transport`](../../src/transport/base.esm.js)

**Data Structures**:
- ACK info: `{ baseSeq, ranges }` (range-based acknowledgment)
- ACK header (13 bytes + variable ranges, up to 514 bytes total)

**Note**: ACKs are batched and sent periodically (not for every chunk).

### 10. User Processes Complete Message (Buffering Only)

**Action**: User processes assembled complete message

**Logic**:
- Assemble chunks into complete message (concatenate data)
- Decode or parse complete message (e.g., JSON, image, video)
- Process complete message
- Mark all chunks as consumed (call `done()` for each)

**Responsible Module**: User code

**Example**:
```javascript
// Assemble chunks into complete Uint8Array
const totalLength = chunks.reduce((sum, c) => sum + c.data.length, 0);
const completeData = new Uint8Array(totalLength);
let offset = 0;
for (const chunk of chunks) {
  completeData.set(chunk.data.toUint8Array(), offset);
  offset += chunk.data.length;
}

// Decode complete message
const text = new TextDecoder().decode(completeData);
const json = JSON.parse(text);

// Process complete message
console.log('Complete message:', json);

// Mark all chunks as consumed
for (const chunk of chunks) {
  chunk.done();
}
```

**Note**: Streaming strategy doesn't have this step (chunks processed immediately).

## Postconditions

- User has received and processed all chunks of message
- All chunks marked as consumed in flow control
- ACKs generated and sent to remote (periodically as buffer usage drops)
- Remote's sending budget restored (after receiving ACKs)
- Buffer space freed for new incoming chunks

**Note**: ACK generation and sending happen asynchronously, not during `read()` calls.

## Error Conditions

### StateError
- **Cause**: Channel is `closed`
- **Handling**: Throw `StateError`, user must handle
- **Recovery**: Reopen channel or create new channel

### Duplicate Reader Error
- **Cause**: Conflicting concurrent readers (overlapping filters or unfiltered)
- **Handling**: Throw `Error` (was `DuplicateReaderError`)
- **Recovery**: Wait for previous read to complete, then retry

### TimeoutError
- **Cause**: Timeout expired before next chunk arrived
- **Handling**: Throw `TimeoutError`, user must handle
- **Recovery**: Retry read with longer timeout or abandon message

### Protocol Violation (Out-of-Order)
- **Cause**: Received chunk with seq !== nextExpectedSeq
- **Handling**: `ProtocolViolationError` thrown by [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)
- **Recovery**: Transport emits `protocolViolation` event, may close channel/transport

### Protocol Violation (Over-Budget)
- **Cause**: Received chunk exceeds available buffer space
- **Handling**: `ProtocolViolationError` thrown by [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)
- **Recovery**: Transport emits `protocolViolation` event, may close channel/transport

### Incomplete Message (Connection Lost)
- **Cause**: Connection lost before EOM received
- **Handling**: User detects missing EOM, handles gracefully
- **Recovery**: Retry request or report error to user

**Note**: Protocol violations are serious errors that typically result in channel/transport closure.

## Related Scenarios

- [`simple-read.md`](simple-read.md) - Reading single-chunk messages
- [`simple-write.md`](simple-write.md) - Writing single-chunk messages
- [`multi-chunk-write.md`](multi-chunk-write.md) - Writing large messages (automatic chunking)
- [`receive-flow-control.md`](receive-flow-control.md) - Detailed receive flow control logic
- [`ack-generation-processing.md`](ack-generation-processing.md) - How ACKs are generated and processed
- [`message-decoding.md`](message-decoding.md) - Protocol decoding details

## Implementation Notes

### User-Facing Simplicity

**Critical Design Principle**: [`channel.read()`](../../src/channel.esm.js) handles ALL complexity internally:
- ✅ Automatic buffer management
- ✅ Automatic sequence validation
- ✅ Automatic budget tracking
- ✅ Automatic ACK generation (periodically as buffer usage drops)
- ✅ Automatic protocol violation detection
- ✅ Automatic message type filtering
- ✅ Automatic duplicate reader prevention

**User Responsibility**: 
- Call `read()` repeatedly until EOM
- Choose streaming or buffering strategy
- Process chunks or assemble complete message
- Mark chunks as consumed (via `process()` or `done()`)

### Streaming vs Buffering Trade-offs

**Streaming (Process Each Chunk Immediately)**:
- **Pros**:
  - Minimal memory usage (only one chunk in memory at a time)
  - Lower latency (process data as it arrives)
  - Suitable for large messages (e.g., video, file downloads)
- **Cons**:
  - Cannot reassemble complete message
  - Must process chunks independently
  - More complex application logic

**Buffering (Assemble Complete Message)**:
- **Pros**:
  - Simpler application logic (process complete message)
  - Can parse/decode complete message (e.g., JSON, image)
  - Easier error handling (retry complete message)
- **Cons**:
  - Higher memory usage (all chunks in memory)
  - Higher latency (wait for complete message)
  - Not suitable for very large messages or buffering multiple message types at the same time

**Benefit**: User can choose strategy based on application needs.

### EOM Flag Detection

**Critical**: User MUST check `chunk.eom` flag to detect multi-chunk messages.

**Logic**:
- `eom: false` - More chunks to follow
- `eom: true` - Final chunk, message complete

**Example**:
```javascript
let chunk = await channel.read({ timeout: 5000 });
while (!chunk.eom) {
  // Process chunk
  await chunk.process(async (c) => {
    processChunkData(c.data);
  });
  
  // Read next chunk
  chunk = await channel.read({ timeout: 5000, only: chunk.type });
}

// Process final chunk
await chunk.process(async (c) => {
  processChunkData(c.data);
});
```

**Benefit**: Enables detection of multi-chunk messages and proper handling.

### Message Type Filtering

**Critical**: Use same message type filter for all chunks of a message.

**Logic**:
- First chunk: `await channel.read({ only: 'myType' })`
- Subsequent chunks: `await channel.read({ only: chunk.type })`
- Ensures all chunks belong to same message

**Example**:
```javascript
const firstChunk = await channel.read({ only: 'largeFile' });
const chunks = [firstChunk];

let chunk = firstChunk;
while (!chunk.eom) {
  // Use same message type as first chunk
  chunk = await channel.read({ only: chunk.type });
  chunks.push(chunk);
}
```

**Benefit**: Prevents reading chunks from different messages (interleaved).

### Chunk Assembly Strategy

**For Buffering**: Assemble chunks into complete message.

**Strategy 1: Concatenate Uint8Arrays**:
```javascript
const totalLength = chunks.reduce((sum, c) => sum + c.data.length, 0);
const completeData = new Uint8Array(totalLength);
let offset = 0;
for (const chunk of chunks) {
  completeData.set(chunk.data.toUint8Array(), offset);
  offset += chunk.data.length;
}
```

**Strategy 2: Use VirtualBuffer (Zero-Copy)**:
```javascript
// Create VirtualBuffer spanning all chunks
const segments = chunks.map(c => c.data);
const completeMessage = new VirtualBuffer(segments);

// Decode directly from VirtualBuffer (zero-copy)
const text = completeMessage.decode();
```

**Benefit**: Strategy 2 avoids intermediate copy (more efficient).

### ACK Generation During Multi-Chunk Read

**Critical**: ACKs are generated periodically, not for every chunk.

**Logic**:
- After each chunk consumed, check buffer usage
- If `bufferUsed < lowBufferBytes`, generate ACK
- ACK includes all consumed chunks (range-based)
- Sender's budget restored incrementally

**Example Timeline**:
1. Receive chunk 1, consume, buffer usage = 10KB (no ACK yet)
2. Receive chunk 2, consume, buffer usage = 20KB (no ACK yet)
3. Receive chunk 3, consume, buffer usage = 5KB (below low-water mark, send ACK for chunks 1-3)
4. Receive chunk 4, consume, buffer usage = 15KB (no ACK yet)
5. Receive chunk 5 (EOM), consume, buffer usage = 0KB (send ACK for chunks 4-5)

**Benefit**: Minimizes ACK overhead while maintaining flow control.

### Zero-Copy Reading

The entire read path is designed for zero-copy operation:
1. Transport receives data into buffer (from BufferPool)
2. Parse header directly from buffer (via [`VirtualBuffer`](../../src/virtual-buffer.esm.js))
3. Create [`VirtualBuffer`](../../src/virtual-buffer.esm.js) view of data payload (no copy)
4. User accesses data via VirtualBuffer methods (no copy)
5. User can decode text or access bytes directly (minimal copies)

**For Streaming**: Zero-copy throughout (process chunks directly)
**For Buffering**: One copy when assembling complete message (unavoidable)

**Benefit**: Minimizes memory allocations and copies, maximizes throughput.

### Protocol Violation Handling

**Out-of-Order Sequences**:
- Detected by [`ChannelFlowControl.recordReceived()`](../../src/channel-flow-control.esm.js)
- Throws `ProtocolViolationError` with reason `'Out of order'`
- Transport emits `protocolViolation` event
- May close channel or transport depending on severity

**Over-Budget Chunks**:
- Detected by [`ChannelFlowControl.recordReceived()`](../../src/channel-flow-control.esm.js)
- Throws `ProtocolViolationError` with reason `'Over budget'`
- Transport emits `protocolViolation` event
- May close channel or transport depending on severity

**Benefit**: Detects and handles malicious or buggy remote implementations.

### Incomplete Message Handling

**Problem**: Connection lost before EOM received.

**Detection**: User detects missing EOM (loop never completes).

**Handling**:
- Set timeout for each chunk read
- If timeout expires, assume connection lost
- Mark received chunks as consumed (call `done()`)
- Report error to user or retry request

**Example**:
```javascript
try {
  const chunks = [];
  let chunk = await channel.read({ timeout: 5000, only: 'file' });
  
  while (!chunk.eom) {
    chunks.push(chunk);
    chunk = await channel.read({ timeout: 5000, only: 'file' });
  }
  
  chunks.push(chunk);
  // Process complete message
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error('Connection lost, incomplete message');
    // Mark received chunks as consumed
    for (const chunk of chunks) {
      chunk.done();
    }
    // Retry or report error
  }
}
```

**Benefit**: Graceful handling of connection loss during multi-chunk read.

### Security Considerations

- **Sequence validation**: Prevents out-of-order attacks
- **Budget enforcement**: Prevents buffer overflow attacks
- **Duplicate reader prevention**: Prevents data loss from conflicting readers
- **Protocol violation detection**: Detects and handles malicious implementations
- **Timeout enforcement**: Prevents indefinite waiting for incomplete messages

### Performance Considerations

- **Zero-copy reading**: Minimizes memory allocations and copies
- **Batch ACKs**: Minimizes ACK overhead (not sent for every chunk)
- **Async waiting**: Non-blocking, efficient use of resources
- **Message type filtering**: Enables efficient multiplexing within channels
- **Streaming strategy**: Minimal memory usage for large messages

### Testing Considerations

Key test cases:
1. Read multi-chunk message (various sizes, 2-100 chunks)
2. Read with streaming strategy (process each chunk immediately)
3. Read with buffering strategy (assemble complete message)
4. Read with message type filter (ensure all chunks same type)
5. Read with timeout (success and timeout on intermediate chunk)
6. Read incomplete message (connection lost before EOM)
7. Read from closing channel (should succeed for remaining chunks)
8. Read from closed channel (should throw `StateError`)
9. Duplicate reader detection during multi-chunk read
10. Out-of-order sequence detection (protocol violation)
11. Over-budget chunk detection (protocol violation)
12. ACK generation during multi-chunk read (periodic)
13. Concurrent multi-chunk reads (non-overlapping filters)
14. Zero-copy chunk assembly (VirtualBuffer spanning multiple chunks)
15. Large message read (1000+ chunks, test memory usage)
