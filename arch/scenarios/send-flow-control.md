# Send Flow Control Scenario

## Overview

This scenario documents the sending side of flow control - how a channel manages its sending budget, waits for budget availability, tracks in-flight chunks, and processes incoming ACKs to restore budget. This is the sender's perspective of the flow control system.

**Key Point**: Send flow control requires **three resources** before a chunk can be sent:
1. **Channel budget** (per-channel limit) - prevents one channel from overwhelming remote
2. **Transport budget** (shared across all channels) - prevents all channels combined from overwhelming remote
3. **Ring buffer space** (physical memory) - provides space for encoding the message

All three must be available before a chunk can be sent.

## Preconditions

- Transport is started and operational
- Channel is open (bidirectional)
- Remote transport has communicated its `maxBufferBytes` (channel budget limit)
- Transport has its own `maxBufferBytes` (transport budget limit)
- Sender wants to send data

## Actors

- **Channel**: Initiates write operations, coordinates flow control
- **ChannelFlowControl**: Manages channel-level sending budget and in-flight tracking
- **Transport**: Manages transport-level sending budget (shared across channels)
- **OutputRingBuffer**: Provides physical buffer space for encoding
- **Remote Transport**: Sends ACKs to restore budget

## Key Concepts

### Three-Resource Coordination System

**Channel Budget** (per-channel):
- Limit: Remote's `maxBufferBytes` for this channel
- Tracks: In-flight bytes for this channel only
- Budget: `remoteMaxBufferBytes - inFlightBytes`
- Purpose: Prevents one channel from overwhelming remote

**Transport Budget** (shared):
- Limit: Remote's transport-level `maxBufferBytes`
- Tracks: In-flight bytes across all channels
- Budget: `transportMaxBufferBytes - transportInFlightBytes`
- Purpose: Prevents all channels combined from overwhelming remote

**Ring Buffer Space** (physical memory):
- Limit: Ring buffer size (e.g., 256KB)
- Tracks: Reserved and committed bytes
- Space: `ringSize - reserved - committed`
- Purpose: Provides physical memory for encoding messages

**All three must be available** before a chunk can be sent.

### Budget Lifecycle

1. **Reserve**: Reserve budget atomically (channel → transport → ring)
2. **Assign**: Assign sequence number and record in-flight
3. **Encode**: Encode message into ring buffer
4. **Shrink**: Release unused budget if reservation shrinks
5. **Send**: Transport sends data (background)
6. **ACK**: Remote sends ACK after consuming
7. **Restore**: Process ACK to restore budget

### In-Flight Tracking

**Channel Level**:
- Map: `seq → bytes` (sequence number to chunk size)
- Counter: `inFlightBytes` (total bytes in flight)
- Sequence: `nextSendSeq` (next sequence to assign)

**Transport Level**:
- Counter: `transportInFlightBytes` (total across all channels)
- No sequence tracking (channels handle that)

### Budget Waiting and TaskQueue Serialization

**TaskQueue Serialization** (Critical Architecture):
- **Channel level**: TaskQueue serializes entire chunk operations (reserve → encode → commit)
- **Transport level**: TaskQueue serializes budget reservations across all channels (FIFO round-robin)
- **Ring buffer level**: TaskQueue serializes space reservations (single waiter model)

**Single Waiter Model**:
- **Channel**: Single `#waiter` object (not array) - TaskQueue ensures only one chunk waiting for budget at a time
- **Transport**: Single `#waiter` object (not array) - TaskQueue ensures only one channel waiting for budget at a time
- **Ring**: Single `#spaceWaiter` object (not array) - TaskQueue ensures only one chunk waiting for space at a time

**"Waiting to Wait"**:
- Other chunks/channels are in TaskQueue (not in waiter queue)
- TaskQueue processes operations in FIFO order
- Only the currently-executing operation can be in waiter state
- Stats reporting: the number of pending write operations = the task queue size
  - The current operation is running (already got its resource) if #waiter is null; it's still waiting if #waiter is not null

**Atomic Reservation**:
- Budget reserved when waiter awakened (before promise resolves)
- Prevents budget theft (another writer stealing budget)
- Ensures fairness and prevents starvation

## Step-by-Step Sequence

### Part 1: Budget Reservation

#### Step 1: Check Channel Budget

**Actor**: ChannelFlowControl

**Action**: Check if sufficient channel budget is available.

**Method**: [`ChannelFlowControl.canSend(chunkBytes)`](../../src/channel-flow-control.esm.js:105)

**Details**:
- Calculate sending budget: `sendingBudget = remoteMaxBufferBytes - inFlightBytes`
- If `remoteMaxBufferBytes === 0`, budget is `Infinity` (unlimited)
- Check if `sendingBudget >= chunkBytes`
- Return `true` if sufficient, `false` otherwise

**Data Structures**:
- `#remoteMaxBufferBytes`: Remote's channel buffer limit
- `#inFlightBytes`: Total bytes in flight for this channel
- `#inFlightChunks`: Map of `seq → bytes`

**Decision Point**:
- **Sufficient budget**: Proceed to Step 3 (reserve channel budget)
- **Insufficient budget**: Proceed to Step 2 (wait for channel budget)

#### Step 2: Wait for Channel Budget

**Actor**: ChannelFlowControl

**Action**: Wait asynchronously for channel budget to become available.

**Method**: [`ChannelFlowControl.waitForBudget(chunkBytes)`](../../src/channel-flow-control.esm.js:116)

**Details**:
1. Check if can send now (via [`canSend()`](../../src/channel-flow-control.esm.js:105))
2. If yes, resolve immediately
3. If no, create waiter object: `{ bytes: chunkBytes, resolve }`
4. Set as single waiter (not added to queue - TaskQueue ensures serialization)
5. Return promise that resolves when budget available

**Data Structures**:
- `#waiter`: Single `{ bytes, resolve }` object (not array)
- TaskQueue ensures only one chunk waiting for budget at a time
- Other chunks are "waiting to wait" in TaskQueue

**Blocking**: Waits asynchronously for ACKs to restore budget

**Note**: Budget is **not reserved** yet - just waiting for availability. Actual reservation happens when waiter is awakened (atomic).

#### Step 3: Reserve Channel Budget (Atomic)

**Actor**: ChannelFlowControl

**Action**: Reserve channel budget atomically (provisional until chunk completes).

**Method**: [`ChannelFlowControl.reserveBudget(chunkBytes)`](../../src/channel-flow-control.esm.js) (new method per writer serialization architecture)

**Details**:
1. Wait for budget availability (via [`waitForBudget()`](../../src/channel-flow-control.esm.js:116))
2. **Atomically reserve budget** when awakened:
   - Increment `#inFlightBytes` by `chunkBytes`
   - Budget now provisionally reserved
3. Return (budget reserved)

**State Changes**:
- `#inFlightBytes += chunkBytes` (provisional reservation)

**Note**: Budget is **provisional** - may be released if reservation shrinks after encoding. Sequence number not assigned yet.

#### Step 4: Reserve Transport Budget (Atomic)

**Actor**: Transport

**Action**: Reserve transport budget atomically (provisional until chunk completes).

**Method**: [`Transport._reserveBudget(bytes)`](../../src/transport/base.esm.js) (new method per writer serialization architecture)

**Details**:
1. Enter transport budget queue (TaskQueue for FIFO round-robin)
2. Wait for transport budget availability
3. **Atomically reserve budget** when awakened:
   - Increment `#transportInFlightBytes` by `bytes`
   - Budget now provisionally reserved
4. Return (budget reserved)

**Data Structures**:
- `#budgetQueue`: TaskQueue for cross-channel FIFO ordering
- `#transportBudget`: TransportFlowControl instance
- `#transportInFlightBytes`: Total bytes in flight across all channels

**Blocking**: Waits asynchronously for transport budget (FIFO round-robin across channels)

**Note**: Transport budget is shared across all channels. FIFO ordering ensures fairness.

#### Step 5: Reserve Ring Buffer Space

**Actor**: OutputRingBuffer

**Action**: Reserve ring buffer space for encoding.

**Method**: [`OutputRingBuffer.reserveAsync(length)`](../../src/output-ring-buffer.esm.js) (new method per writer serialization architecture)

**Details**:
1. Enter ring reservation queue (TaskQueue for serialization)
2. Check if sufficient space available
3. If yes, reserve immediately and return VirtualRWBuffer
4. If no, wait for space to become available (single waiter model)
5. **Atomically reserve space** when awakened

**Data Structures**:
- `#reserveQueue`: TaskQueue for serializing reservations
- `#spaceWaiter`: Single waiter object `{ bytes, resolve }`
- `#writeHead`: Current write position
- `#reserved`: Reserved bytes (not yet committed)

**Returns**: [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js) with 1 or 2 segments

**Blocking**: Waits asynchronously for ring space

**Note**: Ring buffer space is physical memory limit (not flow control budget).

### Part 2: Sequence Assignment and Encoding

#### Step 6: Assign Sequence Number

**Actor**: ChannelFlowControl

**Action**: Assign sequence number to this chunk.

**Method**: [`ChannelFlowControl.assignSequence(chunkBytes)`](../../src/channel-flow-control.esm.js) (new method per writer serialization architecture)

**Details**:
1. Get next sequence number: `seq = #nextSendSeq++`
2. Record in in-flight map: `#inFlightChunks.set(seq, chunkBytes)`
3. Return sequence number

**Data Structures**:
- `#nextSendSeq`: Next sequence number to assign (starts at 1)
- `#inFlightChunks`: Map of `seq → bytes`
- `#inFlightBytes`: Already incremented in Step 3 (provisional)

**State Changes**:
- `#nextSendSeq++`
- `#inFlightChunks.set(seq, chunkBytes)`

**Note**: Sequence assignment is separate from budget reservation. Budget already reserved in Step 3.

#### Step 7: Encode Message

**Actor**: Channel, Protocol

**Action**: Encode message header and data into ring buffer reservation.

**Details**:
1. Encode header: [`Protocol.encodeChannelHeaderInto(reservation, 0, 2, fields)`](../../src/protocol.esm.js)
2. Encode data: `reservation.encodeFrom(str)` or `reservation.set(bytes)`
3. Calculate actual chunk size (may be less than reserved for strings)

**Data Structures**:
- `reservation`: VirtualRWBuffer from Step 5
- Header: 18 bytes (type 2, channel data message)
- Data: Variable length

**Note**: See [`simple-write.md`](simple-write.md) for complete encoding details.

#### Step 8: Shrink Reservation (if needed)

**Actor**: Channel, ChannelFlowControl, Transport, OutputRingBuffer

**Action**: Release unused budget if actual size is less than reserved.

**Details**:
1. Calculate freed bytes: `freed = reservedSize - actualSize`
2. If `freed > 0`:
   - Shrink reservation: `reservation.shrink(actualSize)`
   - Release channel budget: [`flowControl.releaseBudget(freed)`](../../src/channel-flow-control.esm.js) (new method)
   - Release transport budget: [`transport._releaseBudget(freed)`](../../src/transport/base.esm.js) (new method)
   - Update ring reservation: `ring.shrinkReservation(reservation, actualSize)`

**State Changes**:
- `#inFlightBytes -= freed` (channel level)
- `#transportInFlightBytes -= freed` (transport level)
- `#reserved -= freed` (ring buffer level)
- Waiting writers awakened if now sufficient budget

**Note**: Released budget immediately available to next waiting writer.

#### Step 9: Commit Ring Buffer Reservation

**Actor**: OutputRingBuffer

**Action**: Mark reservation as ready to send.

**Method**: [`OutputRingBuffer.commit(reservation)`](../../src/output-ring-buffer.esm.js)

**Details**:
1. Move bytes from "reserved" to "committed"
2. Advance `writeHead`
3. Data now available for transport to send

**State Changes**:
- `#writeHead = (writeHead + chunkSize) % size`
- `#reserved -= chunkSize`
- `#count += chunkSize`

**Note**: Chunk is now queued for sending. Transport will send asynchronously.

### Part 3: ACK Processing and Budget Restoration

#### Step 10: Receive ACK Message

**Actor**: Transport

**Action**: Receive ACK message from remote transport.

**Details**:
1. Read bytes from underlying transport
2. Parse header to determine type (type 0 = ACK)
3. Decode ACK: [`Protocol.decodeAckHeaderFrom(buffer, offset)`](../../src/protocol.esm.js:273)
4. Extract: `{ channelId, baseSeq, ranges }`

**Data Structures**:
- `buffer`: VirtualBuffer (input buffer)
- ACK info: `{ channelId, baseSeq, ranges }`

**Note**: See [`ack-generation-processing.md`](ack-generation-processing.md) for complete ACK format details.

#### Step 11: Find Channel

**Actor**: Transport

**Action**: Look up channel by channel ID.

**Details**:
- Look up channel ID in transport's channel map
- If channel not found, emit `protocolViolation` event (unknown channel)

**Decision Point**:
- **Channel found**: Proceed to Step 12
- **Channel not found**: Emit `protocolViolation` event, discard ACK, stop

#### Step 12: Process ACK (Channel Level)

**Actor**: ChannelFlowControl

**Action**: Process ACK and restore channel sending budget.

**Method**: [`ChannelFlowControl.processAck(baseSeq, ranges)`](../../src/channel-flow-control.esm.js:156)

**Details**:
1. Validate ACK sequences:
   - No duplicate ACKs (protocol violation: `DuplicateAck`)
   - No premature ACKs (protocol violation: `PrematureAck`)
2. For each ACK'd sequence:
   - Look up bytes in `#inFlightChunks` map
   - Remove from map
   - Subtract from `#inFlightBytes`
   - Accumulate `bytesFreed`
3. Wake up waiting senders (FIFO order)
4. Return `bytesFreed`

**State Changes**:
- `#inFlightChunks`: ACK'd sequences removed
- `#inFlightBytes -= bytesFreed`
- Waiting senders awakened (if sufficient budget now available)

**Protocol Violations** (emitted as events, not thrown):
- `DuplicateAck`: Sequence already ACK'd
- `PrematureAck`: Sequence not yet sent
- Transport emits `protocolViolation` event with `{ reason, details }`
- Event handler decides action (close channel, close transport, or ignore)

#### Step 13: Wake Waiting Senders (Channel Level)

**Actor**: ChannelFlowControl

**Action**: Wake up waiting senders that now have sufficient budget.

**Method**: [`ChannelFlowControl.#processWaiters()`](../../src/channel-flow-control.esm.js:231)

**Details**:
1. Calculate current budget: `sendingBudget = remoteMaxBufferBytes - inFlightBytes`
2. Check if single waiter exists and has sufficient budget
3. If waiter exists and budget sufficient:
   - **Atomically reserve budget**: `#inFlightBytes += waiter.bytes`
   - Wake waiter: `waiter.resolve()`
   - Clear waiter: `#waiter = null`

**State Changes**:
- `#waiter`: Cleared after awakening (set to null)
- `#inFlightBytes`: Increased by awakened waiter's reservation (atomic)

**Note**: Atomic reservation when awakening prevents budget theft. Single waiter model - TaskQueue ensures only one chunk waiting at a time.

#### Step 14: Process ACK (Transport Level)

**Actor**: Transport

**Action**: Restore transport sending budget.

**Details**:
1. Get `bytesFreed` from channel's `processAck()` return value
2. Subtract from `#transportInFlightBytes`
3. Wake up waiting channels (FIFO order)

**State Changes**:
- `#transportInFlightBytes -= bytesFreed`
- Waiting channels awakened (if sufficient budget now available)

**Note**: Transport budget restoration is simpler (no sequence tracking, no validation).

#### Step 15: Wake Waiting Channels (Transport Level)

**Actor**: Transport

**Action**: Wake up waiting channels that now have sufficient budget.

**Details**:
1. Calculate current transport budget
2. Process waiters in FIFO order (round-robin across channels)
3. For each waiter:
   - Check if sufficient budget
   - If yes:
     - **Atomically reserve budget**: `#transportInFlightBytes += waiter.bytes`
     - Wake waiter: `waiter.resolve()`
     - Deduct from remaining budget
   - If no: Stop processing

**State Changes**:
- Transport waiters: Awakened waiters removed from queue
- `#transportInFlightBytes`: Increased by awakened waiters' reservations (atomic)

**Note**: FIFO round-robin ensures fairness across channels.

## Postconditions

### After Budget Reservation

- Channel budget reserved (provisional)
- Transport budget reserved (provisional)
- Ring buffer space reserved
- Sequence number assigned
- Chunk recorded in in-flight map

### After Encoding

- Message encoded into ring buffer
- Unused budget released (if reservation shrunk)
- Reservation committed (ready to send)

### After ACK Processing

- In-flight chunks removed from tracking
- Channel budget restored
- Transport budget restored
- Waiting senders/channels awakened

## Error Conditions

### Budget Exhaustion

- **Not an error**: Channel waits automatically
- Waits asynchronously for ACKs to restore budget
- FIFO ordering ensures fairness

### Ring Buffer Full

- **Not an error**: Channel waits automatically
- Waits asynchronously for space to become available
- Single waiter model (TaskQueue ensures serialization)

### Protocol Violations

Protocol violations are detected when processing incoming ACKs from remote transport. These are **events** (not exceptions) because they're triggered by external traffic, not local requests.

1. **Duplicate ACK**: Sequence already ACK'd
   - Transport emits `protocolViolation` event: `{ reason: 'Duplicate ACK', details: { channelId, seq } }`
   - Event handler decides action
2. **Premature ACK**: Sequence not yet sent
   - Transport emits `protocolViolation` event: `{ reason: 'Premature ACK', details: { channelId, seq } }`
   - Event handler decides action
3. **Unknown Channel**: ACK for channel that doesn't exist
   - Transport emits `protocolViolation` event: `{ reason: 'Unknown channel', details: { channelId } }`
   - Event handler decides action

**Note**: Protocol violations are emitted as events (not thrown as exceptions) because they're triggered by external traffic. The application decides how to handle them (close channel, close transport, log and ignore, etc.).

### Channel State Errors

- **Channel closing**: `StateError` thrown
- **Channel closed**: `StateError` thrown

## Related Scenarios

- [`simple-write.md`](simple-write.md) - Complete write flow including send flow control
- [`multi-chunk-write.md`](multi-chunk-write.md) - Multi-chunk write with per-chunk budget waiting
- [`receive-flow-control.md`](receive-flow-control.md) - Receiving side of flow control
- [`ack-generation-processing.md`](ack-generation-processing.md) - ACK generation and processing
- [`transport-budget.md`](transport-budget.md) - Transport-level budget management
- [`channel-budget.md`](channel-budget.md) - Channel-level budget management
- [`protocol-violation.md`](protocol-violation.md) - Protocol violation handling

## Implementation Notes

### Three-Resource Coordination

**Critical Architecture**: Send flow control requires three resources:

1. **Channel Budget** (per-channel):
   - Prevents one channel from overwhelming remote
   - Tracks in-flight bytes for this channel only
   - FIFO queue of waiting writes (per-channel)

2. **Transport Budget** (shared):
   - Prevents all channels combined from overwhelming remote
   - Tracks in-flight bytes across all channels
   - FIFO queue of waiting channels (round-robin fairness)

3. **Ring Buffer Space** (physical memory):
   - Provides space for encoding messages
   - Tracks reserved and committed bytes
   - Single waiter model (TaskQueue ensures serialization)

**All three must be available** before a chunk can be sent.

### Atomic Budget Reservation

**Critical Architecture**: Budget is reserved **atomically** when waiter is awakened.

**Problem**: Without atomic reservation, budget theft can occur:
1. Writer A waits for 10KB budget
2. Budget becomes available (10KB freed)
3. Writer B steals budget before A can reserve it
4. Writer A wakes up but budget is gone (deadlock)

**Solution**: Reserve budget **before** resolving promise:
1. Writer A waits for 10KB budget
2. Budget becomes available (10KB freed)
3. **Atomically reserve 10KB for A** (before resolving promise)
4. Resolve A's promise (budget already reserved)
5. Writer B must wait for next budget restoration

**Implementation**: [`ChannelFlowControl.#processWaiters()`](../../src/channel-flow-control.esm.js:231) reserves budget before calling `waiter.resolve()`.

### Provisional Reservations

**Critical Architecture**: Budget reservations are **provisional** until chunk completes.

**Rationale**:
- String encoding size is unknown upfront (variable-length UTF-8)
- Reserve worst-case: `str.length * 3` bytes
- Encode: Actual size may be less (e.g., 1500 bytes)
- Shrink: Release unused budget (e.g., 1500 bytes freed)
- Next writer sees accurate available budget

**Implementation**:
- Reserve budget in Step 3 (provisional)
- Encode in Step 7 (actual size determined)
- Shrink in Step 8 (release unused budget)
- Released budget immediately available to next writer

### FIFO Ordering and Fairness

**Critical Architecture**: FIFO ordering at all levels ensures fairness.

**TaskQueue Serialization** (Complete Chunk Operations):
- **Channel level**: TaskQueue serializes **entire chunk operations** from start to finish:
  - Reserve channel budget (atomic, provisional)
  - Reserve transport budget (atomic, provisional)
  - Reserve ring buffer space (atomic)
  - Assign sequence number
  - Encode header and data
  - Shrink reservation if needed (release unused budget)
  - Commit to ring buffer
  - **Only then** does the next chunk operation begin
- **Transport level**: TaskQueue serializes budget reservations across all channels (FIFO round-robin)
- **Ring buffer level**: TaskQueue serializes space reservations (single waiter model)

**Why Complete Serialization**:
- **Shrinkable reservations**: Actual size only known after encoding (text encoding is variable-length UTF-8)
- **Budget accuracy**: Next chunk must see freed budget from shrinking
- **No race conditions**: Prevents budget theft between reserve and encode
- **Fairness**: Chunks from different messages can interleave (e.g., `A1 B1 A2 C1 A3...`)

**Single Waiter Model**:
- Only one waiter at a time at each level (not arrays)
- TaskQueue ensures only one operation waiting for resources at a time
- Other operations are "waiting to wait" in TaskQueue (not in waiter queue)
- FIFO ordering implicit (TaskQueue processes in order)

**Channel Level**:
- Per-channel TaskQueue of **complete chunk operations** (not just budget waiting)
- Prevents starvation within channel
- Large requests don't block small requests indefinitely (chunk-level serialization)

**Transport Level**:
- Cross-channel TaskQueue (round-robin)
- Prevents starvation across channels
- One channel doesn't monopolize transport budget

**Ring Buffer Level**:
- Per-ring TaskQueue for space reservations
- Single waiter model (only one chunk waiting for space at a time)
- FIFO ordering implicit (TaskQueue processes in order)

### Budget Includes Headers

**Critical Protocol Rule**: Budget includes **ALL** channel message headers (control and data).

**Channel Budget**:
- Control messages (type 1): Header + data
- Data messages (type 2): Header + data
- Budget: `chunkBytes = headerBytes + dataBytes`

**Transport Budget**:
- Same as channel budget (headers + data)
- ACK messages (type 0): **Do NOT count** (transport-level, fire-and-forget)

**Rationale**: Headers consume buffer space on receiver, so they must count toward budget.

### ACK Messages and Budget

**Critical Architecture**: ACK messages (type 0) do **NOT** count toward channel or transport budget.

**Rationale**:
- ACKs are fire-and-forget (no ACK-on-ACK)
- If ACKs used transport budget, that budget would never be restored
- ACKs use ring buffer space only (freed immediately after send)

**Implementation**: See [`ack-generation-processing.md`](ack-generation-processing.md) for complete details.

### Sequence Number Assignment

**Critical Protocol Rule**: Sequence numbers are assigned **consecutively** starting at 1.

**Channel Level**:
- Each channel has its own sequence space
- Sequence numbers start at 1 (not 0)
- Increment for each chunk sent
- Out-of-order sequences are protocol violations

**Transport Level**:
- No sequence tracking (channels handle that)
- Transport only tracks total in-flight bytes

### In-Flight Tracking

**Channel Level**:
- Map: `seq → bytes` (sequence number to chunk size)
- Counter: `inFlightBytes` (total bytes in flight)
- Sequence: `nextSendSeq` (next sequence to assign)

**Transport Level**:
- Counter: `transportInFlightBytes` (total across all channels)
- No sequence tracking (channels handle that)

**Rationale**: Channel-level tracking enables ACK validation and budget restoration. Transport-level tracking is simpler (just a counter).

### Protocol Violation Detection

**Critical Architecture**: Validate all ACKs to detect malicious or buggy remote transports.

**Validations**:
1. **No duplicate ACKs**: Sequence already ACK'd
2. **No premature ACKs**: Sequence not yet sent
3. **No unknown channels**: Channel doesn't exist

**Handling**:
- Protocol violations are **events** (not exceptions) because they're triggered by external traffic
- Transport emits `protocolViolation` event with `{ reason, details }`
- Event handler decides action: close channel, close transport, log and ignore, etc.
- No default action - application must decide policy

**Rationale**: Prevents malicious remote from disrupting flow control. Events (not exceptions) allow application to decide policy.

### Performance Considerations

**Async Waiting**:
- Budget and ring space waits are async (non-blocking)
- Allows other operations to proceed while waiting
- Minimal overhead (single microtask per waiter)

**Atomic Reservations**:
- No race conditions, no budget theft
- Ensures fairness and prevents starvation
- Minimal overhead (single atomic operation per waiter)

**FIFO Ordering**:
- Prevents starvation at all levels
- Ensures fairness across channels and writes
- Minimal overhead (shift from front of array)

**Batch ACKs**:
- Multiple chunks ACK'd together (range encoding)
- Minimizes ACK overhead
- See [`ack-generation-processing.md`](ack-generation-processing.md)

## Test Scenarios

### Budget Reservation

1. Sufficient channel budget, reserve immediately
2. Insufficient channel budget, wait for ACK
3. Sufficient transport budget, reserve immediately
4. Insufficient transport budget, wait for ACK
5. Both budgets sufficient, reserve both immediately
6. Channel budget sufficient but transport budget insufficient, wait for transport ACK

### Budget Waiting

7. Single waiter, ACK arrives, waiter awakened
8. Multiple waiters, ACK arrives, wake in FIFO order
9. Large waiter, small ACK, waiter remains waiting
10. Small waiter, large ACK, waiter awakened with budget to spare

### Atomic Reservation

11. Two waiters, budget for one, first waiter gets budget (no theft)
12. Waiter awakened, budget reserved before promise resolves

### Provisional Reservations

13. Reserve worst-case, encode less, shrink, next waiter sees freed budget
14. Reserve exact size, no shrinking needed

### Sequence Assignment

15. First chunk, sequence 1 assigned
16. Multiple chunks, consecutive sequences assigned
17. Sequence recorded in in-flight map

### ACK Processing

18. Receive ACK, budget restored (channel level)
19. Receive ACK, budget restored (transport level)
20. Receive ACK, waiting senders awakened
21. Receive duplicate ACK, `ProtocolViolationError` thrown
22. Receive premature ACK, `ProtocolViolationError` thrown
23. Receive ACK for unknown channel, `protocolViolation` event emitted

### FIFO Ordering

24. Multiple waiters, ACKs arrive, wake in FIFO order
25. Large waiter first, small waiter second, small ACK arrives, large waiter remains waiting
26. Cross-channel FIFO, round-robin fairness

### Budget Includes Headers

27. Send control message, budget includes header + data
28. Send data message, budget includes header + data
29. Receive ACK, budget restored includes header + data

### Ring Buffer Space

30. Sufficient ring space, reserve immediately
31. Insufficient ring space, wait for space
32. Ring space freed after send, waiter awakened
