# PolyTransport Test Plan

Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung

## Overview

This document defines the comprehensive testing strategy for the PolyTransport library. Tests are organized by component, with clear success criteria and coverage goals.

**Last Updated**: 2026-01-03 - Updated to reflect requirements changes from 2026-01-02-A (see [`arch/20260103-requirements-update-analysis.md`](20260103-requirements-update-analysis.md))

## Recent Requirements Updates (2026-01-02-A)

The following test plan updates reflect changes from [`requirements.md`](requirements.md:587) lines 587-600:

1. **API Changes**: All `readChunk`/`readMessage` tests renamed to `read` (no message-level tests)
2. **Automatic Chunking Tests**: New tests for `write()` auto-chunking behavior
3. **Concurrent Filtered Reads**: New tests verifying filtered reads don't interfere
4. **Write Interleaving**: New tests for chunk-level atomicity with write interleaving
5. **Two-Level Budget Tests**: New tests for transport + channel budget enforcement
6. **Remove `maxMessageSize` Enforcement Tests**: It's informational only now

See the analysis document for detailed test migration guidance.

## Testing Framework

- **Runtime**: Deno
- **Test Runner**: `deno test`
- **Assertions**: `https://deno.land/std@0.177.0/testing/asserts.ts`
- **Coverage Target**: > 90% line coverage
- **Test Structure**: Deno.test() with descriptive names

## Test Organization

### Directory Structure

```
test/
├── unit/
│   ├── protocol.test.js
│   ├── buffer-manager.test.js
│   ├── protocol-codec.test.js
│   ├── transport-output-pump.test.js
│   ├── flow-control.test.js
│   ├── channel.test.js
│   └── transport/
│       ├── base.test.js
│       ├── virtual.test.js
│       ├── pipe.test.js
│       ├── worker.test.js
│       ├── websocket.test.js
│       ├── http.test.js
│       └── nested.test.js
├── integration/
│   ├── jsmaws-scenarios.test.js
│   ├── multi-channel.test.js
│   ├── flow-control-stress.test.js
│   └── error-recovery.test.js
├── performance/
│   ├── throughput.test.js
│   ├── latency.test.js
│   └── memory.test.js
├── security/
│   ├── dos-prevention.test.js
│   ├── resource-limits.test.js
│   └── untrusted-code.test.js
└── helpers/
    ├── test-utils.esm.js
    ├── mock-transport.esm.js
    └── assertions.esm.js
```

## Unit Tests

### 1. Protocol Layer Tests ([`test/unit/protocol.test.js`](../test/unit/protocol.test.js))

#### Protocol Constants + Validation (pure)
- ✓ Verify protocol constants (message types, reserved channels, etc)
- ✓ Validate decoded header field ranges
- ✓ Reject malformed headers

#### Message Type Constants
- ✓ Verify ACK type = 0
- ✓ Verify channel-control type = 2
- ✓ Verify channel-data type = 3

#### Header Validation
- ✓ Validate required fields present
- ✓ Validate field value ranges
- ✓ Validate data size consistency
- ✓ Reject invalid flag combinations

#### Protocol Version
- ✓ Current version = 1
- ✓ Version mismatch detection
- ✓ Future version compatibility

**Test Count**: ~25 tests

### 1b. Byte-stream Protocol Codec + Output Pump Tests (Update 2025-12-29-A)

These tests exist because Update 2025-12-29-A requires protocol encoding/decoding to be non-allocating and compatible with ring-buffer I/O (see [`arch/requirements.md`](requirements.md:475)).

#### Protocol codec (encode-into / decode-from) ([`test/unit/protocol-codec.test.js`](../test/unit/protocol-codec.test.js))
- ✓ Deterministic header sizing functions match the protocol formats:
  - Channel-control/channel-data header size fixed at 18 bytes ([`arch/requirements.md`](requirements.md:383))
  - ACK header size `toEven(13 + rangeCount)` ([`arch/requirements.md`](requirements.md:369))
- ✓ `encode*Into` writes into a caller-provided `Uint8Array` window (no allocations)
- ✓ `encode*Into` rejects when destination capacity is insufficient
- ✓ `decode*From` can decode headers that span ring wrap-around / multi-range buffers

#### Transport-level output pump ([`test/unit/transport-output-pump.test.js`](../test/unit/transport-output-pump.test.js))
- ✓ ACK priority: pending ACK frames are emitted before starting any data frame ([`arch/requirements.md`](requirements.md:492))
- ✓ ACK-only flush: ACKs are emitted even when no data is pending
- ✓ Frame atomicity: for each data frame, bytes on the wire are `[header][payload]` with no interleaving bytes inserted
- ✓ Payload slicing: large payloads can be emitted as multiple consecutive frames; only the final frame sets EOM ([`arch/requirements.md`](requirements.md:181))
- ✓ Direct-to-ring outbound payload reservations (single-thread endpoints): caller writes payload bytes into ring-backed views (contiguous or split) and commit produces `[header][payload]` on the wire
	- Reservation views must not escape the immediate write/commit lifecycle (no output-side pinning or migration)
	- If a caller cannot complete promptly, it must `release()` and fall back to pool-managed buffering

### 2. Buffer Management Tests ([`test/unit/buffer-manager.test.js`](../test/unit/buffer-manager.test.js))

#### VirtualBuffer Class
- ✓ Create single-range view
- ✓ Create multi-range view
- ✓ Create cross-buffer view
- ✓ Read bytes from virtual buffer
- ✓ VirtualBuffer read-only vs read/write modes:
  - read-only (default) for inbound data
  - read/write for outbound ring-backed reservations (contiguous or split across wrap)
- ✓ Slice virtual buffer
- ✓ Concatenate virtual buffers
- ✓ Update when underlying buffer moves

#### BufferPool Class
- ✓ Allocate 1K buffer
- ✓ Allocate 4K buffer
- ✓ Allocate 16K buffer
- ✓ Allocate 64K buffer
- ✓ Return buffer to pool
- ✓ Reuse pooled buffers
- ✓ Grow pool when needed
- ✓ Shrink pool when above high-water mark
- ✓ Respect low-water mark

#### BufferManager Class
- ✓ Track buffer references
- ✓ Release buffer when no references
- ✓ Prevent premature release
- ✓ Handle ring buffer scenarios
- ✓ Transfer buffers between contexts
- ✓ Worker buffer pool management
- ✓ Request buffers from main thread
- ✓ Return excess buffers to main thread

#### BYOB Reader Support
- ✓ Detect BYOB support
- ✓ Use BYOB when available
- ✓ Fall back to default reader
- ✓ Ring buffer with BYOB

#### Ring-backed views: pin registry + targeted reclaim migration

These tests cover input-ring-only pinning and targeted migration semantics as defined in [`arch/requirements.md`](requirements.md:165).

- ✓ Pin handle captures `{ epoch, start, length }` and provides explicit `release()`
- ✓ Pin overlap detection works for:
	- non-wrapped pins
	- wrapped pins (treated as two windows)
	- reclaim ranges that also wrap
- ✓ Targeted reclaim: when reclaiming a range, only overlapping pins are migrated
- ✓ Non-overlapping pins are not touched
- ✓ After migration, the associated `VirtualBuffer` transparently references pool-managed buffers
- ✓ After migration, pin is released and removed from the ring registry
- ✓ Epoch/cycle prevents false overlap when indices repeat across wrap-around reuse
- ✓ Failure propagation: if a pin holder cannot migrate/release and rejects, the reclaim operation fails and the owning transport/reader treats it as fatal (shutdown)

**Test Count**: ~30 tests

### 3. Flow Control Tests ([`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js))

**Status**: Implemented (Phase 1.3) with unit coverage for credit blocking, duplicate-ACK detection, and range-based ACK generation.

**⚠️ CONFORMANCE NOTE**: Needs extension for two-level budget system (transport + channel budgets) per 2026-01-02-A.

#### Credit Management
- ✓ Initialize credits from remote buffer size
- ✓ Consume credits on send
- ✓ Restore credits on ACK
- ✓ Block when credits exhausted
- ✓ Unblock when credits available
- ✓ Calculate local budget correctly
- **NEW**: ✓ Two-level budget: transport budget
- **NEW**: ✓ Two-level budget: channel budget
- **NEW**: ✓ Two-level budget: writes must satisfy both
- **NEW**: ✓ Two-level budget: channel limits validated against transport limits

#### Chunk Tracking
- ✓ Assign sequence numbers (starting at 1)
- ✓ Track in-flight chunks
- ✓ Remove acknowledged chunks
- ✓ Handle out-of-order ACKs
- ✓ Handle range-based ACKs
- **NEW**: ✓ Out-of-order chunk consumption (per 2026-01-02-A requirement)

#### ACK Generation
- ✓ Generate ACK for single chunk
- ✓ Generate ACK for range of chunks
- ✓ Generate ACK with skip ranges
- ✓ Batch ACKs when possible
- ✓ Send ACK at low-water mark
- **NEW**: ✓ ACK generation with out-of-order consumption

#### Protocol Violations
- ✓ Detect duplicate ACK
- ✓ Trigger protocolViolation event
- ✓ Close transport unless prevented
- ✓ Close channel unless prevented
- ✓ Detect credit overflow

#### Backpressure
- ✓ Apply backpressure when credits low
- ✓ Release backpressure when credits restored
- ✓ Handle multiple waiting writes
- ✓ Prioritize writes fairly

**Test Count**: ~30 tests (increased from 25 due to two-level budget tests)

### 4. Channel Tests ([`test/unit/channel.test.js`](../test/unit/channel.test.js))

**⚠️ CONFORMANCE NOTE**: Current implementation uses old API (`readChunk`, `readMessage`). Tests must be updated per 2026-01-02-A.

#### Channel Lifecycle
- ✓ Create channel in closed state
- ✓ Transition to open on accept
- ✓ Transition to closing on close()
- ✓ Transition to closed after flush
- ✓ Handle rejected state
- ✓ Prevent operations on closed channel

#### State Transitions
- ✓ Reader: closed → open → closing → closed
- ✓ Writer: closed → requested → open → closing → closed
- ✓ Writer: closed → requested → rejected
- ✓ localClosing state (remote done, local closing)
- ✓ remoteClosing state (local done, remote closing)

#### Message Type Registration
- ✓ Register numeric message type
- ✓ Register string message type
- ✓ Receive remote message type ID
- ✓ Map local to remote IDs
- ✓ Handle bidirectional registration

#### Write Operations
- ✓ Write single chunk (fits in one chunk)
- ✓ Write with EOM flag
- ✓ Write with custom message type
- ✓ Wait for flow control credits
- ✓ Reject write on closed channel
- **NEW**: ✓ Automatic chunking when data exceeds `remoteMaxChunkSize`
- **NEW**: ✓ Multi-chunk write sets `eom=false` on all but final chunk
- **NEW**: ✓ Multi-chunk write sets `eom=true` only on final chunk
- **NEW**: ✓ Multi-chunk write maintains message type consistency
- **NEW**: ✓ Concurrent writes may interleave at chunk boundaries
- **NEW**: ✓ Each chunk is written atomically (header + payload)

#### Read Operations (Updated API per 2026-01-02-A)
- ✓ `read()` - single chunk
- ✓ `read()` with timeout
- ✓ `read()` with message type filter (`{ only }`)
- ✓ `readSync()` - immediate return
- ✓ `readSync()` returns null when empty
- ✓ `readSync()` with message type filter
- **NEW**: ✓ Concurrent filtered reads don't interfere with each other
- **NEW**: ✓ Multiple readers with different `{ only }` filters work independently
- **NEW**: ✓ Filtered read waiter only satisfied by matching chunk type
- **NEW**: ✓ Out-of-order chunk consumption (type A consumed before type B)
- **REMOVED**: ~~`readMessage()` tests~~ (no longer supported)
- **REMOVED**: ~~`readMessageSync()` tests~~ (no longer supported)
- **REMOVED**: ~~`UnsupportedOperation` for message reads~~ (no longer applicable)

#### Queue Management
- ✓ clear() - clears all chunks
- ✓ clear({ chunk: N }) - specific chunk
- ✓ clear({ only: type }) - by message type
- **REMOVED**: ~~`clear({ direction })` tests~~ (only applies to read channels)

#### Close Operations
- ✓ close() - closes channel
- ✓ close({ discard: true }) - discard queued data
- **REMOVED**: ~~`close({ direction })` tests~~ (channels are unidirectional)
- **REMOVED**: ~~`close({ timeout })` tests~~ (not in current API)

#### Events
- ✓ newChunk event on chunk arrival
- ✓ beforeClosing event on close start
- ✓ closed event on close complete
- ✓ Event order guarantees

**Test Count**: ~40 tests (reduced from 45 due to API simplification, but added new tests for chunking and concurrent reads)

### 5. Transport Base Tests ([`test/unit/transport/base.test.js`](../test/unit/transport/base.test.js))

#### Configuration
- ✓ Accept logger option
- ✓ Fall back to console logger
- ✓ Set channel defaults
- ✓ Validate configuration

#### Event Handling
- ✓ addEventListener() registers handler
- ✓ removeEventListener() unregisters handler
- ✓ Multiple handlers for same event
- ✓ Async handler execution
- ✓ Handler execution order

#### Channel Management
- ✓ requestChannel() sends request
- ✓ requestChannel() resolves on accept
- ✓ requestChannel() rejects on reject
- ✓ requestChannel() times out
- ✓ Accept channel request
- ✓ Reject channel request (default)
- ✓ Multiple simultaneous requests
- ✓ Track local and remote channel IDs

#### Transport Lifecycle
- ✓ start() begins operations
- ✓ close() stops operations
- ✓ close() waits for flush
- ✓ close({ discard: true }) immediate
- ✓ close({ timeout }) timeout handling

#### Events
- ✓ newChannel event on request
- ✓ outofBandData event
- ✓ beforeClosing event
- ✓ closed event
- ✓ protocolViolation event

**Test Count**: ~25 tests

### 6. Virtual Transport Tests ([`test/unit/transport/virtual.test.js`](../test/unit/transport/virtual.test.js))

#### Paired Transports
- ✓ Create paired transports
- ✓ Send message A → B
- ✓ Send message B → A
- ✓ Bidirectional communication

#### Channel Operations
- ✓ Request channel from A
- ✓ Accept channel on B
- ✓ Write data A → B
- ✓ Read data on B
- ✓ Bidirectional channel

#### Flow Control
- ✓ Apply backpressure
- ✓ Release backpressure
- ✓ ACK processing

#### Error Simulation
- ✓ Simulate connection drop
- ✓ Simulate timeout
- ✓ Simulate protocol violation

**Test Count**: ~15 tests

### 7. Pipe Transport Tests ([`test/unit/transport/pipe.test.js`](../test/unit/transport/pipe.test.js))

#### Handshake Protocol
- ✓ Send transport identifier
- ✓ Receive transport identifier
- ✓ Send configuration (JSON)
- ✓ Receive configuration
- ✓ Switch to binary mode
- ✓ Detect handshake failure

#### Configuration Exchange
- ✓ c2cEnabled option
- ✓ c2cMaxBuffer option
- ✓ c2cMaxCount option
- ✓ minChannelId option
- ✓ minMessageTypeId option
- ✓ version option

#### Out-of-Band Data
- ✓ Detect pre-handshake data
- ✓ Trigger outofBandData event
- ✓ Continue after out-of-band data

#### TCC (Transport-Control Channel)
- ✓ Channel 0 always open
- ✓ Transport state-changes (type 0)
- ✓ New-channel requests (type 1)
- ✓ New-channel responses (type 2)

#### C2C (Console-Content Channel)
- ✓ Channel 1 when c2cEnabled
- ✓ Uncaught-exception messages (type 0)
- ✓ Debug messages (type 1)
- ✓ Info/log messages (type 2)
- ✓ Warn messages (type 3)
- ✓ Error messages (type 4)

#### BYOB Reader
- ✓ Detect BYOB support
- ✓ Use BYOB when available
- ✓ Fall back to default reader

**Test Count**: ~25 tests

### 8. Worker Transport Tests ([`test/unit/transport/worker.test.js`](../test/unit/transport/worker.test.js))

#### Message Passing
- ✓ Send message to worker
- ✓ Receive message from worker
- ✓ Bidirectional communication

#### Buffer Transfer
- ✓ Transfer ArrayBuffer to worker
- ✓ Transfer ArrayBuffer from worker
- ✓ Verify buffer ownership transfer
- ✓ Header is structured-cloned JS object (not binary encoded)
- ✓ Main thread performs protocol header encode/decode; worker receives/sends `{ header: object, data: ArrayBuffer }`

#### Buffer Pool Management
- ✓ Worker starts with small pool
- ✓ Request buffers from main thread
- ✓ Return excess buffers to main thread
- ✓ Respect worker buffer limits

#### Worker Lifecycle
- ✓ Create worker transport
- ✓ Terminate worker
- ✓ Handle worker errors

**Test Count**: ~15 tests

### 9. WebSocket Transport Tests ([`test/unit/transport/websocket.test.js`](../test/unit/transport/websocket.test.js))

#### Connection
- ✓ Connect to WebSocket server
- ✓ Accept WebSocket connection
- ✓ Handle connection errors
- ✓ Handle connection timeout

#### Binary Messaging
- ✓ Send binary message
- ✓ Receive binary message
- ✓ Frame messages correctly

#### Keepalive
- ✓ Send ping
- ✓ Receive pong
- ✓ Detect connection loss

#### Reconnection
- ✓ Automatic reconnection (optional)
- ✓ Exponential backoff
- ✓ Max reconnection attempts

**Test Count**: ~15 tests

### 10. HTTP Transport Tests ([`test/unit/transport/http.test.js`](../test/unit/transport/http.test.js))

#### Request/Response
- ✓ Send HTTP request
- ✓ Receive HTTP response
- ✓ Single channel per request
- ✓ Auto-close on completion

#### Streaming
- ✓ Stream response chunks
- ✓ Chunked transfer encoding
- ✓ Handle backpressure

#### SSE Support
- ✓ Server-Sent Events format
- ✓ Event stream parsing
- ✓ Reconnection on disconnect

**Test Count**: ~10 tests

### 11. Nested Transport Tests ([`test/unit/transport/nested.test.js`](../test/unit/transport/nested.test.js))

#### PTOC Attachment
- ✓ Attach to bidirectional channel
- ✓ Reject attachment to unidirectional channel
- ✓ Assign unique message type

#### Message Wrapping
- ✓ Wrap outbound messages
- ✓ Unwrap inbound messages
- ✓ Preserve message boundaries

#### Flow Control
- ✓ Independent flow control per layer
- ✓ Propagate backpressure
- ✓ Multi-hop routing

#### Event Propagation
- ✓ Propagate beforeClosing
- ✓ Propagate closed
- ✓ Handle host channel closure

**Test Count**: ~12 tests

## Integration Tests

### 1. JSMAWS Scenarios ([`test/integration/jsmaws-scenarios.test.js`](../test/integration/jsmaws-scenarios.test.js))

#### Operator ↔ Router
- ✓ Establish pipe transport
- ✓ Request routing channel
- ✓ Send request
- ✓ Receive response

#### Router ↔ Responder
- ✓ Establish pipe transport
- ✓ Request req/res channel
- ✓ Forward request
- ✓ Forward response

#### Responder ↔ Applet
- ✓ Establish worker transport
- ✓ Request primary channel
- ✓ Request bootstrap channel
- ✓ Request console channel
- ✓ Send bootstrap parameters
- ✓ Forward request
- ✓ Receive response

#### Client ↔ Applet (WebSocket)
- ✓ HTTP request
- ✓ Upgrade to WebSocket
- ✓ Create PTOC (operator side)
- ✓ Create PTOC (applet side)
- ✓ Relay through operator
- ✓ Relay through responder
- ✓ Bidirectional communication

#### Console Logging Pipeline
- ✓ Applet console.log
- ✓ Forward to responder C2C
- ✓ Forward to operator C2C
- ✓ Log to console/syslog

**Test Count**: ~25 tests

### 2. Multi-Channel Tests ([`test/integration/multi-channel.test.js`](../test/integration/multi-channel.test.js))

- ✓ Multiple simultaneous channels
- ✓ Independent flow control per channel
- ✓ Channel isolation
- ✓ Fair resource allocation
- ✓ Channel priority (if implemented)

**Test Count**: ~8 tests

### 3. Flow Control Stress Tests ([`test/integration/flow-control-stress.test.js`](../test/integration/flow-control-stress.test.js))

- ✓ Sustained high throughput
- ✓ Rapid start/stop
- ✓ Many small messages
- ✓ Few large messages
- ✓ Mixed message sizes
- ✓ Slow reader scenario
- ✓ Fast reader scenario

**Test Count**: ~10 tests

### 4. Error Recovery Tests ([`test/integration/error-recovery.test.js`](../test/integration/error-recovery.test.js))

- ✓ Recover from connection drop
- ✓ Recover from timeout
- ✓ Handle partial message
- ✓ Handle corrupted header
- ✓ Handle protocol violation
- ✓ Graceful degradation

**Test Count**: ~8 tests

### 5. NEW: Automatic Chunking Tests ([`test/integration/auto-chunking.test.js`](../test/integration/auto-chunking.test.js))

**Purpose**: Verify automatic chunking behavior per 2026-01-02-A requirement.

- ✓ Write data exceeding `remoteMaxChunkSize` is automatically chunked
- ✓ All chunks except final have `eom=false`
- ✓ Final chunk has `eom=true` (when included in `write` call)
- ✓ Message type is consistent across all chunks
- ✓ Flow control credits are consumed for each chunk
- ✓ Receiver can reassemble message from chunks
- ✓ Very large writes (multiple chunks) work correctly
- ✓ Edge case: data exactly equals `remoteMaxChunkSize`
- ✓ Edge case: data is 1 byte over `remoteMaxChunkSize`

**Test Count**: ~10 tests

### 6. NEW: Concurrent Filtered Reads Tests ([`test/integration/concurrent-filtered-reads.test.js`](../test/integration/concurrent-filtered-reads.test.js))

**Purpose**: Verify filtered reads don't interfere with each other per 2026-01-02-A requirement.

- ✓ Two readers with different `{ only }` filters work independently
- ✓ Reader A waiting for type A is not satisfied by type B chunk
- ✓ Reader B waiting for type B is not satisfied by type A chunk
- ✓ Both readers eventually receive their respective chunks
- ✓ Three or more concurrent filtered readers
- ✓ Filtered reader + unfiltered reader (no `{ only }`)
  - Actually, this is non-deterministic and unsupported! (Must be all filtered, or single unfiltered)
- ✓ Timeout on filtered read doesn't affect other filtered reads
- ✓ Out-of-order chunk arrival with filtered reads

**Test Count**: ~10 tests

### 7. NEW: Write Interleaving Tests ([`test/integration/write-interleaving.test.js`](../test/integration/write-interleaving.test.js))

**Purpose**: Verify chunk atomicity and write interleaving per 2026-01-02-A requirement.

- ✓ Two concurrent writes may interleave at chunk boundaries
- ✓ Each chunk is atomic (header + payload together)
- ✓ Chunk sequence numbers are correct despite interleaving
- ✓ Receivers can correctly filter and reassemble messages
- ✓ Flow control works correctly with interleaved writes
- ✓ ACKs are generated correctly for interleaved chunks
- ✓ Large write A + large write B interleave as expected

**Test Count**: ~8 tests

### 8. NEW: Two-Level Budget Tests ([`test/integration/two-level-budget.test.js`](../test/integration/two-level-budget.test.js))

**Purpose**: Verify transport and channel budget enforcement per 2026-01-02-A requirement.

- ✓ Transport-level budget limits all channels
- ✓ Channel-level budget limits individual channel
- ✓ Write blocked when transport budget exhausted
- ✓ Write blocked when channel budget exhausted
- ✓ Write succeeds when both budgets available
- ✓ Channel creation rejected if limits exceed transport limits
- ✓ Multiple channels share transport budget fairly
- ✓ ACKs restore both transport and channel budgets

**Test Count**: ~10 tests

## Performance Tests

### 1. Throughput Tests ([`test/performance/throughput.test.js`](../test/performance/throughput.test.js))

#### Baseline Measurements
- ✓ Measure native pipe throughput
- ✓ Measure native WebSocket throughput
- ✓ Measure native Worker throughput

#### PolyTransport Measurements
- ✓ Measure pipe transport throughput
- ✓ Measure WebSocket transport throughput
- ✓ Measure Worker transport throughput
- ✓ Compare with/without flow control
- ✓ Identify bottlenecks

#### Target: < 10% overhead vs native

**Test Count**: ~10 tests

### 2. Latency Tests ([`test/performance/latency.test.js`](../test/performance/latency.test.js))

- ✓ Measure round-trip latency (ping-pong)
- ✓ Measure under light load
- ✓ Measure under heavy load
- ✓ Measure with multiple channels
- ✓ Measure nested transport overhead

#### Target: < 10% overhead vs native

**Test Count**: ~8 tests

### 3. Memory Tests ([`test/performance/memory.test.js`](../test/performance/memory.test.js))

- ✓ Measure baseline memory usage
- ✓ Measure memory per channel
- ✓ Measure memory per message
- ✓ Verify buffer pool limits
- ✓ Detect memory leaks
- ✓ Long-running connection stability

**Test Count**: ~8 tests

## Security Tests

### 1. DoS Prevention Tests ([`test/security/dos-prevention.test.js`](../test/security/dos-prevention.test.js))

#### Duplicate ACK
- ✓ Detect duplicate ACK
- ✓ Trigger protocolViolation event
- ✓ Close transport by default
- ✓ Allow preventDefault()

#### Buffer Overflow
- ✓ Enforce maxBufferSize
- ✓ Reject oversized chunks
- ✓ Reject oversized messages
- ✓ Prevent credit overflow

#### Resource Exhaustion
- ✓ Limit channel count
- ✓ Limit message type count
- ✓ Limit pending requests
- ✓ Enforce timeouts

#### Malformed Messages
- ✓ Reject invalid headers
- ✓ Reject invalid channel IDs
- ✓ Reject invalid message types
- ✓ Reject invalid flags

**Test Count**: ~15 tests

### 2. Resource Limits Tests ([`test/security/resource-limits.test.js`](../test/security/resource-limits.test.js))

- ✓ Enforce maxChunkSize
- ✓ Enforce maxMessageSize
- ✓ Enforce maxBufferSize
- ✓ Enforce channel limits
- ✓ Enforce timeout limits

**Test Count**: ~8 tests

### 3. Untrusted Code Tests ([`test/security/untrusted-code.test.js`](../test/security/untrusted-code.test.js))

#### Applet Isolation
- ✓ Applet cannot access other channels
- ✓ Applet cannot access transport directly
- ✓ Applet cannot access buffers directly
- ✓ Bootstrap secures environment

#### PTOC Security
- ✓ PTOC respects host channel limits
- ✓ PTOC cannot escape host channel
- ✓ PTOC flow control enforced

**Test Count**: ~8 tests

## Test Helpers

### Test Utilities ([`test/helpers/test-utils.esm.js`](../test/helpers/test-utils.esm.js))

- `createPairedTransports()` - Create virtual transport pair
- `createTestChannel()` - Create test channel with defaults
- `waitForEvent(target, eventName, timeout)` - Wait for event
- `assertEventOrder(events, expected)` - Verify event order
- `generateTestData(size)` - Generate test data
- `measureThroughput(fn, duration)` - Measure throughput
- `measureLatency(fn, iterations)` - Measure latency

### Mock Transport ([`test/helpers/mock-transport.esm.js`](../test/helpers/mock-transport.esm.js))

- Configurable delays
- Configurable errors
- Message inspection
- Event recording

### Custom Assertions ([`test/helpers/assertions.esm.js`](../test/helpers/assertions.esm.js))

- `assertChannelState(channel, expectedState)`
- `assertFlowControlCredits(controller, expected)`
- `assertBufferPoolSize(pool, expected)`
- `assertEventFired(target, eventName)`

## Test Execution

### Run All Tests
```bash
deno test
```

### Run Specific Test Suite
```bash
deno test test/unit/protocol.test.js
deno test test/integration/
deno test test/performance/
deno test test/security/
```

### Run with Coverage
```bash
deno test --coverage=coverage/
deno coverage coverage/
```

### Run with Permissions
```bash
deno test --allow-net --allow-read --allow-write --allow-run
```

## Coverage Goals

- **Overall**: > 90% line coverage
- **Core Components**: > 95% line coverage
  - Protocol layer
  - Buffer management
  - Flow control
  - Channel implementation
- **Transport Implementations**: > 85% line coverage
- **Integration Tests**: Cover all JSMAWS scenarios

## Continuous Integration

### Pre-Commit Checks
- Run unit tests
- Check code style
- Verify no console.log statements

### Pull Request Checks
- Run all tests
- Verify coverage > 90%
- Run security tests
- Check for memory leaks

### Nightly Builds
- Run performance tests
- Run long-running stability tests
- Generate coverage reports
- Update documentation

## Test Maintenance

### Adding New Tests
1. Follow naming conventions
2. Use descriptive test names
3. Include comments for complex scenarios
4. Update this test plan

### Updating Tests
1. Keep tests in sync with implementation
2. Update expected values when behavior changes
3. Document breaking changes

### Removing Tests
1. Document reason for removal
2. Ensure coverage maintained
3. Update this test plan

## Success Criteria

- ✓ All tests pass
- ✓ Coverage > 90%
- ✓ No memory leaks detected
- ✓ Performance targets met
- ✓ Security tests pass
- ✓ Integration tests cover all JSMAWS scenarios

## Next Steps

1. Implement test helpers first
2. Write tests alongside implementation (TDD)
3. Run tests frequently during development
4. Address failures immediately
5. Monitor coverage continuously
