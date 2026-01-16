# Multi-Chunk Write Scenario

## Overview

This scenario documents the process of writing a large data message that exceeds [`maxChunkBytes`](../../src/channel.esm.js) and must be split into multiple chunks. It covers the complete flow from the user calling [`channel.write()`](../../src/channel.esm.js) through encoding and sending multiple chunks with proper sequencing and end-of-message (EOM) flag handling.

**Key Point**: [`channel.write()`](../../src/channel.esm.js) handles multi-chunk splitting automatically - the user doesn't need to know or care about chunk boundaries. The channel transparently splits large messages and sends them as multiple chunks.

**Serialization**: Each chunk is serialized independently at the **chunk level** (not write-operation level) to ensure fairness and prevent deadlocks. See [`arch/writer-serialization.md`](../writer-serialization.md) for complete architecture.

## Preconditions

- Transport is started and connected
- Channel is open (bidirectional)
- User has large data to send (exceeds `maxChunkBytes`)

**Note**: Channel automatically handles chunking - no preconditions required from user.

## Actors

- **User Code**: Calls [`channel.write()`](../../src/channel.esm.js) with large data
- **Channel**: Orchestrates multi-chunk write, handles all complexity
- **ChannelFlowControl**: Validates and tracks sending budget for each chunk
- **OutputRingBuffer**: Provides zero-copy write space for each chunk
- **VirtualRWBuffer**: Provides DataView-compatible interface for encoding
- **Protocol**: Encodes message headers into ring buffer
- **Transport**: Sends encoded chunks to remote

## Step-by-Step Sequence

### 1. User Initiates Write with Large Data

**Action**: User calls `await channel.write(data, { eom = true, type = 0 })`

**Parameters**:
- `data`: String or Uint8Array to send (size including header exceeds `maxChunkBytes`)
- `eom`: End-of-message flag (default true)
- `type`: Message type (numeric or pre-registered string)

**Responsible Module**: User code

**Example**:
```javascript
// Write large text (channel automatically chunks)
const largeText = 'x'.repeat(1_000_000); // 1MB string
await channel.write(largeText, { eom: true, type: 0 });

// Write large binary data (channel automatically chunks)
const largeBinary = new Uint8Array(5_000_000); // 5MB binary
await channel.write(largeBinary, { eom: true, type: 1 });

// Write large JSON (channel automatically chunks)
const largeObject = { data: 'x'.repeat(2_000_000) };
await channel.write(JSON.stringify(largeObject), { eom: true, type: 2 });
```

**Note**: User doesn't need to know about chunking - channel handles it transparently.

### 2. Channel Validates State

**Action**: Channel checks if write is allowed

**Validations**:
- Channel state must be `open` (not `closing`, `localClosing`, `remoteClosing`, or `closed`)
- If channel is closing, throw `StateError`

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**State Changes**: None (validation only)

**Error Conditions**:
- `StateError`: Channel is not in `open` state

### 3. Resolve Message Type

**Action**: Convert string message type to numeric ID if needed

**Logic**:
- If `type` is numeric, use it directly
- If `type` is string, look up registered message-type ID
- If string type not registered, throw error

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.#messageTypes`: Map of string → numeric ID

**Error Conditions**:
- `Error`: Message type string not registered (must call [`channel.addMessageType()`](../../src/channel.esm.js) first)

### 4. Determine Data Size and Chunking Strategy

**Action**: Calculate data size and determine chunking is needed

**Logic**:
- Calculate `maxDataBytes = channel.maxChunkBytes - 18` (18 = header size)
- **If data is Uint8Array**:
  - Total size is `data.length`
  - Calculate chunk count: `Math.ceil(data.length / maxDataBytes)`
- **If data is string**:
  - Worst-case size is `str.length * 3` (UTF-8 encoding)
  - Cannot know exact size until encoded
  - Must encode chunk-by-chunk and track progress
- If total size > `maxDataBytes`, proceed with multi-chunk write (this scenario)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.maxChunkBytes`: Maximum chunk size (header + data)
- `MAX_DATA_HEADER_BYTES = 18`: Fixed header size
- `maxDataBytes = maxChunkBytes - 18`: Maximum data per chunk

**Note**: This scenario covers multi-chunk writes. For single-chunk, see [`simple-write.md`](simple-write.md).

### 5. Initialize Multi-Chunk State

**Action**: Set up state for multi-chunk write loop

**Logic**:
- **For Uint8Array**:
  - `offset = 0`: Current position in source data
  - `remaining = data.length`: Bytes left to send
- **For string**:
  - `strOffset = 0`: Current position in string (UTF-16 code units)
  - `remaining = str.length`: Code units left to encode
- `chunkIndex = 0`: Current chunk number (for debugging/logging)
- `isLastChunk = false`: Will be set true for final chunk

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Local variables for tracking progress through data

**Note**: String encoding is more complex because UTF-8 size is variable.

### 6. Begin Chunk Loop

**Action**: Start loop to send chunks until all data sent

**Loop Condition**: While `remaining > 0` (binary) or `strOffset < str.length` (string)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Note**: Each iteration sends one chunk. Loop continues until all data sent. Each chunk is serialized independently via TaskQueue.

### 7. Enter Write Serialization Queue (Per Chunk)

**Action**: Serialize THIS chunk write with other pending chunk writes

**Logic**:
- Call `await this.#writeQueue.task(async () => { ... })` for THIS chunk
- TaskQueue ensures only one chunk write active at a time per channel
- FIFO ordering: Chunks processed in order
- Prevents race conditions and budget theft
- **Chunk-level serialization**: Each chunk serialized independently

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`TaskQueue`](../../../resources/task-queue/src/task-queue.esm.js)

**Data Structures**:
- `channel.#writeQueue`: Per-channel TaskQueue instance
- Serializes all chunk writes for this channel

**Blocking**: Waits for previous chunk writes to complete (transparent to user)

**Note**: Chunk-level serialization ensures fairness - chunks from different messages can interleave.

### 8. Calculate Chunk Size

**Action**: Determine how much data to send in this chunk

**Logic**:
- **For Uint8Array**:
  - `chunkDataSize = Math.min(remaining, maxDataBytes)`
  - Exact size known upfront
- **For string**:
  - Reserve worst-case: `chunkDataSize = Math.min((str.length - strOffset) * 3, maxDataBytes)`
  - Actual size determined after encoding
  - May need to shrink reservation

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `maxDataBytes`: Maximum data per chunk
- `remaining` or `strOffset`: Progress tracker

**Note**: String chunks reserve worst-case space, then shrink after encoding.

### 9. Determine if Last Chunk

**Action**: Check if this is the final chunk

**Logic**:
- **For Uint8Array**:
  - `isLastChunk = (remaining <= maxDataBytes)`
- **For string**:
  - Cannot know until after encoding
  - Must check after `encodeFrom()` returns

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `isLastChunk`: Boolean flag for EOM handling

**Note**: For strings, EOM flag is determined after encoding each chunk.

### 10. Reserve Channel Sending Budget

**Action**: Reserve channel budget atomically for this chunk (provisional until chunk completes)

**Logic**:
- Calculate required budget: `chunkSize = 18 + chunkDataSize`
- Call `await flowControl.reserveBudget(chunkSize)`
- If sufficient budget, reserves immediately and returns
- If insufficient budget, waits for ACKs to restore budget
- **Atomic reservation**: Budget reserved when waiter awakened (before promise resolves)
- Budget includes header + data (entire chunk)

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#inFlightBytes`: Bytes reserved (provisional until chunk completes)
- `flowControl.#remoteMaxBufferBytes`: Remote's buffer limit
- `sendingBudget = remoteMaxBufferBytes - inFlightBytes`
- `flowControl.#waiter`: Single waiter object (not array) - TaskQueue ensures serialization

**Blocking**: Waits asynchronously for ACKs to restore budget (transparent to user)

**Note**: Each chunk reserves budget independently. Budget is **provisional** - may be released if reservation shrinks.

### 11. Reserve Transport Sending Budget

**Action**: Reserve transport budget atomically for this chunk (provisional until chunk completes)

**Logic**:
- Transport maintains separate budget for all channels
- Call `await transport._reserveBudget(chunkSize + RESERVE_ACK_BYTES)`
- Serialized via transport's `#budgetQueue` TaskQueue (FIFO round-robin across channels)
- Reserve `chunkSize + RESERVE_ACK_BYTES` to prevent blocking ACKs
- If insufficient budget, wait for transport budget to become available
- **Atomic reservation**: Budget reserved when waiter awakened

**Responsible Module**: [`Transport`](../../src/transport/base.esm.js), [`TransportFlowControl`](../../src/transport/base.esm.js)

**Data Structures**:
- `transport.#budgetQueue`: TaskQueue for cross-channel FIFO round-robin
- `transport.#transportBudget`: TransportFlowControl instance
- `RESERVE_ACK_BYTES = 514`: Maximum ACK message size

**Blocking**: Waits asynchronously for ACKs to restore transport budget (transparent to user)

**Note**: Transport budget is shared across all channels, FIFO round-robin ensures fairness.

### 12. Reserve Output Ring Buffer Space

**Action**: Reserve ring buffer space atomically for this chunk

**Logic**:
- Call `await ring.reserveAsync(chunkSize)`
- Serialized via ring's `#reserveQueue` TaskQueue
- If sufficient space, reserves immediately and returns [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)
- If insufficient space, waits for space to become available (after previous data is sent and consumed)
- **Single waiter model**: Only one chunk can be waiting for space (TaskQueue ensures serialization)

**Responsible Module**: [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js), [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `ring.#reserveQueue`: TaskQueue for serializing reservations
- `ring.#spaceWaiter`: Single waiter object `{ bytes, resolve }`
- `ring.#writeHead`: Current write position
- `ring.#count`: Committed bytes (not yet consumed)
- `ring.#reserved`: Reserved bytes (not yet committed)
- `ring.space = size - count - reserved`

**Returns**: [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js) with 1 or 2 segments (if wrapped around ring boundary)

**Blocking**: Waits asynchronously for ring space (transparent to user)

### 13. Assign Sequence Number

**Action**: Assign sequence number to this chunk

**Logic**:
- Call `seq = flowControl.assignSequence(chunkSize)`
- Returns next sequence number (starting at 1)
- Records chunk in in-flight map
- Budget already reserved in step 10

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#nextSendSeq`: Next sequence number to assign
- `flowControl.#inFlightChunks`: Map of seq → bytes

**Returns**: Sequence number for this chunk

**Note**: Sequence assignment is separate from budget reservation (budget reserved first).

### 14. Encode Message Header

**Action**: Write channel data message header into ring buffer reservation

**Logic**:
- Call [`Protocol.encodeChannelHeaderInto(reservation, 0, 2, fields)`](../../src/protocol.esm.js)
- Use sequence number from step 13
- Header type: 2 (channel data message)
- Fields:
  - `totalDataSize`: Data payload size for this chunk (bytes)
  - `flags`: +1 if `eom` is true AND this is the last chunk
  - `channelId`: Numeric channel ID
  - `localSeq`: Sequence number from flow control
  - `messageType`: Numeric message-type ID

**Responsible Module**: [`Protocol`](../../src/protocol.esm.js), [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Uses [`VirtualRWBuffer.setUint8/16/32()`](../../src/virtual-buffer.esm.js) for zero-copy encoding
- Header format (18 bytes):
  ```
  1B: 2 (channel data type)
  1B: remaining header size (7, encoded as (16-2)>>1)
  4B: total data size (this chunk only)
  2B: flags (+1 if EOM AND last chunk)
  4B: channel ID
  4B: local sequence number
  2B: message type
  ```

**Returns**: Header size (always 18 bytes for channel data messages)

**Note**: EOM flag is only set on the LAST chunk, not intermediate chunks.

### 15. Write Data Payload for This Chunk

**Action**: Write data payload into ring buffer reservation (after header)

**Logic**:
- **If data is string**:
  - Encode from current position: `result = reservation.encodeFrom(data, 18, 'utf-8', strOffset)`
  - Returns `{ read, written }` (UTF-16 code units read, bytes written)
  - Update progress: `strOffset += result.read`
  - Actual data size: `actualDataSize = result.written`
  - Check if last chunk: `isLastChunk = (strOffset >= str.length)`
- **If data is Uint8Array**:
  - Copy slice into reservation: `reservation.set(data.subarray(offset, offset + chunkDataSize), 18)`
  - Update progress: `offset += chunkDataSize`
  - Actual data size: `actualDataSize = chunkDataSize`
- Data starts at offset 18 (after header)

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)

**Data Structures**:
- [`VirtualRWBuffer.encodeFrom()`](../../src/virtual-buffer.esm.js) for string encoding
- [`VirtualRWBuffer.set()`](../../src/virtual-buffer.esm.js) for binary data
- Both methods handle ring wrap-around transparently

**Note**: For string data, encoding happens directly into ring buffer (zero-copy).

### 16. Adjust Reservation Size (if needed)

**Action**: Shrink reservation if actual data size is less than reserved

**Logic**:
- For string data, actual encoded size may be less than worst-case (`str.length * 3`)
- Calculate actual chunk size: `actualChunkSize = 18 + actualDataSize`
- If `actualChunkSize < reservedSize`:
  - Shrink reservation: `reservation.shrink(actualChunkSize)`
  - Release unused channel budget: `flowControl.releaseBudget(freed)`
  - Release unused transport budget: `transport._releaseBudget(freed)`
  - Update ring reservation: `ring.shrinkReservation(reservation, actualChunkSize)`
- Released budget immediately available to next waiting chunk

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js), [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js), [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- [`VirtualRWBuffer.shrink()`](../../src/virtual-buffer.esm.js) updates internal segments
- [`OutputRingBuffer.shrinkReservation()`](../../src/output-ring-buffer.esm.js) updates reserved bytes
- [`ChannelFlowControl.releaseBudget()`](../../src/channel-flow-control.esm.js) frees budget and wakes waiters
- [`Transport._releaseBudget()`](../../src/transport/base.esm.js) frees transport budget

**Note**: For binary data, size is known upfront, so no shrinking needed.

### 17. Update EOM Flag (if needed)

**Action**: Update header EOM flag if this is the last chunk

**Logic**:
- **For string data**:
  - After encoding, check if `strOffset >= str.length`
  - If true, this is the last chunk
  - Update header flags: `reservation.setUint16(8, flags | 1)` (set EOM bit)
- **For binary data**:
  - EOM flag already set correctly in step 12

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Header flags field at offset 8 (2 bytes)
- EOM flag is bit 0 (+1)

**Note**: Only the LAST chunk has EOM flag set (if user specified `eom: true`).

### 18. Commit Ring Buffer Reservation

**Action**: Mark reservation as ready to send

**Logic**:
- Call [`ring.commit(reservation)`](../../src/output-ring-buffer.esm.js)
- Moves bytes from "reserved" to "committed" (available for sending)
- Advances `writeHead`

**Responsible Module**: [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js)

**Data Structures**:
- `ring.#writeHead`: Advanced by `actualChunkSize`
- `ring.#reserved`: Decreased by `actualChunkSize`
- `ring.#count`: Increased by `actualChunkSize` (now available for sending)

**State Changes**:
- `writeHead = (writeHead + actualChunkSize) % size`
- `reserved -= actualChunkSize`
- `count += actualChunkSize`

### 19. Exit Write Serialization Queue (Per Chunk)

**Action**: TaskQueue task completes for THIS chunk, next chunk can start

**Logic**:
- TaskQueue task function returns
- Next waiting chunk (from this or another message) can start
- Chunk-level serialization ensures fairness

**Responsible Module**: [`TaskQueue`](../../../resources/task-queue/src/task-queue.esm.js)

**Note**: This is when the next chunk write can begin (from this message or another message).

### 20. Update Progress Trackers

**Action**: Update loop variables for next iteration

**Logic**:
- **For Uint8Array**:
  - `remaining -= chunkDataSize`
- **For string**:
  - `strOffset` already updated in step 13
- `chunkIndex++` (for debugging/logging)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- Local loop variables

**Note**: Loop continues until all data sent.

### 21. Check Loop Condition

**Action**: Determine if more chunks are needed

**Logic**:
- **For Uint8Array**:
  - Continue if `remaining > 0`
- **For string**:
  - Continue if `strOffset < str.length`
- If more chunks needed, return to step 8 (calculate next chunk size)
- If all data sent, proceed to step 22

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Note**: Loop may iterate many times for very large messages. Each iteration queues one chunk via TaskQueue.

### 22. Resolve Write Promise

**Action**: Return control to user code

**Logic**:
- All chunks encoded and committed to ring buffer
- `channel.write()` promise resolves
- User code can continue (or await next write)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Returns**: `undefined` (promise resolves with no value)

**Note**: Promise resolves after ALL chunks are encoded/queued, not after sent.

## Postconditions

- All message chunks are encoded and committed to output ring buffer
- Channel flow control updated (in-flight bytes increased for each chunk)
- Transport flow control updated (sending budget decreased for each chunk)
- User code can continue (write promise resolved)
- Transport will send chunks asynchronously (in background)
- Remote transport will eventually send ACKs to restore budget

**Note**: The write promise resolves after all chunks are encoded/queued, NOT after they're sent. Actual sending and zero-after-write happen asynchronously in the transport layer.

## Background Transport Operations (After Write Resolves)

These operations happen asynchronously in the transport layer, AFTER the write promise resolves:

### Send Chunks to Remote

**Action**: Transport sends each chunk to remote

**Logic**:
- For each chunk in ring buffer:
  - Call [`ring.getBuffers(chunkSize)`](../../src/output-ring-buffer.esm.js)
  - Returns array of 1 or 2 Uint8Array views
  - Send each buffer to remote (transport-specific)
  - Call [`ring.consume(chunkSize)`](../../src/output-ring-buffer.esm.js) to mark as sent
  - Zero consumed space (security)

**Responsible Module**: [`Transport`](../../src/transport/base.esm.js), transport implementations

**Blocking**: May block on I/O (network, pipe, etc.)

**Note**: Chunks are sent in order, one at a time. This happens asynchronously.

### Receive ACKs and Restore Budget

**Action**: Remote sends ACKs, sender processes them

**Logic**:
- Remote receives chunks, processes them, sends ACKs
- Sender receives ACKs, calls `flowControl.processAck(baseSeq, ranges)`
- Budget restored, waiting writes unblocked

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js), [`Transport`](../../src/transport/base.esm.js)

**Note**: ACKs may arrive while later chunks are still being encoded.

## Error Conditions

### StateError
- **Cause**: Channel is not in `open` state (closing or closed)
- **Handling**: Throw `StateError`, user must handle
- **Recovery**: Wait for channel to reopen or create new channel

### Message Type Not Registered
- **Cause**: String message type not registered via [`channel.addMessageType()`](../../src/channel.esm.js)
- **Handling**: Throw `Error`
- **Recovery**: Register message type first, then retry write

### Transport Error
- **Cause**: Network error, connection closed, etc.
- **Handling**: Transport emits error event, may close channel/transport
- **Recovery**: Depends on error type (reconnect, fail, etc.)

### Encoding Error (String)
- **Cause**: Invalid UTF-16 in string (rare)
- **Handling**: Throw `Error`
- **Recovery**: Fix string data, retry write

**Note**: Budget exhaustion and ring buffer full are NOT errors - channel waits automatically.

## Related Scenarios

- [`simple-write.md`](simple-write.md) - Writing single-chunk messages
- [`simple-read.md`](simple-read.md) - Reading messages (single or multi-chunk)
- [`streaming-read.md`](streaming-read.md) - Reading multi-chunk messages
- [`send-flow-control.md`](send-flow-control.md) - Detailed flow control logic
- [`ack-generation-processing.md`](ack-generation-processing.md) - How ACKs restore budget
- [`message-encoding.md`](message-encoding.md) - Protocol encoding details
- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - Output ring buffer operations

## Implementation Notes

### Writer Serialization

**Critical Architecture**: Each chunk is serialized independently using TaskQueue to prevent race conditions and deadlocks.

**See**: [`arch/writer-serialization.md`](../writer-serialization.md) for complete architecture.

**Key Points**:
- **Chunk-level serialization**: Each chunk serialized independently (not entire write operation)
- **Dynamic string chunking**: Cannot pre-plan string chunks (UTF-8 variable-length)
- **Provisional reservations**: Budget reserved but may be released after shrinking
- **Atomic reservation**: Budget reserved when waiter awakened (before promise resolves)
- **FIFO ordering**: Chunks processed in order (fairness)
- **Chunk interleaving**: Chunks from different messages can interleave naturally

**Why Chunk-Level**:
- **Fairness**: Small messages don't wait behind large multi-chunk messages
- **Interleaving**: Chunks from different messages can interleave (e.g., `A1 B1 A2 C1 A3...`)
- **Dynamic chunking**: String encoding requires dynamic chunking (cannot pre-plan)

### User-Facing Simplicity

**Critical Design Principle**: [`channel.write()`](../../src/channel.esm.js) handles ALL multi-chunk complexity internally:
- ✅ Automatic chunk-level serialization (prevents race conditions)
- ✅ Automatic chunk splitting based on `maxChunkBytes`
- ✅ Automatic budget reservation for each chunk (channel and transport level)
- ✅ Automatic ring buffer space reservation for each chunk
- ✅ Automatic string encoding across chunks
- ✅ Automatic EOM flag handling (only on last chunk)
- ✅ Automatic sequence number assignment for each chunk
- ✅ Automatic flow control updates for each chunk
- ✅ Automatic budget release after shrinking

**User Responsibility**: Just call `write()` with data and options. That's it. No chunking logic needed.

### Chunk Splitting Strategy

**Binary Data (Uint8Array)**:
- Size known upfront: `data.length`
- Chunk count: `Math.ceil(data.length / maxDataBytes)`
- Each chunk (except last): `maxDataBytes` bytes
- Last chunk: `data.length % maxDataBytes` bytes (or `maxDataBytes` if evenly divisible)

**String Data**:
- Size unknown until encoded (UTF-8 is variable-length)
- Reserve worst-case: `min((str.length - strOffset) * 3, maxDataBytes)`
- Encode as much as fits: `encodeFrom()` returns `{ read, written }`
- Shrink reservation to actual size
- Continue until entire string encoded

**Benefit**: Binary data is more efficient (exact sizes), string data is more complex (variable encoding).

### EOM Flag Handling

**Critical Rule**: EOM flag is only set on the LAST chunk (if user specified `eom: true`).

**Logic**:
- Intermediate chunks: `flags = 0` (no EOM)
- Last chunk: `flags = 1` (EOM set)
- For binary data: Last chunk known upfront
- For string data: Last chunk known after encoding

**Benefit**: Receiver can detect end-of-message and assemble complete message.

### String Encoding Across Chunks

**Challenge**: UTF-8 encoding is variable-length (1-4 bytes per code point).

**Solution**:
1. Reserve worst-case space: `(str.length - strOffset) * 3`
2. Encode as much as fits: `encodeFrom(str, offset, 'utf-8', strOffset)`
3. Returns `{ read, written }` - how many UTF-16 code units consumed, how many bytes written
4. Shrink reservation to actual size
5. Update `strOffset += read`
6. Continue until `strOffset >= str.length`

**Benefit**: Handles multi-byte UTF-8 sequences correctly, even across chunk boundaries.

### Budget Management Per Chunk

**Critical**: Each chunk reserves budget independently (provisional until chunk completes).

**Logic**:
- Before encoding each chunk, reserve channel budget (atomic)
- Before encoding each chunk, reserve transport budget (atomic, FIFO round-robin)
- ACKs may arrive between chunks, restoring budget
- Later chunks may not need to wait if sufficient original budget or ACKs arrive quickly to restore it
- Budget released if reservation shrinks (freed budget wakes next waiting chunk)

**Benefit**: Maximizes throughput while respecting flow control, prevents budget theft.

### Ring Buffer Space Management

**Challenge**: Ring buffer may not have space for all chunks at once.

**Solution**:
- Reserve space for one chunk at a time
- If insufficient space, wait for previous chunks to be sent and consumed
- Retry reservation after space becomes available

**Benefit**: Prevents deadlock, allows large messages to be sent even with small ring buffer.

### Sequence Number Assignment

**Critical**: Each chunk gets its own sequence number.

**Logic**:
- Call `flowControl.recordSent(chunkSize)` for each chunk
- Returns next sequence number (starting at 1)
- Sequence numbers are consecutive (no gaps)

**Benefit**: Receiver can detect missing or out-of-order chunks.

### Zero-Copy Writing

The entire multi-chunk write path is designed for zero-copy operation:
1. Reserve space directly in output ring buffer (per chunk)
2. Encode header directly into reservation (via [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js))
3. Encode string data directly into reservation (via [`VirtualRWBuffer.encodeFrom()`](../../src/virtual-buffer.esm.js))
4. Or copy binary data into reservation (via [`VirtualRWBuffer.set()`](../../src/virtual-buffer.esm.js))
5. Get buffer views for transport layer (no additional copy)

**Benefit**: Minimizes memory allocations and copies, maximizes throughput.

### Performance Considerations

- **Chunk-level serialization**: Minimal TaskQueue overhead (single microtask per chunk)
- **Chunk interleaving**: Chunks from different messages can interleave (fairness)
- **Async waiting**: Budget and ring space waits are async (non-blocking)
- **Atomic reservations**: No race conditions, no budget theft
- **Batch ACKs**: ACKs are batched to minimize overhead (see [`ack-generation-processing.md`](ack-generation-processing.md))
- **Ring buffer**: Minimizes allocations and copies
- **DataView methods**: Zero-copy header encoding via [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)
- **Background sending**: Chunks sent asynchronously while later chunks are being encoded

### Security Considerations

- **Zero-after-write**: Consumed ring buffer space is zeroed to prevent data leakage
- **Budget enforcement**: Prevents malicious senders from overwhelming receivers
- **State validation**: Prevents writes to closing/closed channels
- **Message type validation**: Prevents sending unregistered message types
- **Sequence validation**: Receiver detects out-of-order or missing chunks

### Testing Considerations

Key test cases:
1. Write large string data (multiple chunks, various sizes)
2. Write large binary data (multiple chunks, various sizes)
3. Write data that exactly fills N chunks (no partial last chunk)
4. Write data that requires N+1 chunks (partial last chunk)
5. Write with `eom: true` and `eom: false`
6. Write with numeric and string message types
7. Write when budget is low (test automatic waiting between chunks)
8. Write when ring buffer is small (test automatic waiting between chunks)
9. Write to closing channel (test `StateError`)
10. Write with unregistered message type (test error)
11. Write with ring buffer wrap-around (test multi-segment handling)
12. Concurrent multi-chunk writes from multiple message types (test interleaving)
13. Write very large string (test encoding across many chunks)
14. Write string with multi-byte UTF-8 characters (test encoding correctness)
15. Verify EOM flag only on last chunk (test flag handling)
16. Verify sequence numbers are consecutive (test sequence assignment)
17. Concurrent multi-chunk writes (test chunk-level interleaving between messages)
18. Shrinkable reservation with waiting chunk (test freed budget wakes next chunk)
19. Large message + small message (test fairness - small doesn't wait for large to complete)
