# PolyTransport Test Plan

Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung

## Overview

This document defines the comprehensive testing strategy for the PolyTransport library. Tests are organized by component, with clear success criteria and coverage goals.

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

#### Header Encoding/Decoding
- ✓ Encode ACK message header
- ✓ Encode channel-control message header
- ✓ Encode channel-data message header
- ✓ Decode valid headers
- ✓ Reject malformed headers
- ✓ Handle edge cases (max values, zero values)

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

### 2. Buffer Management Tests ([`test/unit/buffer-manager.test.js`](../test/unit/buffer-manager.test.js))

#### VirtualBuffer Class
- ✓ Create single-range view
- ✓ Create multi-range view
- ✓ Create cross-buffer view
- ✓ Read bytes from virtual buffer
- ✓ Write bytes to virtual buffer
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

**Test Count**: ~30 tests

### 3. Flow Control Tests ([`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js))

#### Credit Management
- ✓ Initialize credits from remote buffer size
- ✓ Consume credits on send
- ✓ Restore credits on ACK
- ✓ Block when credits exhausted
- ✓ Unblock when credits available
- ✓ Calculate local budget correctly

#### Chunk Tracking
- ✓ Assign sequence numbers (starting at 1)
- ✓ Track in-flight chunks
- ✓ Remove acknowledged chunks
- ✓ Handle out-of-order ACKs
- ✓ Handle range-based ACKs

#### ACK Generation
- ✓ Generate ACK for single chunk
- ✓ Generate ACK for range of chunks
- ✓ Generate ACK with skip ranges
- ✓ Batch ACKs when possible
- ✓ Send ACK at low-water mark

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

**Test Count**: ~25 tests

### 4. Channel Tests ([`test/unit/channel.test.js`](../test/unit/channel.test.js))

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
- ✓ Write single chunk
- ✓ Write multi-chunk message
- ✓ Write with EOM flag
- ✓ Write with custom message type
- ✓ Wait for flow control credits
- ✓ Reject write on closed channel

#### Read Operations
- ✓ readChunk() - single chunk
- ✓ readChunk() with timeout
- ✓ readChunk() with message type filter
- ✓ readChunkSync() - immediate return
- ✓ readChunkSync() returns null when empty
- ✓ readMessage() - complete message
- ✓ readMessage() - multi-chunk message
- ✓ readMessage() with timeout
- ✓ readMessage() with message type filter
- ✓ readMessageSync() - immediate return
- ✓ readMessageSync() returns null when empty
- ✓ Throw UnsupportedOperation when appropriate

#### Queue Management
- ✓ clear() - both directions
- ✓ clear({ direction: 'read' })
- ✓ clear({ direction: 'write' })
- ✓ clear({ chunk: N }) - specific chunk
- ✓ clear({ only: type }) - by message type

#### Close Operations
- ✓ close() - both directions
- ✓ close({ direction: 'read' })
- ✓ close({ direction: 'write' })
- ✓ close({ discard: true }) - discard queued data
- ✓ close({ timeout }) - timeout handling

#### Events
- ✓ newChunk event on chunk arrival
- ✓ beforeClosing event on close start
- ✓ closed event on close complete
- ✓ Event order guarantees

**Test Count**: ~45 tests

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
- ✓ Clone header object

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
