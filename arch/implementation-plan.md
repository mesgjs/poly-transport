# PolyTransport Implementation Plan

Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung

## Overview

This document outlines the phased implementation approach for the PolyTransport library based on [`requirements.md`](requirements.md). The plan prioritizes core functionality first, then adds transport types and advanced features incrementally.

## Implementation Phases

### Phase 1: Core Infrastructure (Foundation)

**Goal**: Establish the foundational classes and protocols without transport-specific implementations.

#### 1.1 Protocol Layer
- **File**: [`src/protocol.esm.js`](../src/protocol.esm.js)
- **Components**:
  - Message header encoding/decoding (`\x01{...}\n` format)
  - Message type constants (ACK, channel-control, channel-data)
  - Header field validation
  - Protocol version handling
- **Key Functions**:
  - `encodeHeader (type, fields)` → Uint8Array
  - `decodeHeader (buffer)` → { type, fields, headerLength }
  - `validateHeader (header)` → boolean
- **Tests**: Header encoding/decoding, validation, edge cases

#### 1.2 Buffer Management
- **File**: [`src/buffer-manager.esm.js`](../src/buffer-manager.esm.js)
- **Components**:
  - `VirtualBuffer` class - Multi-range buffer views
  - `BufferPool` class - Pooled ArrayBuffer management (1K, 4K, 16K, 64K)
  - `BufferManager` class - Reference tracking and lifecycle
- **Key Features**:
  - Ring buffer support for BYOB readers
  - Automatic buffer size selection
  - Transfer between contexts (postMessage)
  - Low/high water mark management
- **Tests**: Buffer allocation, pooling, virtual views, cross-buffer ranges

#### 1.3 Flow Control
- **File**: [`src/flow-control.esm.js`](../src/flow-control.esm.js)
- **Components**:
  - `FlowController` class - Credit-based flow control
  - Chunk sequence tracking
  - ACK generation and processing
  - Budget calculation (remote budget - in-flight data)
- **Key Features**:
  - Per-channel credit management
  - Chunk acknowledgment tracking
  - Backpressure signaling
  - Protocol violation detection (duplicate ACKs)
- **Tests**: Credit allocation, consumption, restoration, backpressure

#### 1.4 Channel Implementation
- **File**: [`src/channel.esm.js`](../src/channel.esm.js)
- **Components**:
  - `Channel` class - Logical communication stream
  - State machine (closed → open → closing → closed)
  - Message type registration
  - Read/write queues
- **Key Features**:
  - Bidirectional and unidirectional support
  - Message type filtering
  - Event dispatching (newChunk, beforeClosing, closed)
  - Read methods: `readChunk()`, `readChunkSync()`, `readMessage()`, `readMessageSync()`
  - Write method: `write(type, data, { eom })`
  - `clear()` method for queue management
  - `close()` method with direction support
- **Tests**: Channel lifecycle, read/write operations, filtering, state transitions

### Phase 2: Transport Base & Virtual Transport

**Goal**: Create the abstract transport interface and a testable virtual transport.

#### 2.1 Transport Base Class
- **File**: [`src/transport/base.esm.js`](../src/transport/base.esm.js)
- **Components**:
  - Abstract `Transport` class
  - Event handling (addEventListener/removeEventListener)
  - Channel management (request/accept)
  - Configuration handling
- **Key Methods**:
  - `async start ()` - Begin transport operations
  - `async requestChannel (idOrName, { timeout })` - Request new channel
  - `setChannelDefaults (options)` - Set default channel options
  - `async close ({ discard, timeout })` - Close transport
  - Abstract methods for subclasses to implement
- **Events**:
  - `newChannel` - Incoming channel request
  - `outofBandData` - Non-PolyTransport data detected
  - `beforeClosing` - Pre-closure notification
  - `closed` - Post-closure notification
  - `protocolViolation` - Protocol error detected
- **Tests**: Event handling, channel lifecycle, configuration

#### 2.2 Virtual Transport (for testing)
- **File**: [`src/transport/virtual.esm.js`](../src/transport/virtual.esm.js)
- **Purpose**: In-memory transport for testing without I/O
- **Components**:
  - Paired virtual transports (A ↔ B)
  - Synchronous message passing
  - Configurable delays and errors
- **Tests**: End-to-end channel operations, flow control, error scenarios

### Phase 3: IPC Pipe Transport

**Goal**: Implement the first real transport for process communication.

#### 3.1 Pipe Transport
- **File**: [`src/transport/pipe.esm.js`](../src/transport/pipe.esm.js)
- **Components**:
  - IPC pipe transport (stdin/stdout/stderr)
  - Handshake protocol implementation
  - BYOB reader support with fallback
  - Out-of-band data detection
- **Key Features**:
  - Transport identifier exchange (`\x02PolyTransport\x03`)
  - Configuration exchange (JSON with STX/ETX)
  - Binary stream mode (`\x01`)
  - Console-content channel (C2C) support
  - Transport-control channel (TCC) support
- **Tests**: Handshake, channel operations, C2C, error handling

### Phase 4: Web Worker Transport

**Goal**: Enable communication with Web Workers.

#### 4.1 Worker Transport
- **File**: [`src/transport/worker.esm.js`](../src/transport/worker.esm.js)
- **Components**:
  - Web Worker message passing
  - Buffer transfer optimization
  - Bidirectional communication
- **Key Features**:
  - postMessage with transferable ArrayBuffers
  - Header as cloned object, data as transferred buffer
  - Worker-side buffer pool management
- **Tests**: Message passing, buffer transfer, worker lifecycle

### Phase 5: WebSocket Transport

**Goal**: Enable bidirectional web communication.

#### 5.1 WebSocket Transport
- **File**: [`src/transport/websocket.esm.js`](../src/transport/websocket.esm.js)
- **Components**:
  - WebSocket-based transport
  - Binary message framing
  - Connection lifecycle management
- **Key Features**:
  - Automatic reconnection (optional)
  - Ping/pong for keepalive
  - Graceful degradation
- **Tests**: Connection, messaging, reconnection, errors

### Phase 6: HTTP Transport

**Goal**: Support simple request/response patterns.

#### 6.1 HTTP Transport
- **File**: [`src/transport/http.esm.js`](../src/transport/http.esm.js)
- **Components**:
  - HTTP/HTTPS request/response
  - Streaming response support
  - SSE (Server-Sent Events) support
- **Key Features**:
  - Single-channel per request
  - Automatic channel closure on response completion
  - Chunked transfer encoding
- **Tests**: Request/response, streaming, errors

Notes:

- Client-side PolyTransport will typically only be used for bidirectional connections (for flow-control reasons).
- PolyTransport awareness should not be a *client* requirement for standard and streaming responses (only for server-side components).

### Phase 7: Nested Transport (PTOC)

**Goal**: Enable PolyTransport-over-channel for complex routing.

#### 7.1 Nested Transport
- **File**: [`src/transport/nested.esm.js`](../src/transport/nested.esm.js)
- **Components**:
  - PTOC (PolyTransport-over-channel)
  - Message type wrapping/unwrapping
  - Flow control propagation
- **Key Features**:
  - Attach to existing bidirectional channel
  - Transparent chunk relaying
  - Independent flow control at each layer
  - Critical for JSMAWS routing architecture
- **Tests**: Nested channels, flow control, multi-hop routing

### Phase 8: Main Export & Integration

**Goal**: Provide unified API and integration utilities.

#### 8.1 Main Export
- **File**: [`src/poly-transport.esm.js`](../src/poly-transport.esm.js)
- **Components**:
  - Export all transport types
  - Export utility classes
  - Version information
- **Example Usage**:
```javascript
import { PipeTransport, Channel } from './poly-transport.esm.js';

const transport = new PipeTransport({ logger: console });
transport.addEventListener('newChannel', (event) => {
  const channel = event.accept({ maxBufferSize: 65536 });
  // ... handle channel
});
await transport.start();
```

## Testing Strategy

### Unit Tests

Each component has dedicated test files:
- [`test/protocol.test.js`](../test/protocol.test.js) - Protocol encoding/decoding
- [`test/buffer-manager.test.js`](../test/buffer-manager.test.js) - Buffer management
- [`test/flow-control.test.js`](../test/flow-control.test.js) - Flow control logic
- [`test/channel.test.js`](../test/channel.test.js) - Channel operations
- [`test/transport/base.test.js`](../test/transport/base.test.js) - Transport base
- [`test/transport/virtual.test.js`](../test/transport/virtual.test.js) - Virtual transport
- [`test/transport/pipe.test.js`](../test/transport/pipe.test.js) - Pipe transport
- [`test/transport/worker.test.js`](../test/transport/worker.test.js) - Worker transport
- [`test/transport/websocket.test.js`](../test/transport/websocket.test.js) - WebSocket transport
- [`test/transport/http.test.js`](../test/transport/http.test.js) - HTTP transport
- [`test/transport/nested.test.js`](../test/transport/nested.test.js) - Nested transport

### Integration Tests

- [`test/integration/jsmaws-scenarios.test.js`](../test/integration/jsmaws-scenarios.test.js)
  - Operator ↔ Router communication
  - Router ↔ Responder communication
  - Responder ↔ Applet communication
  - Client ↔ Applet WebSocket upgrade
  - Console logging pipeline

### Performance Tests

- [`test/performance/throughput.test.js`](../test/performance/throughput.test.js)
  - Measure throughput for each transport type
  - Compare with/without flow control
  - Identify bottlenecks

- [`test/performance/latency.test.js`](../test/performance/latency.test.js)
  - Measure round-trip latency
  - Test under various load conditions

### Security Tests

- [`test/security/dos-prevention.test.js`](../test/security/dos-prevention.test.js)
  - Duplicate ACK detection
  - Buffer overflow prevention
  - Resource exhaustion protection
  - Malformed message handling

## Implementation Order

### Week 1-2: Core Infrastructure
1. Protocol layer (1.1)
2. Buffer management (1.2)
3. Flow control (1.3)
4. Channel implementation (1.4)

### Week 3: Transport Foundation
5. Transport base class (2.1)
6. Virtual transport (2.2)
7. Integration tests with virtual transport

### Week 4: First Real Transport
8. Pipe transport (3.1)
9. Handshake protocol
10. C2C and TCC channels

### Week 5: Worker Support
11. Worker transport (4.1)
12. Buffer transfer optimization
13. Worker-side buffer management

### Week 6: Web Communication
14. WebSocket transport (5.1)
15. HTTP transport (6.1)
16. Browser compatibility testing

### Week 7: Advanced Features
17. Nested transport (7.1)
18. PTOC implementation
19. Multi-hop routing tests

### Week 8: Polish & Documentation
20. Main export (8.1)
21. Performance optimization
22. Documentation and examples
23. Security audit

## Key Design Considerations

### 1. Event Handling
- All event handlers are async and awaited
- `preventDefault()` support where applicable
- Event order guarantees (e.g., beforeClosing → closed)

### 2. Error Handling
- Clear error types (TimeoutError, ProtocolViolation, etc.)
- Graceful degradation where possible
- Detailed error messages for debugging

### 3. Flow Control
- Credit-based system prevents buffer overflow
- Per-channel and per-transport limits
- Automatic backpressure handling

### 4. Security
- Input validation on all messages
- Resource limits enforced
- DoS prevention (duplicate ACK detection)
- Untrusted code isolation (applets)

### 5. Performance
- Minimize system calls (buffer pooling)
- Minimize copying (VirtualBuffer)
- BYOB reader support where available
- Efficient chunk relaying for PTOC

### 6. Testability
- Virtual transport for unit testing
- Configurable delays and errors
- Comprehensive test coverage
- Integration tests for real-world scenarios

## Success Criteria

### Functional Requirements
- ✓ All transport types implemented and tested
- ✓ Flow control prevents buffer overflow
- ✓ Channels support bidirectional and unidirectional modes
- ✓ Message types work with filtering
- ✓ PTOC enables multi-hop routing
- ✓ C2C channel handles console redirection

### Performance Requirements
- ✓ Throughput comparable to native transports
- ✓ Latency overhead < 10% vs native
- ✓ Memory usage bounded by configured limits
- ✓ No memory leaks in long-running connections

### Security Requirements
- ✓ DoS attacks prevented (duplicate ACKs, buffer overflow)
- ✓ Untrusted code cannot access other channels
- ✓ Resource limits enforced
- ✓ Protocol violations detected and handled

### Code Quality Requirements
- ✓ Test coverage > 90%
- ✓ All tests pass in Deno
- ✓ Code follows project standards
- ✓ Documentation complete and accurate

## Next Steps

1. Review and approve this implementation plan
2. Begin Phase 1 implementation (protocol layer)
3. Set up continuous testing infrastructure
4. Create example applications for each transport type
5. Document API as components are completed
