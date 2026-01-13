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

**[`transport-initialization.md`](transport-initialization.md)** ✅
- Creating a transport instance
- Configuring channel defaults
- Starting the transport
- Initial handshake with transport ID exchange
- Role determination (EVEN_ROLE vs ODD_ROLE)
- TCC and C2C channel initialization (both bidirectional)
- Module responsibilities: Transport base, specific transport implementations

**[`role-determination.md`](role-determination.md)** 📋
- Transport UUID generation via `crypto.randomUUID()`
- Handshake exchange with transport IDs
- Lexicographic comparison for role assignment
- EVEN_ROLE vs ODD_ROLE implications
- Even/odd ID assignment strategy
- Module responsibilities: Transport base, Protocol

**[`transport-shutdown.md`](transport-shutdown.md)** 📋
- Graceful transport closure
- Channel cleanup sequence
- `beforeClosing` and `closed` event dispatch
- Timeout handling
- Discard vs graceful shutdown
- Transport shutdown messages on TCC (`tranStop`)
- Module responsibilities: Transport base, Channel, SendFlowControl, ReceiveFlowControl

### 2. Channel Lifecycle

**[`channel-request.md`](channel-request.md)** 📋
- Requesting a new bidirectional channel
- Channel request as TCC data message (`chanReq`)
- `newChannelRequest` event handling
- Accept/reject decision flow
- Even/odd channel ID assignment by acceptor
- Simultaneous bidirectional requests (ID jitter)
- Timeout scenarios
- Module responsibilities: Transport, Channel, Protocol

**[`channel-acceptance.md`](channel-acceptance.md)** 📋
- Receiving channel request
- Event handler invocation
- Accept response with configuration (TCC data message `chanResp`)
- Reject response with reason
- Role-based ID assignment (even or odd)
- Reusing existing IDs for named channels
- Channel registration (bidirectional)
- Module responsibilities: Transport, Channel, Protocol

**[`id-jitter-settlement.md`](id-jitter-settlement.md)** 📋
- Simultaneous channel requests from both sides
- Temporary use of higher ID during overlap
- Automatic settlement to lower ID
- ID storage in two-element array (ascending order)
- First (lowest) ID used for sending
- Module responsibilities: Transport, Channel

**[`channel-closure.md`](channel-closure.md)** 📋
- Initiating channel close (entire channel, not directional)
- Flushing pending data in both directions
- Close message on TCC (`chanClose`)
- Single `beforeClosing` and `closed` events
- Cleanup and resource release
- Module responsibilities: Channel, Transport, SendFlowControl, ReceiveFlowControl

### 3. Message-Type Registration

**[`message-type-registration.md`](message-type-registration.md)** 📋
- Registering named message types on a channel
- Batch registration protocol
- Channel control messages (`mesgTypeReq`, `mesgTypeResp`)
- Even/odd message-type ID assignment by acceptor
- TCC message-type mappings used for all control messages
- Simultaneous registration from both sides
- ID jitter and settlement for message types
- Module responsibilities: Channel, Protocol

### 4. Data Transfer

**[`simple-write.md`](simple-write.md)** 📋
- Writing data to a channel
- Data type handling (text including JSON, binary)
- Single-chunk message
- End-of-message (eom) flag
- Module responsibilities: Channel, OutputRingBuffer, VirtualRWBuffer, Protocol

**[`multi-chunk-write.md`](multi-chunk-write.md)** 📋
- Writing large data that exceeds maxChunkBytes
- Chunk splitting logic
- Sequence number assignment
- eom flag on final chunk
- String encoding across chunks
- Module responsibilities: Channel, OutputRingBuffer, VirtualRWBuffer, Protocol

**[`simple-read.md`](simple-read.md)** 📋
- Reading data from a channel
- Synchronous vs asynchronous read
- Message type filtering (`only` parameter)
- Timeout handling
- Module responsibilities: Channel, VirtualBuffer, Protocol

**[`streaming-read.md`](streaming-read.md)** 📋
- Reading multi-chunk messages
- Chunk assembly
- Detecting end-of-message
- Partial message handling
- Module responsibilities: Channel, VirtualBuffer, Protocol

### 5. Flow Control and Budgets

**Note**: SendFlowControl and ReceiveFlowControl classes remain unchanged despite bidirectional channel model. Each bidirectional channel uses one instance of each class.

**[`transport-budget.md`](transport-budget.md)** 📋
- Transport-level budget management
- ACK messages and transport budget (ACKs are transport-level, not channel-level)
- Distinction from channel budget
- Transport-level flow control
- Module responsibilities: Transport, SendFlowControl, ReceiveFlowControl

**[`channel-budget.md`](channel-budget.md)** 📋
- Channel-level budget management
- Control messages and channel budget (type 1 headers)
- Data messages and channel budget (type 2 headers)
- Per-channel budget tracking (bidirectional channels have both send and receive budgets)
- Module responsibilities: Channel, SendFlowControl, ReceiveFlowControl

**[`send-flow-control.md`](send-flow-control.md)** 📋
- Checking available sending budget (transport and channel)
- Waiting for credit (async)
- Recording sent chunks
- In-flight tracking
- Budget calculation
- Module responsibilities: SendFlowControl, Channel

**[`receive-flow-control.md`](receive-flow-control.md)** 📋
- Recording received chunks
- Sequence validation
- Budget validation (over-budget detection)
- Buffer usage tracking
- Consumption tracking
- Module responsibilities: ReceiveFlowControl, Channel

**[`ack-generation-processing.md`](ack-generation-processing.md)** 📋
- Generating ACK information
- Range-based acknowledgments
- ACK message format (transport-level, type 0 headers)
- Processing received ACKs
- Credit restoration
- Unblocking waiting writes
- Module responsibilities: ReceiveFlowControl, SendFlowControl, Protocol

**[`protocol-violation.md`](protocol-violation.md)** 📋
- Out-of-order sequence detection
- Over-budget chunk detection
- ProtocolViolationError handling
- Transport event emission
- Connection termination
- Module responsibilities: ReceiveFlowControl, Transport, Channel

### 6. Message Protocol

**[`message-encoding.md`](message-encoding.md)** 📋
- ACK message encoding (type 0 headers, transport-level)
- Channel control message encoding (type 1 headers, on-channel)
- Channel data message encoding (type 2 headers, on-channel)
- TCC data messages for channel setup/teardown
- Header format details
- Zero-copy encoding into ring buffer
- Module responsibilities: Protocol, OutputRingBuffer, VirtualRWBuffer

**[`message-decoding.md`](message-decoding.md)** 📋
- Header size detection
- Message type identification (0=ACK, 1=control, 2=data)
- ACK message decoding
- Channel control message decoding
- Channel data message decoding
- Multi-segment buffer handling
- Module responsibilities: Protocol, VirtualBuffer

**[`handshake.md`](handshake.md)** 📋
- Transport handshake sequence
- Transport ID exchange
- Configuration exchange
- Role determination (EVEN_ROLE vs ODD_ROLE)
- Protocol version negotiation
- Switching to binary stream
- Module responsibilities: Transport, Protocol

### 7. Buffer Management

**[`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md)** 📋
- Buffer acquisition
- Size class selection
- Water mark management
- Buffer release and zeroing
- Worker buffer transfer
- Module responsibilities: BufferPool

**[`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md)** 📋
- Space reservation
- Writing to reservation (VirtualRWBuffer)
- Committing reservation
- Getting buffers for I/O
- Consuming sent data
- Wrap-around handling
- Module responsibilities: OutputRingBuffer, VirtualRWBuffer

**[`virtual-buffer-operations.md`](virtual-buffer-operations.md)** 📋
- Creating virtual buffers
- Multi-segment views
- Text decoding
- DataView operations
- Slicing and copying
- Module responsibilities: VirtualBuffer, VirtualRWBuffer

### 8. Channel Multiplexing

**[`channel-multiplexing.md`](channel-multiplexing.md)** 📋
- Multiple bidirectional channels over single transport
- Even/odd channel ID management
- Fair scheduling across channels
- Transport budget vs channel budget
- Preventing channel starvation
- Module responsibilities: Transport, Channel, SendFlowControl, ReceiveFlowControl

### 9. Console and Exception Handling

**[`console-intercept.md`](console-intercept.md)** 📋
- Console method interception
- Routing console output to C2C channel (bidirectional channel 1)
- Log level handling (message types 0-4)
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
- Module responsibilities: Channel, SendFlowControl, ReceiveFlowControl

**[`error-recovery.md`](error-recovery.md)** *(Future)* 📋
- Connection loss detection
- Reconnection strategies
- State recovery
- Module responsibilities: Transport, Channel

**[`backpressure-propagation.md`](backpressure-propagation.md)** *(Future)* 📋
- Flow control across nested transports
- End-to-end backpressure (transport budget and channel budget at each layer)
- Buffer management under pressure
- Module responsibilities: Transport, Channel, SendFlowControl, ReceiveFlowControl

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

## Current Status Summary (2026-01-12)

- **1 scenario complete** (✅): [`transport-initialization.md`](transport-initialization.md) - needs updates for transport ID and role determination
- **3 new scenarios needed** (📋): role-determination.md, id-jitter-settlement.md, message-type-registration.md
- **All other scenarios planned** (📋): Not yet written, will incorporate bidirectional channel model from the start

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
