# Simple Read Scenario

## Overview

This scenario documents the process of reading a single-chunk data message from a channel. It covers the complete flow from the user calling [`channel.read()`](../../src/channel.esm.js) or [`channel.readSync()`](../../src/channel.esm.js) through retrieving the chunk from the receive buffer, processing it, and generating ACKs to restore the sender's budget.

**Key Point**: [`channel.read()`](../../src/channel.esm.js) handles ALL complexity internally - buffer management, sequence validation, budget tracking, ACK generation, etc. The user simply calls `read()` and the channel takes care of everything.

## Preconditions

- Transport is started and connected
- Channel is open (bidirectional)
- Remote has sent one or more chunks (or will send them)

**Note**: Channel automatically handles buffer management and ACK generation - no preconditions required from user.

## Actors

- **User Code**: Calls [`channel.read()`](../../src/channel.esm.js) or [`channel.readSync()`](../../src/channel.esm.js)
- **Channel**: Orchestrates entire read operation, handles all complexity
- **ChannelFlowControl**: Validates sequence order, tracks received chunks, generates ACK information
- **VirtualBuffer**: Provides zero-copy view of received data
- **Protocol**: Decodes message headers
- **Transport**: Receives data from remote, sends ACKs back

## Step-by-Step Sequence

### 1. User Initiates Read

**Action**: User calls `await channel.read({ timeout, only })` or `channel.readSync({ only })`

**Parameters**:
- `timeout`: Maximum time to wait for data (milliseconds, async only)
- `only`: Optional message type filter (number, string, array, or Set)

**Responsible Module**: User code

**Example**:
```javascript
// Read any message type (async)
const chunk = await channel.read({ timeout: 5000 });
console.log('Type:', chunk.type, 'EOM:', chunk.eom, 'Data:', chunk.data);

// Read specific message type (async)
const chunk = await channel.read({ timeout: 5000, only: 'response' });

// Read multiple message types (async)
const chunk = await channel.read({ timeout: 5000, only: [0, 1, 2] });

// Read synchronously (returns null if no matching chunk available)
const chunk = channel.readSync({ only: 'notification' });
if (chunk) {
  console.log('Got notification:', chunk.data);
}
```

**Note**: This scenario focuses on single-chunk reads. For multi-chunk messages, see [`streaming-read.md`](streaming-read.md).

### 2. Channel Validates State

**Action**: Channel checks if read is allowed

**Validations**:
- Channel state must be `open` or `closing` (not `closed`)
- If channel is `closed`, throw `StateError`

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**State Changes**: None (validation only)

**Error Conditions**:
- `StateError`: Channel is `closed`

**Note**: Reads are allowed during `closing` state to drain remaining data.

### 3. Check for Duplicate Readers

**Action**: Prevent conflicting concurrent readers

**Logic**:
- Check if there's already an active reader
- **Unfiltered reader**: Only one allowed at a time
- **Filtered reader**: Check for overlapping message types
- If conflict detected, throw `Error` (was `DuplicateReaderError`, now just `Error`)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.#unfilteredReader`: Scalar for unfiltered async reader
- `channel.#filteredReaders`: Map of message type → reader meta object
- Reader meta object: `{ stale: false }` (initially)

**Error Conditions**:
- `Error`: Duplicate reader detected (conflicting filters or unfiltered)

**Note**: Reader becomes stale after receiving a chunk (must initiate new read for next chunk).

### 4. Register Reader

**Action**: Register this read operation as active reader

**Logic**:
- Create reader meta object: `{ stale: false }`
- **If unfiltered**: Store in `channel.#unfilteredReader`
- **If filtered**: Store in `channel.#filteredReaders` for each message type in filter

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Reader meta object tracks staleness
- Stale flag set to `true` when chunk is delivered

**Note**: Registration prevents duplicate readers while this read is active.

### 5. Check Receive Buffer for Matching Chunk

**Action**: Check if matching chunk is already available

**Logic**:
- Iterate through receive buffer (FIFO order)
- **If unfiltered**: First chunk matches
- **If filtered**: First chunk with matching message type
- If matching chunk found, proceed to step 6
- If no matching chunk, proceed to step 7 (wait or return null)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.#receiveBuffer`: Array of `{ seq, type, eom, data }` chunks
- Chunks stored in order received (FIFO)

**Note**: Buffer may contain chunks from multiple message types (interleaved).

### 6. Extract Chunk from Buffer (If Available)

**Action**: Remove matching chunk from receive buffer

**Logic**:
- Remove chunk from `channel.#receiveBuffer`
- Mark reader as stale (set `meta.stale = true`)
- Unregister reader (clear from `#unfilteredReader` or `#filteredReaders`)
- Return chunk to user (skip to step 11)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Chunk object: `{ seq, type, eom, data }`
- `data` is [`VirtualBuffer`](../../src/virtual-buffer.esm.js) (zero-copy view)

**Returns**: Chunk object with metadata and data

**Note**: If chunk found, skip waiting steps (7-10) and proceed to step 11.

### 7. Wait for Incoming Chunk (Async) or Return Null (Sync)

**Action**: Wait for remote to send matching chunk

**Logic**:
- **Async (`read()`)**: Wait for `newChunk` event or timeout
  - Create promise that resolves when matching chunk arrives
  - Set timeout if specified
  - Wait for promise to resolve or reject
- **Sync (`readSync()`)**: Return `null` immediately
  - No waiting, just check buffer and return

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Blocking**: Async read waits for data or timeout (transparent to user)

**Error Conditions**:
- `TimeoutError`: Timeout expired before matching chunk arrived (async only)
- `null`: No matching chunk available (sync only, not an error)

**Note**: Sync read is non-blocking, async read waits.

### 8. Receive Incoming Chunk from Transport

**Action**: Transport receives data from remote and delivers to channel

**Logic**:
- Transport receives bytes from remote (transport-specific)
- Decode message header using [`Protocol.decodeHeaderFrom()`](../../src/protocol.esm.js)
- Determine header type (0=ACK, 1=control, 2=data)
- **If ACK**: Process ACK (restore sending budget, wake waiting writers)
- **If control**: Process control message (channel setup, message type registration, etc.)
- **If data**: Deliver to channel (this scenario)

**Responsible Module**: [`Transport`](../../src/transport/base.esm.js), [`Protocol`](../../src/protocol.esm.js)

**Data Structures**:
- Incoming buffer (from transport read)
- [`VirtualBuffer`](../../src/virtual-buffer.esm.js) view of header and data

**Note**: This happens asynchronously in transport layer, triggered by remote sending data.

### 9. Validate and Record Received Chunk

**Action**: Validate sequence order and budget, record chunk

**Logic**:
- Call [`flowControl.recordReceived(seq, chunkBytes)`](../../src/channel-flow-control.esm.js)
- Validates sequence order (must be consecutive)
- Validates budget (must not exceed available buffer space)
- Records chunk in received chunks map
- Increments next expected sequence number

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#receivedChunks`: Map of seq → `{ bytes, consumed: false }`
- `flowControl.#receivedBytes`: Total bytes received but not consumed
- `flowControl.#nextExpectedSeq`: Next expected sequence number

**Error Conditions**:
- `ProtocolViolationError`: Out-of-order sequence (seq !== nextExpectedSeq)
- `ProtocolViolationError`: Over-budget (chunkBytes > bufferAvailable)

**Note**: Protocol violations trigger transport-level error handling (may close channel/transport).

### 10. Add Chunk to Receive Buffer

**Action**: Add chunk to channel's receive buffer

**Logic**:
- Create chunk object: `{ seq, type, eom, data }`
- Add to `channel.#receiveBuffer` (FIFO order)
- Emit `newChunk` event (for debugging, validation, push processing)
- Check if any waiting readers match this chunk
- If match found, deliver chunk to waiting reader (proceed to step 6)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.#receiveBuffer`: Array of chunks
- `data` is [`VirtualBuffer`](../../src/virtual-buffer.esm.js) (zero-copy view)

**Note**: If waiting reader matches, deliver immediately (skip buffer storage).

### 11. Return Chunk to User

**Action**: Deliver chunk to user code

**Logic**:
- Mark reader as stale (set `meta.stale = true`)
- Unregister reader (clear from `#unfilteredReader` or `#filteredReaders`)
  - NOT NECESSARY
- Resolve promise (async) or return chunk (sync)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Returns**: Chunk object `{ seq, type, eom, data, process, done }`
- `seq`: Sequence number (internal, for tracking)
- `type`: Message type (numeric or string if registered)
- `eom`: End-of-message flag (boolean)
- `data`: [`VirtualBuffer`](../../src/virtual-buffer.esm.js) (zero-copy view of data payload)
- `async process(async (chunkObject) => callback)`
  - Calls the callback function, passing the chunk object
  - Awaits callback execution, and "finally" calls `done`
- `done()`: Done processing chunk (mark consumed)

**Note**: User can now process the chunk data.

### 12. User Processes Chunk Data

**Action**: User code processes the received data

**Logic**:
- User accesses `chunk.data` (VirtualBuffer)
- User can decode text: `chunk.data.decode()`
- User can access bytes: `chunk.data.getUint8(offset)`, etc.
- User can copy to Uint8Array: `chunk.data.toUint8Array()`
- User checks `chunk.eom` to detect end-of-message

**Responsible Module**: User code

**Example**:
```javascript
const chunk = await channel.read({ timeout: 5000 });

// Decode text data
if (chunk.type === 'text') {
  const text = chunk.data.decode();
  console.log('Received text:', text);
}

// Access binary data
if (chunk.type === 'binary') {
  const firstByte = chunk.data.getUint8(0);
  console.log('First byte:', firstByte);
}

// Check end-of-message
if (chunk.eom) {
  console.log('Message complete');
}
```

**Note**: User is responsible for processing data and determining when to mark as consumed.

### 13. Mark Chunk as Consumed

**Action**: User calls chunk object's async `process` with an async callback to automatically track completion or `done` to manually indicate chunk has been completely processed

Note: The user must expect to copy the buffer or use `done` rather than `process` if multi-chunk message reassembly is (or might be) required.

**Logic**:
- `done` calls [`flowControl.recordConsumed(seq)`](../../src/channel-flow-control.esm.js)
  - (User has no access to transport internals)
- Marks chunk as consumed (ready to ACK)
- Chunk remains tracked until ACK is sent

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#receivedChunks`: Map entry updated `{ bytes, consumed: true }`

**Note**: Consumed chunks are eligible for ACK generation.

### 14. Check Buffer Usage and Generate ACK (If Needed)

**Action**: Check if buffer usage dropped below low-water mark

**Logic**:
- Calculate buffer usage: `flowControl.bufferUsed`
- Compare to low-water mark: `channel.lowBufferBytes`
- If `bufferUsed < lowBufferBytes`, generate ACK
- Call [`flowControl.getAckInfo()`](../../src/channel-flow-control.esm.js)
- Returns `{ baseSeq, ranges }` for consumed chunks

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `channel.lowBufferBytes`: Low-water mark for ACK generation
- ACK info: `{ baseSeq, ranges }` (range-based acknowledgment)

**Returns**: ACK info or `null` if nothing to ACK

**Note**: ACKs are batched to minimize overhead (not sent for every chunk).

### 15. Encode and Send ACK to Remote

**Action**: Encode ACK message and send to remote

**Logic**:
- Reserve transport budget for ACK (ACKs are transport-level, not channel-level)
- Reserve ring buffer space for ACK
- Encode ACK header using [`Protocol.encodeAckHeaderInto()`](../../src/protocol.esm.js)
- Commit to ring buffer
- Transport sends ACK asynchronously (in background)

**Responsible Module**: [`Transport`](../../src/transport/base.esm.js), [`Protocol`](../../src/protocol.esm.js)

**Data Structures**:
- ACK header (13 bytes + variable ranges (but always even), up to 514 bytes total)
- ACK format: type=0, flags, channelId, baseSeq, rangeCount, ranges

**Note**: ACKs are transport-level messages (do NOT count toward channel budget).

### 16. Clear ACK'd Chunks from Tracking

**Action**: Remove ACK'd chunks from flow control tracking

**Logic**:
- Call [`flowControl.clearAcked(baseSeq, ranges)`](../../src/channel-flow-control.esm.js)
- Removes chunks from `#receivedChunks` map
- Decreases `#receivedBytes`
- Frees buffer space for new incoming chunks

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#receivedChunks`: Map entries removed
- `flowControl.#receivedBytes`: Decreased by freed bytes

**Returns**: Number of bytes freed

**Note**: This happens after ACK is sent, not before.

## Postconditions

- User has received and processed chunk data
- Chunk marked as consumed in flow control
- ACK generated and sent to remote (if buffer usage dropped below low-water mark)
- Remote's sending budget restored (after receiving ACK)
- Buffer space freed for new incoming chunks

**Note**: ACK generation and sending happen asynchronously, not during `read()` call.

## Error Conditions

### StateError
- **Cause**: Channel is `closed`
- **Handling**: Throw `StateError`, user must handle
- **Recovery**: Reopen channel or create new channel

### Duplicate Reader Error
- **Cause**: Conflicting concurrent readers (overlapping filters or unfiltered)
- **Handling**: Throw `Error` (was `DuplicateReaderError`)
- **Recovery**: Wait for previous read to complete, then retry

### TimeoutError (Async Only)
- **Cause**: Timeout expired before matching chunk arrived
- **Handling**: Throw `TimeoutError`, user must handle
- **Recovery**: Retry read with longer timeout or different filter

### Protocol Violation (Out-of-Order)
- **Cause**: Received chunk with seq !== nextExpectedSeq
- **Handling**: `ProtocolViolationError` thrown by [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)
- **Recovery**: Transport emits `protocolViolation` event, may close channel/transport

### Protocol Violation (Over-Budget)
- **Cause**: Received chunk exceeds available buffer space
- **Handling**: `ProtocolViolationError` thrown by [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)
- **Recovery**: Transport emits `protocolViolation` event, may close channel/transport

**Note**: Protocol violations are serious errors that typically result in channel/transport closure.

## Related Scenarios

- [`streaming-read.md`](streaming-read.md) - Reading multi-chunk messages
- [`simple-write.md`](simple-write.md) - Writing single-chunk messages
- [`multi-chunk-write.md`](multi-chunk-write.md) - Writing large messages
- [`receive-flow-control.md`](receive-flow-control.md) - Detailed receive flow control logic
- [`ack-generation-processing.md`](ack-generation-processing.md) - How ACKs are generated and processed
- [`message-decoding.md`](message-decoding.md) - Protocol decoding details

## Implementation Notes

### User-Facing Simplicity

**Critical Design Principle**: [`channel.read()`](../../src/channel.esm.js) handles ALL complexity internally:
- ✅ Automatic buffer management
- ✅ Automatic sequence validation
- ✅ Automatic budget tracking
- ✅ Automatic ACK generation (when buffer usage drops below low-water mark)
- ✅ Automatic protocol violation detection
- ✅ Automatic message type filtering
- ✅ Automatic duplicate reader prevention

**User Responsibility**: Just call `read()` and process the data. That's it.

### Synchronous vs Asynchronous Read

**Async (`read()`)**: 
- Waits for matching chunk to arrive (or timeout)
- Returns promise that resolves with chunk
- Throws `TimeoutError` if timeout expires
- Suitable for most use cases

**Sync (`readSync()`)**:
- Checks buffer immediately, returns `null` if no match
- Non-blocking, returns immediately
- Suitable for polling or event-driven (e.g. push) scenarios
- No timeout (returns `null` instead)

**Benefit**: User can choose blocking or non-blocking behavior based on use case.

### Message Type Filtering

**Unfiltered Read**:
- Returns first chunk in buffer (any message type)
- Only one unfiltered reader allowed at a time
- Mutually exclusive with filtered read

**Filtered Read**:
- Returns first chunk matching specified message type(s)
- Multiple filtered readers allowed if filters don't overlap
- Filter can be: number, string, array, or Set
- Mutually exclusive with unfiltered read

**Benefit**: Enables "light-weight channels" within channels (type-based multiplexing) and simplified (targeted) handlers.

### Duplicate Reader Prevention

**Problem**: Concurrent readers with overlapping filters can cause race conditions and data loss.

**Solution**: Track active readers and prevent conflicts:
- Unfiltered reader: Only one allowed at a time
- Filtered readers: Check for overlapping message types
- Reader becomes stale after receiving chunk (must initiate new read)

**Benefit**: Prevents data loss and race conditions from conflicting readers.

### Zero-Copy Reading

The entire read path is designed for zero-copy operation:
1. Transport receives data into buffer (from BufferPool)
2. Parse header directly from buffer (via [`VirtualBuffer`](../../src/virtual-buffer.esm.js))
3. Create [`VirtualBuffer`](../../src/virtual-buffer.esm.js) view of data payload (no copy)
4. User accesses data via VirtualBuffer methods (no copy)
5. User can decode text or access bytes directly (minimal copies)

**Benefit**: Minimizes memory allocations and copies, maximizes throughput.

### ACK Generation Strategy

**Low-Water Mark**:
- ACKs generated when buffer usage drops below `lowBufferBytes`
- Prevents excessive ACK overhead (not sent for every chunk)
- Ensures sender's budget is restored before buffer fills

**Range-Based ACKs**:
- ACKs use range encoding: base sequence + include/skip ranges
- Efficient for acknowledging multiple chunks at once
- Handles out-of-order consumption (if chunks consumed non-sequentially)

**Benefit**: Minimizes ACK overhead while maintaining flow control.

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

### Buffer Management

**Receive Buffer**:
- Stores chunks in FIFO order
- Chunks from multiple message types can be interleaved
- Chunks remain until consumed and ACK'd

**Flow Control Tracking**:
- Tracks received chunks (received but not consumed)
- Tracks consumed chunks (consumed but not ACK'd)
- Clears chunks after ACK sent

**Benefit**: Efficient buffer management with minimal overhead.

### Security Considerations

- **Sequence validation**: Prevents out-of-order attacks
- **Budget enforcement**: Prevents buffer overflow attacks
- **Duplicate reader prevention**: Prevents data loss from conflicting readers
- **Protocol violation detection**: Detects and handles malicious implementations

### Performance Considerations

- **Zero-copy reading**: Minimizes memory allocations and copies
- **Batch ACKs**: Minimizes ACK overhead
- **Async waiting**: Non-blocking, efficient use of resources
- **Message type filtering**: Enables efficient multiplexing within channels

### Testing Considerations

Key test cases:
1. Read single-chunk message (various data types)
2. Read with message type filter (numeric and string)
3. Read with multiple message type filter (array and Set)
4. Read with timeout (success and timeout)
5. Sync read (available and not available)
6. Read from closing channel (should succeed)
7. Read from closed channel (should throw `StateError`)
8. Duplicate reader detection (unfiltered and filtered)
9. Out-of-order sequence detection (protocol violation)
10. Over-budget chunk detection (protocol violation)
11. ACK generation (buffer usage below low-water mark)
12. ACK encoding and sending (transport-level)
13. Concurrent filtered reads (non-overlapping filters)
14. Read with EOM flag (detect end-of-message)
15. Zero-copy data access (VirtualBuffer methods)
