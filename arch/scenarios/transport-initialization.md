# Transport Initialization Scenario

## Overview

This scenario describes the complete process of creating and starting a PolyTransport instance, from construction through handshake completion and readiness to accept channel requests.

## Preconditions

- Runtime environment is ready (Deno, Node.js, or browser)
- Transport-specific resources are available (network socket, IPC pipe, worker, etc.)
- **Console and exception interception is configured by application** (if needed):
  - Application (or applet bootstrap) sets up interception before starting transport
  - Interception must check if C2C channel is active and route output accordingly
  - Worker console/exceptions are typically intercepted and routed through main thread
  - Main thread may then use IPC transport for further routing

## Architectural Note

**IMPORTANT**: This scenario reflects the **bidirectional channel model** (2026-01-12 update). All channels are now bidirectional, with transport role (EVEN_ROLE vs ODD_ROLE) determining ID assignment. See [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md) for details.

## Actors

- **Application Code**: Creates and configures the transport
- **Transport Base Class** ([`src/transport/base.esm.js`](../../src/transport/base.esm.js)): Provides common lifecycle management
- **Transport Implementation**: Specific transport subclass (HTTP, WebSocket, Worker, Pipe, Nested)
- **Protocol Layer** ([`src/protocol.esm.js`](../../src/protocol.esm.js)): Handles handshake encoding/decoding
- **OutputRingBuffer** ([`src/output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js)): Zero-copy output buffer
- **BufferPool** ([`src/buffer-pool.esm.js`](../../src/buffer-pool.esm.js)): Reusable buffer management
- **Eventable**: Event handling infrastructure (from `@eventable`)

## Step-by-Step Sequence

### 1. Transport Construction

**Action**: Application creates transport instance
**Responsible**: Application Code, Transport Implementation
**Code Location**: [`Transport.constructor()`](../../src/transport/base.esm.js:30)

```javascript
const transport = new SomeTransport({
  logger: customLogger,  // Optional, defaults to console
  // ... transport-specific options
});
```

**State Changes**:
- `#started = false`
- `#stopped = false`
- `#channels = new Map()`
- `#channelDefaults` initialized with default values:
  - `maxBufferBytes: 0` (unlimited)
  - `maxChunkBytes: 0` (transport limit)
  - `maxMessageBytes: 0` (unlimited)
  - `lowBufferBytes: 0` (no low-water mark)
- `#logger` set to provided logger or `console`
- **`#transportId`** generated via `crypto.randomUUID()`
- `#transportRole` initially `null` (determined during handshake)

**Implementation Note**: The base class extends `Eventable` for async event handling, not `EventTarget`.

### 1a. Generate Transport UUID

**Action**: Generate unique transport identifier
**Responsible**: Transport Implementation
**Requirements Reference**: [`arch/bidi-chan-even-odd-update.md:31-33`](../bidi-chan-even-odd-update.md:31)

```javascript
// In constructor or _start()
this.#transportId = crypto.randomUUID();
// Example: "550e8400-e29b-41d4-a716-446655440000"
```

**Purpose**: Transport UUID is used to determine transport role (EVEN_ROLE vs ODD_ROLE) after handshake exchange. The transport with the lexicographically lower UUID gets EVEN_ROLE, which assigns even channel/message-type IDs.

**State Changes**:
- `#transportId` set to UUID string

### 2. Configure Channel Defaults (Optional)

**Action**: Application configures default channel options  
**Responsible**: Application Code  
**Code Location**: [`Transport.setChannelDefaults()`](../../src/transport/base.esm.js:43)

```javascript
transport.setChannelDefaults({
  maxBufferBytes: 256 * 1024,  // 256KB buffer limit
  maxChunkBytes: 64 * 1024,    // 64KB chunk limit
  maxMessageBytes: 1024 * 1024, // 1MB message limit
  lowBufferBytes: 64 * 1024,   // Send ACK when buffer drops below 64KB
});
```

**State Changes**:
- `#channelDefaults` updated with provided values
- Only specified fields are updated (partial updates supported)

**Data Structures**:
```javascript
#channelDefaults = {
  maxBufferBytes: number,    // 0 = unlimited
  maxChunkBytes: number,     // 0 = transport limit
  maxMessageBytes: number,   // 0 = unlimited
  lowBufferBytes: number,    // 0 = no low-water mark
}
```

### 3. Register Event Handlers

**Action**: Application registers event handlers before starting  
**Responsible**: Application Code, Eventable  
**Code Location**: Inherited from `Eventable`

```javascript
// Register newChannelRequest handler (critical - prevents auto-rejection)
transport.addEventListener('newChannelRequest', async (event) => {
  const channel = event.accept({
    maxBufferBytes: 256 * 1024,
    maxChunkBytes: 64 * 1024,
    maxMessageBytes: 1024 * 1024,
    lowBufferBytes: 64 * 1024,
  });
  
  // Register channel-specific handlers
  channel.addEventListener('newChunk', handleChunk);
  channel.addEventListener('beforeClosing', handleBeforeClosing);
  channel.addEventListener('closed', handleClosed);
});

// Register transport-level handlers
transport.addEventListener('beforeStopping', handleTransportBeforeStopping);
transport.addEventListener('stopped', handleTransportStopped);
transport.addEventListener('outofBandData', handleOutOfBand); // IPC only
```

**Important**: At least one `newChannelRequest` handler should be registered before calling `start()`, otherwise all incoming channel requests will be auto-rejected.

### 4. Start Transport

**Action**: Application calls `start()` to begin I/O operations
**Responsible**: Application Code, Transport Base
**Code Location**: [`Transport.start()`](../../src/transport/base.esm.js:70)

```javascript
await transport.start();
```

**Validation**:
- Throws `Error('Transport is stopped')` if `#stopped === true`
- Throws `Error('Transport already started')` if `#started === true`

**State Changes**:
- `#started = true`

**Delegation**:
- Calls abstract method `_start()` which must be implemented by subclass
- Subclass performs transport-specific initialization

### 5. Initialize Buffer Management

**Action**: Set up buffer pool and output ring buffer  
**Responsible**: Transport Implementation  
**Code Location**: Subclass `_start()` method (not yet implemented)

**Buffer Pool Initialization**:
```javascript
// Create buffer pool with size classes
this.bufferPool = new BufferPool({
  sizes: [1024, 4096, 16384, 65536],  // 1KB, 4KB, 16KB, 64KB
  lowWaterMarks: { 1024: 4, 4096: 4, 16384: 2, 65536: 2 },
  highWaterMarks: { 1024: 16, 4096: 16, 16384: 8, 65536: 8 },
});
```

**Output Ring Buffer Initialization**:
```javascript
// Create output ring buffer for zero-copy writing
this.outputRing = new OutputRingBuffer(256 * 1024);  // 256KB default
```

**State Changes**:
- Buffer pool ready for acquiring/releasing buffers
- Output ring buffer ready for reservations
- Input buffers can be acquired from pool as needed

**Important**: Ring buffer must be initialized **before** handshake encoding, since handshake is encoded directly into the ring buffer.

### 6. Establish Connection (Transport-Specific)

**Action**: Establish underlying connection  
**Responsible**: Transport Implementation

**For byte-stream transports** (HTTP, WebSocket, Pipe, Nested):
- Open socket, pipe, or nested channel
- Set up readable/writable streams
- Begin reading from input stream

**For Worker transport**:
- Set up `postMessage` handler
- Begin processing incoming messages

### 7. Handshake Sequence (Byte-Stream Transports)

**Action**: Exchange transport configuration  
**Responsible**: Transport Implementation, Protocol Layer, OutputRingBuffer  
**Code Location**: [`protocol.encodeHandshakeInto()`](../../src/protocol.esm.js:388), [`protocol.decodeHandshakeFrom()`](../../src/protocol.esm.js:432)

**Requirements Reference**: [`arch/requirements.md:395-413`](../../arch/requirements.md:395)

#### 7a. Encode and Send Transport Identifier

**Format**: `\x02PolyTransport\x03` (15 bytes)  
**Bytes**: `[2, 80, 111, 108, 121, 84, 114, 97, 110, 115, 112, 111, 114, 116, 3]`

**Note**: Not sent for PTOC (PolyTransport-over-channel) transports

**Encoding Process**:
```javascript
// Reserve space in output ring buffer
const reservation = this.outputRing.reserve(15);
if (!reservation) {
  throw new Error('Failed to reserve space for transport identifier');
}

// Write identifier bytes
const identifier = [2, 80, 111, 108, 121, 84, 114, 97, 110, 115, 112, 111, 114, 116, 3];
for (let i = 0; i < identifier.length; i++) {
  reservation.setUint8(i, identifier[i]);
}

// Commit reservation
this.outputRing.commit(reservation);

// Get buffers for writing
const buffers = this.outputRing.getBuffers(15);
await this.writeToStream(buffers);

// Consume sent data
this.outputRing.consume(15);
```

#### 7b. Encode and Send Transport Configuration

**Format**: `\x02{"...}\x03` (JSON, variable length)  
**Bytes**: `[2, 123, 34, ..., 125, 3]`

**Configuration Fields** (requirements.md:406-413, bidi-chan-even-odd-update.md:31-33):
```javascript
{
  transportId: "550e8400-e29b-41d4-a716-446655440000",  // Transport UUID
  c2cEnabled: false,           // Enable console-content channel (C2C)
  c2cMaxBuffer: undefined,     // Optional C2C buffer limit
  c2cMaxCount: undefined,      // Optional C2C message count limit
  minChannelId: 256,           // Minimum auto-assigned channel ID
  minMessageTypeId: 1024,      // Minimum auto-assigned message type ID
  version: 1,                  // Protocol version
}
```

**Encoding Process**:
```javascript
// Prepare configuration
const config = {
  transportId: this.#transportId,  // Include transport UUID
  c2cEnabled: this.c2cEnabled || false,
  minChannelId: this.minChannelId || 256,
  minMessageTypeId: this.minMessageTypeId || 1024,
  version: 1,
};

// Reserve space in output ring buffer
const handshakeSize = protocol.handshakeSize(config);
const reservation = this.outputRing.reserve(handshakeSize);
if (!reservation) {
  throw new Error('Failed to reserve space for handshake');
}

// Encode handshake into reservation
protocol.encodeHandshakeInto(reservation, 0, config);

// Commit, write, and consume
this.outputRing.commit(reservation);
const buffers = this.outputRing.getBuffers(handshakeSize);
await this.writeToStream(buffers);
this.outputRing.consume(handshakeSize);
```

#### 7c. Receive and Decode Remote Configuration

**Action**: Parse incoming handshake from remote transport
**Responsible**: Transport Implementation, Protocol Layer, BufferPool

**Reading Process**:
```javascript
// Read from input stream into buffer pool buffer
const buffer = this.bufferPool.acquire(1024);  // Handshake typically < 1KB
const bytesRead = await this.readFromStream(buffer);

// Create VirtualBuffer view
const vb = new VirtualBuffer(buffer, 0, bytesRead);

// Decode handshake
const remoteConfig = protocol.decodeHandshakeFrom(vb, 0);
// Returns: { transportId, c2cEnabled, c2cMaxBuffer, c2cMaxCount, minChannelId, minMessageTypeId, version }

// Release buffer back to pool
this.bufferPool.release(buffer);
```

**State Changes**:
- Store remote configuration for channel ID assignment
- Store remote transport ID for role determination
- Determine if C2C should be activated (both sides must enable)
- Validate protocol version compatibility

#### 7d. Determine Transport Role

**Action**: Compare transport UUIDs to determine EVEN_ROLE vs ODD_ROLE
**Responsible**: Transport Implementation
**Requirements Reference**: [`arch/bidi-chan-even-odd-update.md:31-33`](../bidi-chan-even-odd-update.md:31)

```javascript
// Constants (defined in transport module)
const EVEN_ROLE = 0;
const ODD_ROLE = 1;

// Compare local and remote transport IDs lexicographically
if (this.#transportId < remoteConfig.transportId) {
  this.#transportRole = EVEN_ROLE;
  this.#nextChannelId = Math.max(256, this.minChannelId);
  // Ensure even starting ID
  if (this.#nextChannelId % 2 !== 0) this.#nextChannelId++;
} else if (this.#transportId > remoteConfig.transportId) {
  this.#transportRole = ODD_ROLE;
  this.#nextChannelId = Math.max(256, this.minChannelId);
  // Ensure odd starting ID
  if (this.#nextChannelId % 2 === 0) this.#nextChannelId++;
} else {
  throw new Error('Transport IDs must be unique (both sides generated same UUID)');
}
```

**State Changes**:
- `#transportRole` set to `EVEN_ROLE` (0) or `ODD_ROLE` (1)
- `#nextChannelId` initialized to first even/odd ID >= minChannelId
- `#nextMessageTypeId` initialized similarly (per-channel, not set here)

**Key Insight**:
- EVEN_ROLE assigns even IDs (0, 2, 4, 6, ...)
- ODD_ROLE assigns odd IDs (1, 3, 5, 7, ...)
- This prevents ID collisions during simultaneous channel/message-type requests
- See [`role-determination.md`](role-determination.md) for detailed scenario

#### 7e. Send Binary Stream Marker

**Format**: `\x01` (1 byte)
**Bytes**: `[1]`

**Encoding Process**:
```javascript
// Reserve, encode, commit, write, consume
const reservation = this.outputRing.reserve(1);
reservation.setUint8(0, 0x01);
this.outputRing.commit(reservation);
const buffers = this.outputRing.getBuffers(1);
await this.writeToStream(buffers);
this.outputRing.consume(1);
```

**State Changes**: Transport enters binary message mode

### 8. Initialize Transport Control Channel (TCC)

**Action**: Activate permanent channel 0
**Responsible**: Transport Implementation
**Requirements Reference**: [`arch/requirements.md:482-493`](../../arch/requirements.md:482), [`arch/bidi-chan-even-odd-update.md:77-86`](../bidi-chan-even-odd-update.md:77)

**Channel Properties**:
- **Channel ID**: 0 (permanent, reserved)
- **Lifecycle**: Opens and closes with transport
- **Purpose**: Transport-level control messages (channel setup/teardown, transport shutdown)
- **Direction**: Bidirectional (both sides can send/receive)
- **Access**: Internal only via private symbol `XP_CTRL_CHANNEL` (no user access)

**Pre-defined Message Types** (bidi-chan-even-odd-update.md:123-130):
- **0**: `tranStop` - Transport shutdown initiation and progress
- **1**: `chanReq` - Channel setup request
- **2**: `chanResp` - Channel setup response (accept/reject)
- **3**: `mesgTypeReq` - Message-type registration request (shared with all channel control messages)
- **4**: `mesgTypeResp` - Message-type registration response (shared with all channel control messages)

**Important Notes**:
- TCC uses **data messages** (type 2) for channel setup/teardown (not control messages)
- TCC message-type mappings are **shared** with control messages for all channels
- Channel control messages (type 1) use the same message-type IDs as TCC data messages
- **No numeric access**: Users cannot access channels by numeric ID
- Only accessible within transport implementation via private symbol

**State Changes**:
- Register channel 0 in `#channels` map
- Pre-load message-type mappings (0-4) into TCC channel
- Channel is bidirectional and ready for transport control operations

### 9. Initialize Console-Content Channel (C2C) - Optional

**Action**: Activate permanent channel 1 if enabled
**Responsible**: Transport Implementation
**Requirements Reference**: [`arch/requirements.md:495-505`](../../arch/requirements.md:495), [`arch/bidi-chan-even-odd-update.md:87-89`](../bidi-chan-even-odd-update.md:87)

**Conditions**:
- Both local and remote `c2cEnabled: true` in handshake
- Channel ID 1 is reserved regardless of activation

**Channel Properties**:
- **Channel ID**: 1 (permanent, reserved)
- **Direction**: **Bidirectional** (both sides can send/receive)
  - Updated from unidirectional model per bidi-chan-even-odd-update.md
- **Lifecycle**: Opens and closes with transport
- **Purpose**: Console output and exception routing
- **Access**: Via `PolyTransport.LOG_CHANNEL` symbol (writable: false, configurable: true)
  - Read-only but removable by applet bootstrap during environment sanitization
  - **No numeric access**: Users cannot access channel 1 directly by ID

**Pre-defined Message Types**:
- **0**: Uncaught exception messages
- **1**: `debug`-level messages
- **2**: `info/log`-level messages
- **3**: `warn`-level messages
- **4**: `error`-level messages

**State Changes**:
- Register channel 1 in `#channels` map (if enabled)
- Expose channel via `PolyTransport.LOG_CHANNEL` symbol
- Application's console interception can now check if C2C is active
- If active, route console/exception output to C2C channel

**Important**: Console/exception interception is set up by the application **before** starting the transport. The interception code checks if the C2C channel is currently active (via `PolyTransport.LOG_CHANNEL`) and routes output accordingly.

### 10. Begin Message Processing Loop

**Action**: Start reading and processing incoming messages  
**Responsible**: Transport Implementation

**Expected Behavior**:
- Read from input stream into buffer pool buffers
- Parse message headers using Protocol layer
- Route messages to appropriate handlers:
  - **Type 0 (ACK)**: Process via ChannelFlowControl
  - **Type 1 (Control)**: Handle channel control messages
  - **Type 2 (Data)**: Route to channel's receive buffer
- Handle out-of-band data (IPC only) via `outofBandData` event

**Data Flow**:
```
Input Stream → Buffer Pool → Protocol.decodeHeaderFrom() → Message Router
  ↓
  ├─ ACK → ChannelFlowControl.processAck()
  ├─ Control → Channel control handler
  └─ Data → Channel receive buffer → ChannelFlowControl.recordReceived()
```

## Postconditions

- Transport is in `started` state (`#started === true`)
- Transport UUID generated and transport role determined (EVEN_ROLE or ODD_ROLE)
- Buffer pool and output ring buffer are initialized and ready
- Transport is ready to accept channel requests
- TCC (channel 0) is active and ready with pre-loaded message types (0-4)
- C2C (channel 1) is active if enabled by both sides, accessible via `PolyTransport.LOG_CHANNEL`, with pre-loaded message types (0-4)
- Event handlers are registered and ready
- Message processing loop is running
- Handshake is complete (byte-stream transports)
- Remote configuration is known and stored
- Application's console interception can check C2C status via symbol (which should be saved before environment sanitization) and route accordingly
- Next channel ID initialized to first even/odd ID based on transport role

## Error Conditions

### Construction Errors
- **Invalid logger**: If provided logger doesn't have required methods
- **Transport-specific errors**: Connection failures, resource unavailability

### Start Errors
- **Already started**: `Error('Transport already started')`
- **Already stopped**: `Error('Transport is stopped')`
- **Buffer allocation failure**: Unable to create buffer pool or ring buffer
- **Handshake failure**: Connection closed, invalid configuration, version mismatch
- **Resource allocation failure**: Other resource issues

### Handshake Errors
- **Invalid handshake format**: Malformed JSON, missing STX/ETX markers
- **Protocol version mismatch**: Incompatible versions
- **Configuration conflict**: Conflicting settings (e.g., minChannelId overlap)
- **Ring buffer reservation failure**: Unable to reserve space for handshake

## Related Scenarios

- [`transport-shutdown.md`](transport-shutdown.md) - Graceful transport closure
- [`channel-request.md`](channel-request.md) - Requesting new channels after initialization
- [`handshake.md`](handshake.md) - Detailed handshake protocol (future)
- [`console-intercept.md`](console-intercept.md) - Console and exception interception
- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - Output ring buffer operations
- [`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md) - Buffer pool operations

## Implementation Notes

### Current Implementation Status

**✅ Implemented**:
- [`Transport` base class](../../src/transport/base.esm.js): Construction, lifecycle, event handling
- [`OutputRingBuffer`](../../src/output-ring-buffer.esm.js): Zero-copy output buffer (24 tests)
- [`BufferPool`](../../src/buffer-pool.esm.js): Reusable buffer management (24 tests)
- [`Protocol` layer](../../src/protocol.esm.js): Handshake encoding/decoding (60 tests)
- [`VirtualBuffer`/`VirtualRWBuffer`](../../src/virtual-buffer.esm.js): Zero-copy buffer views (88 tests)

**❌ Not Yet Implemented** (to be added in transport subclasses):
- Transport-specific `_start()` implementations
- Buffer pool and ring buffer initialization in transports
- Handshake sequence execution
- TCC and C2C channel initialization
- Message processing loop
- Transport-specific connection establishment

### Discrepancies Between Requirements and Implementation

1. **Handshake Sequence**: Requirements specify detailed handshake with ring buffer encoding (requirements.md:395-413), but no transport subclass implements it yet.

2. **Buffer Initialization**: Requirements imply buffer pool and ring buffer are initialized before handshake, but base class doesn't manage these.

3. **TCC and C2C Channels**: Requirements specify permanent channels 0 and 1 (requirements.md:482-505), but base class doesn't pre-register these channels.

4. **Configuration Storage**: Requirements specify configuration parameters should be readable (requirements.md:697), but base class doesn't expose `minChannelId`, `minMessageTypeId`, or other handshake config.

5. **C2C Status API**: Requirements indicate console interception checks if C2C is active, but no API exists to query C2C status.

### Key Design Decisions

1. **Ring Buffer Before Handshake**: Output ring buffer must be initialized before handshake encoding, since handshake is encoded directly into the ring buffer using `encodeHandshakeInto()`.

2. **Zero-Copy Handshake**: Handshake is encoded directly into output ring buffer reservation, avoiding intermediate buffer allocation.

3. **Buffer Pool for Input**: Input data is read into buffer pool buffers, parsed, and released back to pool.

4. **Eventable vs EventTarget**: Base class uses `Eventable` for async handler support and sequential/parallel dispatch options.

5. **State Validation Order**: Checks `stopped` before `started` to provide clearer error messages.

6. **C2C Bidirectional**: C2C channel is bidirectional per bidi-chan-even-odd-update.md (all channels are now bidirectional).

7. **Console Interception Timing**: Application sets up console/exception interception before starting transport, with ability to check if C2C is active via `PolyTransport.LOG_CHANNEL` symbol.

8. **Transport Role Determination**: Transport UUID comparison determines EVEN_ROLE vs ODD_ROLE, which controls ID assignment parity.

9. **Symbol-Based Channel Access**: Users access C2C via `PolyTransport.LOG_CHANNEL` symbol (not numeric ID 1). TCC is internal-only via `XP_CTRL_CHANNEL` symbol.

### Testing Considerations

- Test buffer pool and ring buffer initialization
- Test handshake encoding into ring buffer
- Test handshake decoding from buffer pool buffer
- Test TCC and C2C channel initialization
- Test C2C activation conditions (both sides must enable)
- Test protocol version negotiation
- Test error handling for ring buffer reservation failures
- Test error handling for handshake failures
- Test C2C status checking for console interception

### Security Considerations

1. **Untrusted Handshake Data**: Handshake JSON must be validated and sanitized before use.

2. **Resource Limits**: Configuration should enforce reasonable limits on:
   - `minChannelId` and `minMessageTypeId` ranges
   - C2C buffer and message count limits
   - Maximum number of channels
   - Buffer pool and ring buffer sizes

3. **Console Interception**: Application must set up console/exception interception before transport start to prevent data leakage.

4. **Version Validation**: Protocol version must be validated to prevent incompatible communication.

5. **Ring Buffer Security**: Output ring buffer zeros consumed space to prevent data leakage across iterations.

### Performance Considerations

1. **Zero-Copy Handshake**: Encoding directly into ring buffer avoids intermediate buffer allocation.

2. **Buffer Pre-allocation**: Buffer pool pre-allocates minimum buffers during initialization to avoid allocation delays.

3. **Ring Buffer Sizing**: Default 256KB output ring buffer should be tuned based on expected throughput.

4. **Event Handler Registration**: Register handlers before `start()` to avoid race conditions with incoming channel requests.
