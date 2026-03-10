# Simple Write Scenario

## Overview

This scenario documents the process of writing a single-chunk data message to a channel. It covers the complete flow from the user calling [`channel.write()`](../../src/channel.esm.js) through encoding the message into the output ring buffer and sending it to the remote transport.

**Key Point**: [`channel.write()`](../../src/channel.esm.js) handles ALL complexity internally - budget waiting, automatic chunking for large messages, string encoding, etc. The user simply calls `write()` and the channel takes care of everything.

**Serialization**: Writes are serialized at the **chunk level** (not write-operation level) to ensure fairness and prevent deadlocks. See [`arch/writer-serialization.md`](../writer-serialization.md) for complete architecture.

## Preconditions

- Transport is started and connected
- Channel is open (bidirectional)
- User has data to send (string or Uint8Array)

**Note**: Channel automatically handles budget and ring buffer space - no preconditions required from user.

## Actors

- **User Code**: Calls [`channel.write()`](../../src/channel.esm.js)
- **Channel**: Orchestrates entire write operation, handles all complexity
- **ChannelFlowControl**: Validates and tracks sending budget
- **OutputRingBuffer**: Provides zero-copy write space
- **VirtualRWBuffer**: Provides DataView-compatible interface for encoding
- **Protocol**: Encodes message header into ring buffer
- **Transport**: Sends encoded message to remote

## Step-by-Step Sequence

### 1. User Initiates Write

**Action**: User calls `await channel.write(data, { eom = true, type = 0 })`

**Parameters**:
- `data`: String or Uint8Array to send (any size - channel handles chunking automatically)
- `eom`: End-of-message flag (default true)
- `type`: Message type (numeric or pre-registered string)

**Responsible Module**: User code

**Example**:
```javascript
// Write a simple text message (any size - channel handles chunking)
await channel.write('Hello, world!', { eom: true, type: 0 });

// Write large text (channel automatically chunks if needed)
await channel.write(largeString, { eom: true, type: 0 });

// Write binary data (any size)
const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
await channel.write(binaryData, { eom: true, type: 1 });

// Write JSON (automatically encoded as string)
await channel.write(JSON.stringify({ status: 'ok' }), { eom: true, type: 2 });
```

**Note**: This scenario focuses on single-chunk writes. For multi-chunk writes (large messages), see [`multi-chunk-write.md`](multi-chunk-write.md).

### 2. Enter Write Serialization Queue

**Action**: Serialize this chunk write with other pending writes

**Logic**:
- Call `await this.#writeQueue.task(async () => { ... })`
- TaskQueue ensures only one chunk write active at a time per channel
- FIFO ordering: Chunks processed in order
- Prevents race conditions and budget theft

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`TaskQueue`](../../../resources/task-queue/src/task-queue.esm.js)

**Data Structures**:
- `channel.#writeQueue`: Per-channel TaskQueue instance
- Serializes all chunk writes for this channel

**Blocking**: Waits for previous chunk writes to complete (transparent to user)

**Note**: Chunk-level serialization (not write-operation level) ensures fairness - small messages don't wait behind large multi-chunk messages.

### 3. Channel Validates State

**Action**: Channel checks if write is allowed

**Validations**:
- Channel state must be `open` (not `closing`, `localClosing`, `remoteClosing`, or `closed`)
- If channel is closing, throw `StateError`

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**State Changes**: None (validation only)

**Error Conditions**:
- `StateError`: Channel is not in `open` state

### 4. Resolve Message Type

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

### 5. Determine Data Size and Chunking Strategy

**Action**: Calculate data size and determine if chunking is needed

**Logic**:
- If `data` is Uint8Array, size is `data.length`
- If `data` is string, worst-case size is `str.length * 3` (UTF-8 encoding)
- Calculate `maxDataBytes = channel.maxChunkBytes - 18` (18 = header size)
- If data fits in single chunk, proceed with simple write (this scenario)
- If data requires multiple chunks, use multi-chunk write (see [`multi-chunk-write.md`](multi-chunk-write.md))

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Data Structures**:
- `channel.maxChunkBytes`: Maximum chunk size (header + data)
- `DATA_HEADER_BYTES = 18`: Fixed header size

**Note**: This scenario assumes data fits in single chunk. For multi-chunk, channel automatically handles it.

### 6. Reserve Channel Sending Budget

**Action**: Reserve channel budget atomically (provisional until chunk completes)

**Logic**:
- Calculate required budget: `chunkSize = 18 + dataSize`
- Call `await flowControl.reserveBudget(chunkSize)`
- [`reserveBudget()`](../../src/channel-flow-control.esm.js) checks budget internally via [`canSend()`](../../src/channel-flow-control.esm.js)
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

**Note**: Budget is **provisional** - may be released if reservation shrinks after encoding.

### 7. Reserve Transport Sending Budget

**Action**: Reserve transport budget atomically (provisional until chunk completes)

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

### 8. Reserve Output Ring Buffer Space

**Action**: Reserve ring buffer space atomically

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

### 9. Assign Sequence Number

**Action**: Assign sequence number to this chunk

**Logic**:
- Call `seq = flowControl.assignSequence(chunkSize)`
- Returns next sequence number (starting at 1)
- Records chunk in in-flight map
- Budget already reserved in step 6

**Responsible Module**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- `flowControl.#nextSendSeq`: Next sequence number to assign
- `flowControl.#inFlightChunks`: Map of seq → bytes

**Returns**: Sequence number for this chunk

**Note**: Sequence assignment is separate from budget reservation (budget reserved first).

### 10. Encode Message Header

**Action**: Write channel data message header into ring buffer reservation

**Logic**:
- Call [`Protocol.encodeChannelHeaderInto(reservation, 0, 2, fields)`](../../src/protocol.esm.js)
- Use sequence number from step 9
- Header type: 2 (channel data message)
- Fields:
  - `totalDataSize`: Data payload size (bytes)
  - `flags`: +1 if `eom` is true
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
  4B: total data size
  2B: flags (+1 if EOM)
  4B: channel ID
  4B: local sequence number
  2B: message type
  ```

**Returns**: Header size (always 18 bytes for channel data messages)

### 11. Write Data Payload

**Action**: Write data payload into ring buffer reservation (after header)

**Logic**:
- **If data is string**:
  - Encode directly into reservation: `reservation.encodeFrom(data, 18)`
  - Returns `{ read, written }` (UTF-16 code units read, bytes written)
  - If not all string encoded (shouldn't happen for single-chunk), handle error
- **If data is Uint8Array**:
  - Copy into reservation: `reservation.set(data, 18)`
  - Returns bytes written
- Data starts at offset 18 (after header)

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)

**Data Structures**:
- [`VirtualRWBuffer.encodeFrom()`](../../src/virtual-buffer.esm.js) for string encoding
- [`VirtualRWBuffer.set()`](../../src/virtual-buffer.esm.js) for binary data
- Both methods handle ring wrap-around transparently

**Note**: For string data, encoding happens directly into ring buffer (zero-copy).

### 12. Adjust Reservation Size (if needed)

**Action**: Shrink reservation if actual data size is less than reserved

**Logic**:
- For string data, actual encoded size may be less than worst-case (`str.length * 3`)
- Calculate actual chunk size: `actualChunkSize = 18 + actualDataSize`
- If `actualChunkSize < reservedSize`:
  - Shrink reservation: `reservation.shrink(actualChunkSize)`
  - Release unused channel budget: `flowControl.releaseBudget(freed)`
  - Release unused transport budget: `transport._releaseBudget(freed)`
  - Update ring reservation: `ring.shrinkReservation(reservation, actualChunkSize)`
- Released budget immediately available to next waiting writer

**Responsible Module**: [`Channel`](../../src/channel.esm.js), [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js), [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js), [`ChannelFlowControl`](../../src/channel-flow-control.esm.js)

**Data Structures**:
- [`VirtualRWBuffer.shrink()`](../../src/virtual-buffer.esm.js) updates internal segments
- [`OutputRingBuffer.shrinkReservation()`](../../src/output-ring-buffer.esm.js) updates reserved bytes
- [`ChannelFlowControl.releaseBudget()`](../../src/channel-flow-control.esm.js) frees budget and wakes waiters
- [`Transport._releaseBudget()`](../../src/transport/base.esm.js) frees transport budget

**Note**: For binary data, size is known upfront, so no shrinking needed.

### 13. Commit Ring Buffer Reservation

**Action**: Mark reservation as ready to send

**Logic**:
- Call [`ring.commit(reservation)`](../../src/output-ring-buffer.esm.js)
- Moves bytes from "reserved" to "committed" (available for sending)
- Advances `writeHead`

**Responsible Module**: [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js)

**Data Structures**:
- `ring.#writeHead`: Advanced by `chunkSize`
- `ring.#reserved`: Decreased by `chunkSize`
- `ring.#count`: Increased by `chunkSize` (now available for sending)

**State Changes**:
- `writeHead = (writeHead + chunkSize) % size`
- `reserved -= chunkSize`
- `count += chunkSize`

### 14. Exit Write Serialization Queue

**Action**: TaskQueue task completes, next chunk can start

**Logic**:
- TaskQueue task function returns
- Next waiting chunk (from this or another message) can start
- Chunk-level serialization ensures fairness

**Responsible Module**: [`TaskQueue`](../../../resources/task-queue/src/task-queue.esm.js)

**Note**: This is when the next chunk write can begin, ensuring no race conditions.

### 15. Resolve Write Promise

**Action**: Return control to user code

**Logic**:
- `channel.write()` promise resolves
- User code can continue (or await next write)

**Responsible Module**: [`Channel`](../../src/channel.esm.js)

**Returns**: `undefined` (promise resolves with no value)

## Postconditions

- Message chunk is encoded and committed to output ring buffer
- Channel flow control updated (in-flight bytes increased)
- Transport flow control updated (sending budget decreased)
- User code can continue (write promise resolved)
- Transport will send data asynchronously (in background)
- Remote transport will eventually send ACK to restore budget

**Note**: The write promise resolves after data is encoded/queued, NOT after it's sent. Actual sending and zero-after-write happen asynchronously in the transport layer.

## Background Transport Operations (After Write Resolves)

These operations happen asynchronously in the transport layer, AFTER the write promise resolves:

### Get Buffers for Sending

**Action**: Transport gets actual Uint8Array buffers to send

**Logic**:
- Call [`ring.getBuffers(chunkSize)`](../../src/output-ring-buffer.esm.js)
- Returns array of 1 or 2 Uint8Array views
- Single array if data doesn't wrap around ring boundary
- Two arrays if data wraps around ring boundary

**Responsible Module**: [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js), [`Transport`](../../src/transport/base.esm.js)

**Returns**: `Uint8Array[]` - Array of 1 or 2 views into ring buffer

**Example**:
```javascript
// No wrap: [Uint8Array(100)]
// Wrapped: [Uint8Array(50), Uint8Array(50)]
```

### Send Data to Remote

**Action**: Transport sends data to remote

**Logic**:
- Transport-specific implementation (HTTP, WebSocket, Worker, Pipe, Nested)
- For byte-stream transports: Write each buffer sequentially
- For Worker transport: Transfer buffers via `postMessage`

**Responsible Module**: Transport implementation (e.g., [`HTTPTransport`](../../src/transport/http.esm.js), [`WebSocketTransport`](../../src/transport/websocket.esm.js))

**Blocking**: May block on I/O (network, pipe, etc.)

**Note**: This happens asynchronously, not during `channel.write()`

### Consume Sent Data

**Action**: Mark data as sent and zero the ring buffer space

**Logic**:
- Call [`ring.consume(chunkSize)`](../../src/output-ring-buffer.esm.js)
- Zeros consumed space (security: prevent data leakage)
- Advances `readHead`

**Responsible Module**: [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js), [`Transport`](../../src/transport/base.esm.js)

**Data Structures**:
- `ring.#readHead`: Advanced by `chunkSize`
- `ring.#count`: Decreased by `chunkSize` (space now available for new reservations)

**State Changes**:
- `readHead = (readHead + chunkSize) % size`
- `count -= chunkSize`
- Consumed space filled with zeros

**Security**: Zero-after-write prevents leaking bytes from previous iterations

**Note**: This happens AFTER data is sent, not during `channel.write()`

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

**Note**: Budget exhaustion and ring buffer full are NOT errors - channel waits automatically.

## Related Scenarios

- [`multi-chunk-write.md`](multi-chunk-write.md) - Writing large messages that exceed `maxChunkBytes` (automatic)
- [`simple-read.md`](simple-read.md) - Reading single-chunk messages
- [`send-flow-control.md`](send-flow-control.md) - Detailed flow control logic
- [`ack-generation-processing.md`](ack-generation-processing.md) - How ACKs restore budget
- [`message-encoding.md`](message-encoding.md) - Protocol encoding details
- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - Output ring buffer operations

## Implementation Notes

### Writer Serialization

**Critical Architecture**: Writes are serialized at the **chunk level** using TaskQueue to prevent race conditions and deadlocks.

**See**: [`arch/writer-serialization.md`](../writer-serialization.md) for complete architecture.

**Key Points**:
- **Chunk-level serialization**: Each chunk serialized independently (not entire write operation)
- **Provisional reservations**: Budget reserved but may be released after shrinking
- **Atomic reservation**: Budget reserved when waiter awakened (before promise resolves)
- **FIFO ordering**: Chunks processed in order (fairness)
- **Three-level serialization**: Channel TaskQueue → Transport TaskQueue → Ring TaskQueue

**Why Chunk-Level**:
- **Fairness**: Small messages don't wait behind large multi-chunk messages
- **Interleaving**: Chunks from different messages can interleave naturally
- **Dynamic chunking**: String encoding requires dynamic chunking (cannot pre-plan)

### User-Facing Simplicity

**Critical Design Principle**: [`channel.write()`](../../src/channel.esm.js) handles ALL complexity internally:
- ✅ Automatic chunk-level serialization (prevents race conditions)
- ✅ Automatic budget reservation (channel and transport level)
- ✅ Automatic ring buffer space reservation
- ✅ Automatic chunking for large messages
- ✅ Automatic string encoding (UTF-8)
- ✅ Automatic header encoding
- ✅ Automatic sequence number assignment
- ✅ Automatic flow control updates
- ✅ Automatic budget release after shrinking

**User Responsibility**: Just call `write()` with data and options. That's it.

### Zero-Copy Writing

The entire write path is designed for zero-copy operation:
1. Reserve space directly in output ring buffer
2. Encode header directly into reservation (via [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js))
3. Encode string data directly into reservation (via [`VirtualRWBuffer.encodeFrom()`](../../src/virtual-buffer.esm.js))
4. Or copy binary data into reservation (via [`VirtualRWBuffer.set()`](../../src/virtual-buffer.esm.js))
5. Get buffer views for transport layer (no additional copy)

**Benefit**: Minimizes memory allocations and copies, maximizes throughput

### String Encoding Strategy

For string data, the implementation uses direct encoding:
1. **Reserve**: Reserve worst-case space (`str.length * 3` bytes for UTF-8)
2. **Encode**: Use [`TextEncoder.encodeInto()`](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder/encodeInto) for zero-copy encoding
3. **Shrink**: Release unused space via [`VirtualRWBuffer.shrink()`](../../src/virtual-buffer.esm.js)

**Benefit**: Avoids intermediate buffer allocation while handling variable-length UTF-8 encoding

### Budget Management

**Three-level resource coordination** (channel handles automatically):
1. **Channel budget**: Per-channel limit (prevents one channel from overwhelming remote)
2. **Transport budget**: Shared across all channels (prevents all channels from overwhelming remote)
3. **Ring buffer space**: Physical buffer limit (prevents memory exhaustion)

**Provisional reservations**:
- Budget reserved at each level (atomic)
- Budget held until chunk completes
- Budget released if reservation shrinks
- Next chunk sees accurate available budget

**Critical**: ACK messages (type 0) do NOT count toward channel budget (transport-level only)

### Ring Buffer Wrap-Around

The output ring buffer may wrap around its boundary:
- Reservation may span two segments (end of buffer + start of buffer)
- [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js) handles this transparently
- [`getBuffers()`](../../src/output-ring-buffer.esm.js) returns 1 or 2 arrays as needed
- Transport layer sends each array sequentially

**Benefit**: Maximizes ring buffer utilization, avoids wasted space

### Security Considerations

- **Zero-after-write**: Consumed ring buffer space is zeroed to prevent data leakage
- **Budget enforcement**: Prevents malicious senders from overwhelming receivers
- **State validation**: Prevents writes to closing/closed channels
- **Message type validation**: Prevents sending unregistered message types

### Performance Considerations

- **Chunk-level serialization**: Minimal TaskQueue overhead (single microtask per chunk)
- **Async waiting**: Budget and ring space waits are async (non-blocking)
- **Atomic reservations**: No race conditions, no budget theft
- **Batch ACKs**: ACKs are batched to minimize overhead (see [`ack-generation-processing.md`](ack-generation-processing.md))
- **Ring buffer**: Minimizes allocations and copies
- **DataView methods**: Zero-copy header encoding via [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)

### Testing Considerations

Key test cases:
1. Write string data (various lengths, including multi-byte UTF-8)
2. Write binary data (various lengths)
3. Write with `eom: true` and `eom: false`
4. Write with numeric and string message types
5. Write when budget is low (test automatic waiting)
6. Write when ring buffer is nearly full (test automatic waiting)
7. Write to closing channel (test `StateError`)
8. Write with unregistered message type (test error)
9. Write data that exceeds `maxChunkBytes` (test automatic chunking)
10. Write with ring buffer wrap-around (test multi-segment handling)
11. Concurrent writes from multiple message types (test chunk-level interleaving)
12. Write large string (test encoding and shrinking)
13. Concurrent writes with budget exhaustion (test serialization prevents budget theft)
14. Shrinkable reservation with waiting writer (test freed budget wakes next writer)
