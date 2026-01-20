# PolyTransport Scenarios

This directory contains detailed scenario documentation describing how PolyTransport operates internally. Each scenario documents the step-by-step sequence of operations, module responsibilities, and component interactions.

## Purpose

These scenarios serve as:
- **Implementation guides** for developers building PolyTransport components
- **Design validation** to ensure the architecture supports required use cases
- **Reference documentation** for understanding system behavior
- **Test planning** foundation for integration and end-to-end tests

## Important Architectural Note

**As of 2026-01-12**: The channel model has undergone a fundamental redesign (see [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)):
- **All channels are now bidirectional** (unidirectional channel concept removed)
- **Even/odd role-based ID assignment** using transport UUIDs
- **TCC message types updated** for channel setup/teardown and message-type registration
- **Control messages use TCC message-type mappings** across all channels

This impacts channel lifecycle scenarios significantly. Scenarios written before this update may contain outdated unidirectional channel concepts.

## Organization

Scenarios are organized by functional area and complexity. The order below represents the recommended reading sequence, but scenarios can be read independently as needed.

### 1. Transport Lifecycle

**[`transport-initialization.md`](transport-initialization.md)** ✅ Complete
- Creating a transport instance
- Configuring channel defaults
- Starting the transport
- Initial handshake with transport ID exchange
- Role determination (EVEN_ROLE vs ODD_ROLE)
- TCC and C2C channel initialization (both bidirectional)
- Module responsibilities: Transport base, specific transport implementations


**[`transport-shutdown.md`](transport-shutdown.md)** ✅ Complete
- Graceful transport closure
- Channel cleanup sequence
- `beforeStopping` and `stopped` event dispatch
- Timeout handling
- Discard vs graceful shutdown
- Transport shutdown messages on TCC (`tranStop`)
- Module responsibilities: Transport base, Channel, ChannelFlowControl

### 2. Channel Lifecycle

**[`channel-request.md`](channel-request.md)** ✅ Complete
- Requesting a new bidirectional channel
- Channel request as TCC data message (`chanReq`)
- `newChannelRequest` event handling
- Accept/reject decision flow
- Even/odd channel ID assignment by acceptor
- Simultaneous bidirectional requests (ID jitter)
- Timeout scenarios
- Module responsibilities: Transport, Channel, Protocol

**[`channel-acceptance.md`](channel-acceptance.md)** ✅ Complete
- Receiving channel request
- Event handler invocation
- Accept response with configuration (TCC data message `chanResp`)
- Reject response with reason
- Role-based ID assignment (even or odd)
- Reusing existing IDs for named channels
- Channel registration (bidirectional)
- Module responsibilities: Transport, Channel, Protocol

**[`id-jitter-settlement.md`](id-jitter-settlement.md)** ✅ Complete
- Simultaneous channel requests from both sides
- Temporary use of higher ID during overlap
- Automatic settlement to lower ID
- ID storage in two-element array (ascending order)
- First (lowest) ID used for sending
- Module responsibilities: Transport, Channel

**[`channel-closure.md`](channel-closure.md)** ✅ Complete
- Initiating channel close (entire channel, not directional)
- Flushing pending data in both directions
- Close message on TCC (`chanClose`)
- Single `beforeClosing` and `closed` events
- Cleanup and resource release
- Module responsibilities: Channel, Transport, ChannelFlowControl

### 3. Message-Type Registration

**[`message-type-registration.md`](message-type-registration.md)** ✅
- Registering named message types on a channel
- Batch registration protocol
- Channel control messages (`mesgTypeReq`, `mesgTypeResp`)
- Even/odd message-type ID assignment by acceptor
- TCC message-type mappings used for all control messages
- Simultaneous registration from both sides
- ID jitter and settlement for message types
- Module responsibilities: Channel, Protocol

### 4. Data Transfer

**[`simple-write.md`](simple-write.md)** ✅
- Writing single-chunk data to a channel
- User calls [`channel.write()`](../../src/channel.esm.js) with data and options
- Channel handles ALL complexity: budget waiting, encoding, queueing
- Data type handling (string with UTF-8 encoding, binary Uint8Array)
- Zero-copy encoding directly into output ring buffer
- Write promise resolves after data encoded/queued (not after sent)
- Background transport operations (send, consume, zero-after-write)
- Module responsibilities: Channel, ChannelFlowControl, OutputRingBuffer, VirtualRWBuffer, Protocol, Transport

**[`multi-chunk-write.md`](multi-chunk-write.md)** ✅
- Writing large data that exceeds maxChunkBytes (automatic)
- User calls [`channel.write()`](../../src/channel.esm.js) with large data
- Channel handles ALL complexity: automatic chunking, budget waiting per chunk, encoding
- Chunk splitting logic (binary vs string data)
- Sequence number assignment (one per chunk)
- EOM flag only on final chunk (intermediate chunks have no EOM)
- String encoding across chunks (variable-length UTF-8 handling)
- Zero-copy encoding directly into output ring buffer (per chunk)
- Write promise resolves after ALL chunks encoded/queued (not after sent)
- Background transport operations (send chunks, consume, zero-after-write)
- Module responsibilities: Channel, ChannelFlowControl, OutputRingBuffer, VirtualRWBuffer, Protocol, Transport

**[`simple-read.md`](simple-read.md)** ✅
- Reading single-chunk data from a channel
- User calls [`channel.read()`](../../src/channel.esm.js) or [`channel.readSync()`](../../src/channel.esm.js)
- Channel handles ALL complexity: buffer management, sequence validation, ACK generation
- Synchronous vs asynchronous read (blocking vs non-blocking)
- Message type filtering (`only` parameter) for multiplexing
- Timeout handling (async only)
- Chunk object with `process()` and `done()` methods for consumption tracking
- Duplicate reader prevention (unfiltered and filtered)
- Protocol violation detection (out-of-order, over-budget)
- ACK generation when buffer usage drops below low-water mark
- Zero-copy data access via VirtualBuffer
- Module responsibilities: Channel, ChannelFlowControl, VirtualBuffer, Protocol, Transport

**[`streaming-read.md`](streaming-read.md)** ✅
- Reading multi-chunk messages from a channel
- User calls [`channel.read()`](../../src/channel.esm.js) repeatedly until EOM
- Channel handles ALL complexity: buffer management, sequence validation, ACK generation
- EOM flag detection (detect end-of-message)
- Streaming vs buffering strategies (process immediately vs assemble complete message)
- Chunk assembly for complete messages (concatenate or VirtualBuffer spanning)
- Message type filtering (same type for all chunks)
- Timeout handling for each chunk
- Incomplete message handling (connection lost before EOM)
- Periodic ACK generation (not for every chunk)
- Zero-copy reading (streaming) or one copy (buffering)
- Module responsibilities: Channel, ChannelFlowControl, VirtualBuffer, Protocol, Transport

### 5. Flow Control and Budgets

**Note**: ChannelFlowControl class manages both send and receive flow control for bidirectional channels. Each bidirectional channel uses one instance of ChannelFlowControl.

**Budget Consolidation Decision (2026-01-15)**: Transport budget and channel budget are documented together in [`send-flow-control.md`](send-flow-control.md) rather than as separate scenarios. Both budgets are always used together in practice (both must be available before a chunk can be sent), so consolidating them provides a complete picture without duplication. See [`send-flow-control.md`](send-flow-control.md) "Three-Resource Coordination System" section for detailed explanations of channel budget, transport budget, and ring buffer space management.

**[`send-flow-control.md`](send-flow-control.md)** ✅
- Three-resource coordination (channel budget, transport budget, ring buffer space)
- Atomic budget reservation (prevents budget theft)
- Provisional reservations with shrinking (string encoding)
- Sequence number assignment and in-flight tracking
- ACK processing and budget restoration (channel and transport levels)
- FIFO ordering at all levels (fairness)
- Protocol violation detection (duplicate ACK, premature ACK, unknown channel)
- Module responsibilities: ChannelFlowControl, Transport, OutputRingBuffer, Protocol

**[`receive-flow-control.md`](receive-flow-control.md)** ✅
- Recording received chunks with sequence and budget validation
- Chunk storage in read buffer (zero-copy VirtualBuffer)
- User consumption tracking with idempotent `done()` method
- Low-water mark trigger for ACK generation
- Protocol violation handling (out-of-order, over-budget, unknown channel)
- Chunk object API with bound functions/closures (scoped consumption state)
- Module responsibilities: ChannelFlowControl, Channel, Transport, Protocol, VirtualBuffer

**[`ack-generation-processing.md`](ack-generation-processing.md)** ✅
- Generating ACK information (channel low-water mark trigger)
- Range-based acknowledgments (base sequence + include/skip ranges)
- ACK message format (transport-level, type 0 headers)
- Processing received ACKs (channel and transport budget restoration)
- **Critical**: ACKs use ring buffer space only (fire-and-forget, no ACK-on-ACK)
- Ring buffer reservation with `exact: true` parameter
- Protocol violation handling (unknown channel, duplicate ACK, premature ACK)
- Unblocking waiting writes (FIFO order)
- Module responsibilities: ChannelFlowControl, Protocol, Transport, OutputRingBuffer

**[`protocol-violation.md`](protocol-violation.md)** ✅
- Protocol violation detection and handling (events, not exceptions)
- Five violation types: out-of-order sequence, over-budget chunk, duplicate ACK, premature ACK, unknown channel
- ProtocolViolationError structure with reason and details
- Transport `protocolViolation` event emission
- Application-defined handling policies (close transport, close channel, log and ignore)
- Channel state unchanged after violation (no side effects)
- Closed channel tracking (prevents false "unknown channel" violations)
- Module responsibilities: ChannelFlowControl, Transport, Channel

### 6. Message Protocol

**[`message-encoding.md`](message-encoding.md)** ✅
- ACK message encoding (header type 0, transport-level)
- Channel control message encoding (header type 1, on-channel)
- Channel data message encoding (header type 2, on-channel)
- Zero-copy encoding into ring buffer via VirtualRWBuffer
- Remaining size encoding (16-bit word counting)
- ACK base independence and range encoding
- String encoding with over-allocation and shrinking
- Multi-chunk message encoding with EOM flag handling
- Module responsibilities: Protocol, OutputRingBuffer, VirtualRWBuffer, ChannelFlowControl

**[`message-decoding.md`](message-decoding.md)** ✅
- Header size detection and incremental decoding (streaming input)
- Message type identification (0=ACK, 1=control, 2=data)
- ACK message decoding with range interpretation
- Channel control message decoding with sequence validation
- Channel data message decoding with multi-chunk support
- Zero-copy data extraction via VirtualBuffer
- Protocol validation (invalid header type, out-of-order, over-budget)
- Module responsibilities: Protocol, VirtualBuffer, ChannelFlowControl, Transport

**[`handshake.md`](handshake.md)** ✅
- Transport handshake sequence (three phases: transmission, reception, role determination)
- Transport ID exchange (crypto.randomUUID())
- Configuration exchange (c2cEnabled, minChannelId, minMessageTypeId, version)
- Operating value calculation (max of local and remote minChannelId/minMessageTypeId)
- Role determination (EVEN_ROLE vs ODD_ROLE based on UUID comparison)
- Protocol version negotiation (version 1)
- Switching to binary stream (SOH marker)
- VirtualRWBuffer accumulation for input (reader-supplied buffers up to SOH)
- Zero-copy encoding/decoding (OutputRingBuffer for output, VirtualRWBuffer for input)
- ACK-class message handling (exact: true parameter, ring buffer only)
- Foundational channel initialization (TCC, C2C if enabled)
- Module responsibilities: Transport, Protocol, OutputRingBuffer, VirtualRWBuffer, VirtualBuffer

### 7. Buffer Management

**[`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md)** ✅
- Complete buffer pool lifecycle with dual-pool architecture (clean and dirty pools)
- Buffer acquisition (clean pool → dirty pool with zeroing → allocate new)
- Buffer release to dirty pool (deferred zeroing for performance)
- Asynchronous pool management (water mark enforcement in next event loop)
- Size class selection (1KB, 4KB, 16KB, 64KB)
- Worker mode: request/receive/return buffers with zero-copy transfer
- Statistics tracking (acquired, released, allocated, transferred, clean, dirty)
- Graceful shutdown with `stop()` method
- Module responsibilities: BufferPool

**[`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md)** ✅
- Complete lifecycle for OutputRingBuffer (byte-stream transports) and VirtualRingBuffer (Worker transport)
- OutputRingBuffer: Single reusable ring with zero-after-write security and wrap-around support
- VirtualRingBuffer: Budget/space abstraction using BufferPool buffers for transferable output
- Shared pool architecture: Main and worker coordinate via buffer transfer (request/return)
- Space reservation with single pending reservation (might shrink)
- Zero-copy encoding via VirtualRWBuffer
- Committing reservation and getting buffers for I/O
- Consuming sent data (OutputRingBuffer zeros and reuses, VirtualRingBuffer transfers to worker)
- Multi-buffer support for large reservations (exceeds 64KB)
- Module responsibilities: OutputRingBuffer, VirtualRingBuffer, BufferPool, VirtualRWBuffer

**[`virtual-buffer-operations.md`](virtual-buffer-operations.md)** ✅
- Creating virtual buffers (VirtualBuffer read-only, VirtualRWBuffer read-write)
- Multi-segment views (2+ segments: OutputRingBuffer wrap-around, VirtualRingBuffer large reservations)
- Text decoding with streaming (handles UTF-8 sequences split across segments)
- DataView operations (getUint8/16/32, setUint8/16/32)
- Segment caching optimization (minimizes segment searches during sequential access)
- Slicing and copying (zero-copy slice, toUint8Array copy)
- Write operations (set, fill, encodeFrom with shrinking)
- Single pending reservation model (enforced by ring buffer)
- Multi-chunk encoding loop (reserve→encode→shrink→commit cycle)
- Module responsibilities: VirtualBuffer, VirtualRWBuffer

### 8. Channel Multiplexing

**[`channel-multiplexing.md`](channel-multiplexing.md)** 📋
- Multiple bidirectional channels over single transport
- Even/odd channel ID management
- Fair scheduling across channels
- Transport budget vs channel budget
- Preventing channel starvation
- Module responsibilities: Transport, Channel, ChannelFlowControl

### 9. Console and Exception Handling

**[`console-intercept.md`](console-intercept.md)** 📋
- Console method interception
- Routing console output to C2C channel (bidirectional channel 1)
- Log level handling (message types 0-5: exceptions, trace, debug, info/log, warn, error)
- Applet → Responder → Operator → Logger pipeline
- Module responsibilities: Transport, Channel (or dedicated console handler)

**[`exception-intercept.md`](exception-intercept.md)** 📋
- Uncaught exception handling
- Error serialization
- Routing exceptions to C2C channel (message type 0)
- Stack trace preservation
- Module responsibilities: Transport, Channel (or dedicated exception handler)

### 10. Transport-Specific Scenarios

**[`http-transport.md`](http-transport.md)** *(Future)* 📋
- HTTP connection establishment
- Request/response mapping
- Long-polling considerations
- Module responsibilities: HTTPTransport, Transport base

**[`websocket-transport.md`](websocket-transport.md)** *(Future)* 📋
- WebSocket connection
- Frame handling
- Ping/pong keepalive
- Module responsibilities: WebSocketTransport, Transport base

**[`worker-transport.md`](worker-transport.md)** *(Future)* 📋
- Worker message passing
- Transferable objects
- Object vs binary format
- Module responsibilities: WorkerTransport, Transport base

**[`pipe-transport.md`](pipe-transport.md)** *(Future)* 📋
- IPC pipe setup
- stdin/stdout/stderr handling
- Out-of-band data
- Module responsibilities: PipeTransport, Transport base

**[`nested-transport.md`](nested-transport.md)** *(Future)* 📋
- PolyTransport over channel (requires bidirectional channel)
- Nested flow control (transport budget and channel budget at each layer)
- Relay scenarios
- Module responsibilities: NestedTransport, Transport base, Channel

### 11. Advanced Scenarios

**[`bidirectional-streaming.md`](bidirectional-streaming.md)** *(Future)* 📋
- Simultaneous read/write on bidirectional channels
- Send and receive flow control coordination
- Deadlock prevention
- Module responsibilities: Channel, ChannelFlowControl

**[`error-recovery.md`](error-recovery.md)** *(Future)* 📋
- Connection loss detection
- Reconnection strategies
- State recovery
- Module responsibilities: Transport, Channel

**[`backpressure-propagation.md`](backpressure-propagation.md)** *(Future)* 📋
- Flow control across nested transports
- End-to-end backpressure (transport budget and channel budget at each layer)
- Buffer management under pressure
- Module responsibilities: Transport, Channel, ChannelFlowControl

## Scenario Document Format

Each scenario document should include:

1. **Overview**: Brief description of the scenario
2. **Preconditions**: Required state before scenario begins
3. **Actors**: Components/modules involved
4. **Step-by-Step Sequence**: Detailed operation flow with:
   - Action description
   - Responsible module
   - Data structures involved
   - State changes
5. **Postconditions**: Expected state after scenario completes
6. **Error Conditions**: Possible failures and handling
7. **Related Scenarios**: Links to related scenario documents
8. **Implementation Notes**: Key considerations for developers

## Status Legend

- ✅ **Complete**: Scenario documented and reviewed (may need updates for 2026-01-12 bidirectional channel redesign)
- 🚧 **In Progress**: Scenario being written
- 📋 **Planned**: Scenario identified but not yet started
- *(Future)*: Scenario for future implementation phases

## Current Status Summary (2026-01-20)

- **25 scenarios complete** (✅):
  - **Transport Lifecycle**:
    - [`transport-initialization.md`](transport-initialization.md) - Transport startup with TCC/C2C channels, **role determination** (step 7d), handshake
    - [`transport-shutdown.md`](transport-shutdown.md) - Graceful transport closure with channel cleanup and timeout handling
  - **Channel Lifecycle**:
    - [`channel-request.md`](channel-request.md) - Requesting side of channel creation with pending request tracking
    - [`channel-acceptance.md`](channel-acceptance.md) - Accepting side with ID assignment and event handlers
    - [`id-jitter-settlement.md`](id-jitter-settlement.md) - Simultaneous requests and automatic ID settlement
    - [`channel-closure.md`](channel-closure.md) - Channel closure protocol with graceful/discard modes
  - **Message-Type Registration**:
    - [`message-type-registration.md`](message-type-registration.md) - Message-type registration on channels
  - **Data Transfer**:
    - [`simple-write.md`](simple-write.md) - Single-chunk write with zero-copy encoding
    - [`multi-chunk-write.md`](multi-chunk-write.md) - Multi-chunk write with automatic chunking
    - [`simple-read.md`](simple-read.md) - Single-chunk read with chunk object API
    - [`streaming-read.md`](streaming-read.md) - Multi-chunk read with streaming vs buffering
  - **Flow Control and Budgets**:
    - [`ack-generation-processing.md`](ack-generation-processing.md) - ACK generation and processing (ring buffer only, fire-and-forget)
    - [`receive-flow-control.md`](receive-flow-control.md) - Receive-side flow control with validation and consumption tracking
    - [`send-flow-control.md`](send-flow-control.md) - Send-side flow control with three-resource coordination and atomic reservations
    - [`protocol-violation.md`](protocol-violation.md) - Protocol violation detection and handling with application-defined policies
  - **Buffer Management**:
    - [`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md) - Complete buffer pool lifecycle with dual-pool architecture and async management
    - [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - OutputRingBuffer (byte-stream) and VirtualRingBuffer (Worker) with shared pool architecture
    - [`virtual-buffer-operations.md`](virtual-buffer-operations.md) - VirtualBuffer and VirtualRWBuffer operations with segment caching and multi-segment support
  - **Message Protocol**:
    - [`message-encoding.md`](message-encoding.md) - Message encoding with zero-copy into ring buffer, remaining size encoding, ACK/control/data headers
    - [`message-decoding.md`](message-decoding.md) - Message decoding with incremental parsing, zero-copy extraction, protocol validation
    - [`handshake.md`](handshake.md) - Transport handshake with UUID exchange, role determination, operating value calculation, VirtualRWBuffer accumulation
- **All other scenarios planned** (📋): Not yet written, will incorporate bidirectional channel model from the start

**Note**: Role determination is fully documented in [`transport-initialization.md`](transport-initialization.md) step 7d (lines 316-351). A separate scenario is not needed as it's an integral part of the handshake sequence.

## Contributing

When adding new scenarios:
1. Follow the established format
2. Update this CONTENTS.md with the new scenario
3. Link related scenarios bidirectionally
4. Ensure step sequences align with architecture documents
5. Reference specific code locations where applicable

Scenarios:
- MUST include textual descriptions
- MAY include diagrams to *supplement* textual descriptions
