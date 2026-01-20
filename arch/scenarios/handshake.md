# Transport Handshake Scenario

## Overview

The transport handshake is the initial protocol exchange that establishes a PolyTransport connection between two endpoints. It occurs immediately after the underlying connection (TCP, WebSocket, IPC pipe, etc.) is established and before any binary message stream begins.

The handshake accomplishes three critical tasks:
1. **Transport identification** - Verify both sides are speaking PolyTransport protocol
2. **Configuration exchange** - Share transport settings (C2C enabled, version, transport ID)
3. **Role determination** - Establish EVEN_ROLE vs ODD_ROLE for channel/message-type ID assignment

This scenario documents the handshake sequence from both the initiating and receiving perspectives.

## Preconditions

- Underlying connection established (TCP socket, WebSocket, IPC pipe, Worker message channel, etc.)
- Transport instance created with configuration
- Transport not yet started (handshake occurs during `start()`)
- For byte-stream transports: Out-of-band data capture ready (console/exception intercept)

## Actors

- **Transport** ([`src/transport/base.esm.js`](../../src/transport/base.esm.js)) - Orchestrates handshake sequence
- **Protocol** ([`src/protocol.esm.js`](../../src/protocol.esm.js)) - Encodes/decodes handshake messages
- **OutputRingBuffer** ([`src/output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js)) - Provides buffer space for encoding (byte-stream transports)
- **VirtualRWBuffer** ([`src/virtual-buffer.esm.js`](../../src/virtual-buffer.esm.js)) - Zero-copy encoding target (output) and accumulation buffer (input)
- **VirtualBuffer** ([`src/virtual-buffer.esm.js`](../../src/virtual-buffer.esm.js)) - Zero-copy decoding source

## Handshake Format

The handshake consists of three parts (requirements.md:400-404):

```
\x02PolyTransport\x03          (15 bytes: STX + identifier + ETX)
\x02{"transportId":"...",...}\x03  (variable: STX + JSON config + ETX)
\x01                           (1 byte: SOH - switch to binary stream)
```

**Example** (simplified config):
```
02 50 6F 6C 79 54 72 61 6E 73 70 6F 72 74 03  (\x02PolyTransport\x03)
02 7B 22 74 72 61 6E 73 70 6F 72 74 49 64 22 3A 22 ... 7D 03  (\x02{"transportId":"...",...}\x03)
01  (\x01)
```

**Configuration Fields** (requirements.md:406-413):
- `transportId` (string, **required**) - Transport UUID for role determination (bidi-chan-even-odd-update.md:31-33)
- `c2cEnabled` (boolean, default: false) - Enable Console-Content Channel (channel 1)
- `c2cMaxBuffer` (number) - Maximum C2C buffer size (required if c2cEnabled is true)
- `c2cMaxCount` (number) - Maximum C2C message count (required if c2cEnabled is true)
- `minChannelId` (number, **required**) - Minimum auto-assigned channel ID
  - Minimum value must account for reserved channels (0=TCC, 1=C2C)
  - Operating value is `Math.max(local.minChannelId, remote.minChannelId)`
- `minMessageTypeId` (number, default: 0) - Minimum auto-assigned message-type ID
  - Operating value is `Math.max(local.minMessageTypeId, remote.minMessageTypeId)`
- `version` (number, default: 1) - Protocol version

## Step-by-Step Sequence

### Phase 1: Handshake Transmission

#### Step 1: Generate Transport ID (if not provided)

**Actor**: Transport

**Action**: Generate or use provided transport ID for role determination.

```javascript
// In transport constructor or start()
if (!this.#transportId) {
	this.#transportId = crypto.randomUUID();  // e.g., "550e8400-e29b-41d4-a716-446655440000"
}
```

**State Changes**:
- Transport `#transportId` field set

**Notes**:
- Transport ID must be unique per transport instance
- Used for deterministic role assignment (EVEN_ROLE vs ODD_ROLE)
- Persists for lifetime of transport
- **Required** in handshake configuration (not optional)

#### Step 2: Prepare Configuration Object

**Actor**: Transport

**Action**: Merge user-provided config with defaults, include transport ID.

```javascript
const config = {
	transportId: this.#transportId,  // REQUIRED
	c2cEnabled: this.#c2cEnabled,
	minChannelId: this.#minChannelId,
	minMessageTypeId: this.#minMessageTypeId,
	version: 1,
	// Optional fields if set:
	// c2cMaxBuffer, c2cMaxCount
};
```

**State Changes**:
- Configuration object ready for encoding

**Notes**:
- `transportId` is **required** in configuration (not optional)
- Version 1 is current protocol version
- Optional fields only included if explicitly set

#### Step 3: Reserve Ring Buffer Space (Byte-Stream Transports Only)

**Actor**: Transport → OutputRingBuffer

**Action**: Reserve space for handshake encoding.

```javascript
// Calculate handshake size (conservative estimate)
const configJson = JSON.stringify(config);
const handshakeSize = TRANSPORT_GREETING.length + 2 + configJson.length + 2 + 1;  // Greeting + config + marker

// Reserve space with exact: true (handshake is ACK-class message)
// ACK-class messages bypass RESERVE_ACK_BYTES requirement
const reservation = this.#outputRing.reserve(handshakeSize, { exact: true });
if (!reservation) {
	// Wait for space (should be rare - ring is empty at start)
	reservation = await this.#outputRing.reserveAsync(handshakeSize, { exact: true });
}
```

**State Changes**:
- OutputRingBuffer: `#reserved` increased, `#writeHead` unchanged (pending commit)
- Reservation object (VirtualRWBuffer) created

**Notes**:
- Handshake is first message, ring should be empty
- If ring full (shouldn't happen), wait asynchronously
- **`exact: true`** - Handshake is ACK-class (fire-and-forget, no transport budget)
- ACK-class messages don't consume transport budget (no ACK-on-ACK)
- Ring buffer space freed immediately after send

**Architectural Reference**: [`arch/scenarios/ack-generation-processing.md`](ack-generation-processing.md) - ACK messages use ring buffer only

#### Step 4: Encode Handshake Into Reservation

**Actor**: Protocol → VirtualRWBuffer

**Action**: Encode handshake directly into ring buffer reservation.

```javascript
// Protocol.encodeHandshakeInto(target, offset, config)
const bytesWritten = Protocol.encodeHandshakeInto(reservation, 0, config);
```

**Encoding Steps** (Protocol layer):

1. **Transport Greeting** (15 bytes):
   ```javascript
   let o = 0; // Current write offset
   target.setUint8(o++, 0x02);  // STX
   // Write "PolyTransport" greeting (13 bytes)
   const { written: greetBytes } = target.encodeFrom('PolyTransport', o);
   o += greetBytes;
   target.setUint8(o++, 0x03);  // ETX
   ```

2. **Configuration JSON** (variable length):
   ```javascript
   target.setUint8(o++, 0x02);  // STX
   const configJson = JSON.stringify(config);
   const { written: configBytes } = target.encodeFrom(configJson, o);
   o += configBytes;
   target.setUint8(o++, 0x03);  // ETX
   ```

3. **Binary Stream Marker** (1 byte):
   ```javascript
   target.setUint8(o++, 0x01);  // SOH
   const bytesWritten = o;
   ```

**State Changes**:
- VirtualRWBuffer: Data written to underlying ring buffer segments
- `bytesWritten` = actual handshake size

**Notes**:
- Zero-copy encoding directly into ring buffer
- No intermediate buffer allocation
- Actual size may differ from estimate (shrink if needed)

#### Step 5: Shrink Reservation (If Over-Allocated)

**Actor**: Transport → OutputRingBuffer

**Action**: Release unused space if actual size < reserved size.

```javascript
if (bytesWritten < handshakeSize) {
	reservation.shrink(bytesWritten);
	this.#outputRing.shrinkReservation(reservation, bytesWritten);
}
```

**State Changes**:
- OutputRingBuffer: `#reserved` decreased by (handshakeSize - bytesWritten)
- VirtualRWBuffer: `length` updated to `bytesWritten`

**Notes**:
- Releases unused space for other operations
- Unlikely to shrink much (estimate is usually accurate)

#### Step 6: Commit Reservation

**Actor**: Transport → OutputRingBuffer

**Action**: Mark handshake as ready to send.

```javascript
this.#outputRing.commit(reservation);
```

**State Changes**:
- OutputRingBuffer: `#reserved` decreased by `bytesWritten`, `#count` increased by `bytesWritten`
- `#writeHead` advanced by `bytesWritten` (with wrap-around)
- Handshake now in "available" region

**Notes**:
- Handshake is now visible to `getBuffers()`
- Ready for transmission

#### Step 7: Send Handshake

**Actor**: Transport → Underlying Connection

**Action**: Get buffers and write to connection.

```javascript
// Get buffers for writing (1 or 2 arrays if wrapped)
const buffers = this.#outputRing.getBuffers(bytesWritten);

// Write to underlying connection
for (const buffer of buffers) {
	await this.#connection.write(buffer);  // or socket.write(), etc.
}
```

**State Changes**:
- Data transmitted over underlying connection
- OutputRingBuffer state unchanged (still in "available" region)

**Notes**:
- `getBuffers()` returns 1 array (no wrap) or 2 arrays (wrapped)
- Actual write is transport-specific (TCP, WebSocket, IPC, etc.)
- Write may be async (await completion)

#### Step 8: Consume Sent Data

**Actor**: Transport → OutputRingBuffer

**Action**: Mark handshake as sent and reclaim space.

```javascript
this.#outputRing.consume(bytesWritten);
```

**State Changes**:
- OutputRingBuffer: `#count` decreased by `bytesWritten`, `#readHead` advanced by `bytesWritten`
- Consumed region zeroed (security: prevent data leakage)
- Space now available for new reservations

**Notes**:
- Zero-after-write security (prevents leaking handshake data)
- Ring buffer space reclaimed immediately

### Phase 2: Handshake Reception

#### Step 9: Initialize Input Accumulation Buffer

**Actor**: Transport

**Action**: Create VirtualRWBuffer for accumulating incoming data.

```javascript
// Create empty accumulation buffer
this.#inputBuffer = new VirtualRWBuffer();
```

**State Changes**:
- Transport `#inputBuffer` initialized (empty)

**Notes**:
- VirtualRWBuffer accumulates data from multiple reads
- Supports incremental decoding (arbitrary read boundaries)
- No pinning or migration complexity (simplified architecture)

**Architectural Reference**: [`arch/transport-input-processing.md`](../transport-input-processing.md) - VirtualRWBuffer for input accumulation

#### Step 10: Read and Accumulate Handshake Data

**Actor**: Transport ← Underlying Connection

**Action**: Read incoming data into reader-supplied buffers and append to accumulation buffer until SOH marker found.

```javascript
// Loop until SOH (switch-to-binary-stream) marker found
let sohFound = false;
while (!sohFound) {
	// Read from connection into reader-supplied buffer
	// Reader determines buffer size (not fixed 1KB)
	const { value: buffer, done } = await this.#reader.read();
	
	if (done) {
		throw new Error('Connection closed during handshake');
	}
	
	// Check if SOH marker (0x01) is present in newly read buffer
	// SOH marks end of handshake and start of binary stream
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === 0x01) {
			sohFound = true;
			break;
		}
	}
	
	// Append entire reader-supplied buffer to accumulation buffer
	this.#inputBuffer.append(buffer);
	
	// If SOH found, we have complete handshake (or more)
	if (sohFound) break;
}
```

**State Changes**:
- Data read from connection
- VirtualRWBuffer: Reader-supplied buffers appended, length increased
- Loop continues until SOH marker found in newly read buffer

**Notes**:
- **Reader-supplied buffers**: Not fixed size (e.g., 1KB), reader determines size
- **Scan only new buffer**: Check for SOH in newly read buffer (not all accumulated data)
- **Accumulate entire buffers**: Append complete reader-supplied buffers (minimize copies)
- **SOH marker**: Signals end of handshake, start of binary stream
- **Forward-looking**: No assumptions about handshake size (supports future extensions)
- **BYOB not required**: Works with default readers (not all readers support BYOB)
- **Zero-copy**: VirtualRWBuffer references reader-supplied buffers directly

**Architectural Reference**: [`arch/transport-input-processing.md:66-78`](../transport-input-processing.md:66) - VirtualRWBuffer operations

#### Step 11: Decode Handshake (Incremental)

**Actor**: Protocol ← VirtualRWBuffer

**Action**: Parse handshake from accumulation buffer (may require multiple reads).

```javascript
// Attempt to decode handshake
const result = Protocol.decodeHandshake(this.#inputBuffer);

if (result === null) {
	// Incomplete handshake, need more data
	// Loop back to Step 10 (read more data)
	return;
}

const { config, bytesConsumed } = result;
```

**Decoding Steps** (Protocol layer):

1. **Verify Transport Identifier**:
   ```javascript
   // Check STX marker
   if (buffer.getUint8(0) !== 0x02) return null;
   
   // Find ETX marker
   let greetEnd = 1;
   while (greetEnd < buffer.length && buffer.getUint8(greetEnd) !== 0x03) greetEnd++;
   if (greetEnd >= buffer.length) return null;  // Incomplete
   
   // Decode greeting
   const greet = buffer.decode({ start: 1, end: greetEnd });
   if (greet !== 'PolyTransport') {
   	throw new Error(`Invalid transport greeting: ${greet}`);
   }
   ```

2. **Parse Configuration JSON**:
   ```javascript
   // Check STX marker
   let o = greetEnd + 1;
   if (o >= buffer.length || buffer.getUint8(o) !== 0x02) return null;
   o++;
   
   // Find ETX marker
   let configEnd = o;
   while (configEnd < buffer.length && buffer.getUint8(configEnd) !== 0x03) configEnd++;
   if (configEnd >= buffer.length) return null;  // Incomplete
   
   // Decode JSON
   const configJson = buffer.decode({ start: o, end: configEnd });
   const config = JSON.parse(configJson);
   ```

3. **Verify Binary Stream Marker**:
   ```javascript
   o = configEnd + 1;
   if (o >= buffer.length || buffer.getUint8(o) !== 0x01) return null;  // Incomplete or invalid
   o++;
   
   return { config, bytesConsumed: o };
   ```

**State Changes**:
- Remote configuration parsed and validated
- `bytesConsumed` = handshake size

**Notes**:
- Returns `null` if handshake incomplete (need more data)
- Throws error if identifier invalid
- Zero-copy decoding via VirtualBuffer
- May require multiple read-append-decode cycles

#### Step 12: Release Consumed Handshake Bytes

**Actor**: Transport → VirtualRWBuffer

**Action**: Remove consumed handshake bytes from accumulation buffer.

```javascript
// Release consumed bytes (handshake complete)
this.#inputBuffer.release(bytesConsumed);
```

**State Changes**:
- VirtualRWBuffer: Consumed segments removed, length decreased
- Any remaining data (post-handshake) stays in buffer for message processing

**Notes**:
- Frees memory from consumed segments
- Remaining data (if any) preserved for binary message stream
- VirtualRWBuffer automatically manages segment lifecycle

**Architectural Reference**: [`arch/transport-input-processing.md:77`](../transport-input-processing.md:77) - `release()` method

#### Step 13: Validate Remote Configuration

**Actor**: Transport

**Action**: Verify remote config is compatible.

```javascript
// Check protocol version
if (config.version !== 1) {
	throw new Error(`Unsupported protocol version: ${config.version}`);
}

// Check transportId is present (REQUIRED)
if (!config.transportId || typeof config.transportId !== 'string') {
	throw new Error('Remote transport transportId missing or invalid');
}

// Store remote configuration
this.#remoteConfig = config;
this.#remoteTransportId = config.transportId;
```

**State Changes**:
- Transport: `#remoteConfig` and `#remoteTransportId` set
- Configuration validated

**Notes**:
- Version mismatch is fatal (close connection)
- `transportId` is **required** for role determination
- Optional fields (c2cMaxBuffer, etc.) stored for later use

#### Step 13.5: Calculate Operating Configuration Values

**Actor**: Transport

**Action**: Determine operating minChannelId and minMessageTypeId (max of local and remote).

```javascript
// Calculate operating values (max of local and remote)
// Both sides use same values to avoid conflicts with foundational/pre-defined IDs
this.#operatingMinChannelId = Math.max(
	this.#minChannelId,
	this.#remoteConfig.minChannelId
);

this.#operatingMinMessageTypeId = Math.max(
	this.#minMessageTypeId,
	this.#remoteConfig.minMessageTypeId
);
```

**State Changes**:
- Transport: `#operatingMinChannelId` set to max of local and remote
- Transport: `#operatingMinMessageTypeId` set to max of local and remote

**Notes**:
- **Operating values**: Both sides use same values (max of local and remote)
- **Rationale**: Avoids conflicts with foundational/pre-defined channel and message-type IDs
- **Must occur before role determination**: Role determination uses operating values for `#nextChannelId` initialization
- **Example**: If local minChannelId=2 and remote minChannelId=4, operating value is 4

**Requirements Reference**: requirements.md:51-56 - Operating value is max of local and remote

### Phase 3: Role Determination

#### Step 14: Determine Transport Role

**Actor**: Transport

**Action**: Compare transport IDs to assign EVEN_ROLE or ODD_ROLE.

```javascript
// Compare transport IDs lexicographically
if (this.#transportId < this.#remoteTransportId) {
	// Lower transportId gets EVEN_ROLE
	this.#role = Transport.EVEN_ROLE;  // 0
	this.#nextChannelId = this.#operatingMinChannelId;
	// Ensure even starting ID
	if (this.#nextChannelId % 2 !== 0) this.#nextChannelId++;
	
} else if (this.#transportId > this.#remoteTransportId) {
	// Higher transportId gets ODD_ROLE
	this.#role = Transport.ODD_ROLE;  // 1
	this.#nextChannelId = this.#operatingMinChannelId;
	// Ensure odd starting ID
	if (this.#nextChannelId % 2 === 0) this.#nextChannelId++;
	
} else {
	// Same transportId - this is an error (self-connection or duplicate)
	throw new Error('Transport ID collision detected');
}
```

**State Changes**:
- Transport: `#role` set to `EVEN_ROLE` (0) or `ODD_ROLE` (1)
- Transport: `#nextChannelId` initialized to first even/odd ID >= `operatingMinChannelId`

**Role Implications**:
- **EVEN_ROLE**: Assigns even channel IDs (2, 4, 6, ...) and even message-type IDs
- **ODD_ROLE**: Assigns odd channel IDs (3, 5, 7, ...) and odd message-type IDs
- **Deterministic**: Both sides compute same roles (no negotiation needed)
- **Conflict-free**: Even/odd separation prevents ID collisions

**Notes**:
- **Uses operating values**: `#nextChannelId` initialized from `#operatingMinChannelId` (not `#minChannelId`)
- **Operating values calculated first**: Step 13.5 must complete before this step
- Transport ID collision is fatal (should never happen with proper generation)
- Role is permanent for lifetime of transport
- Used for all channel and message-type ID assignments

**Architectural Reference**: [`arch/scenarios/role-determination.md`](role-determination.md) - Detailed role determination logic

#### Step 15: Initialize Foundational Channels

**Actor**: Transport

**Action**: Set up TCC (channel 0) and C2C (channel 1) if enabled.

```javascript
// TCC (Transport-Control Channel) - always present, bidirectional
this.#channels.set(0, new Channel({
	id: 0,
	name: XP_CTRL_CHANNEL, // private symbol
	transport: this,
	// ... other config
}));

// C2C (Console-Content Channel) - if enabled, bidirectional
if (this.#remoteConfig.c2cEnabled && this.#localConfig.c2cEnabled) {
	this.#channels.set(1, new Channel({
		id: 1,
		name: LOG_CHANNEL, // "revocable" symbol
		transport: this,
		// ... other config
	}));
	this.#c2cEnabled = true;
}
```

**State Changes**:
- Transport: `#channels` map populated with TCC (and C2C if enabled) symbols (no user lookup-by-name)
- Channels ready for use

**Notes**:
- TCC is always present (channel 0)
- C2C only if both sides enable it (channel 1)
- All channels are always bidirectional
- No channel request/accept needed (foundational channels)

## Postconditions

- Handshake successfully exchanged in both directions
- Transport role determined (EVEN_ROLE or ODD_ROLE)
- Remote configuration stored
- Foundational channels initialized (TCC, optionally C2C)
- Binary message stream active (ready for ACK/control/data messages)
- Transport state: `started` (ready for channel requests and data transfer)

## Error Conditions

### 1. Invalid Transport Identifier

**Cause**: Remote sends non-PolyTransport identifier

**Detection**: Protocol.decodeHandshake() throws error

**Handling**:
```javascript
try {
	const result = Protocol.decodeHandshake(this.#inputBuffer);
} catch (err) {
	this.#logger.error('Invalid transport identifier:', err.message);
	await this.stop({ discard: true });
	throw err;
}
```

**Recovery**: None (fatal error, close connection)

### 2. Unsupported Protocol Version

**Cause**: Remote uses different protocol version

**Detection**: Version field mismatch

**Handling**:
```javascript
if (config.version !== 1) {
	this.#logger.error(`Unsupported protocol version: ${config.version}`);
	await this.stop({ discard: true });
	throw new Error(`Unsupported protocol version: ${config.version}`);
}
```

**Recovery**: None (fatal error, close connection)

**Future**: Version negotiation may be added in later protocol versions

### 3. Missing or Invalid Transport ID

**Cause**: Remote config missing transportId or transportId is invalid

**Detection**: transportId field missing or not a string

**Handling**:
```javascript
if (!config.transportId || typeof config.transportId !== 'string') {
	this.#logger.error('Remote transport transportId missing or invalid');
	await this.stop({ discard: true });
	throw new Error('Remote transport transportId missing or invalid');
}
```

**Recovery**: None (fatal error, close connection)

### 4. Transport ID Collision

**Cause**: Both transports have same transportId (self-connection or duplicate)

**Detection**: Transport ID comparison returns 0

**Handling**:
```javascript
if (this.#transportId === this.#remoteTransportId) {
	// The universe is officially ending
	this.#logger.error('Transport ID collision detected');
	await this.stop({ discard: true });
	throw new Error('Transport ID collision detected');
}
```

**Recovery**: None (fatal error, close connection)

**Notes**: Should never happen with proper transport ID generation (crypto.randomUUID())

### 5. Incomplete Handshake

**Cause**: Connection closed before handshake complete

**Detection**: Protocol.decodeHandshake() returns null, then connection closes

**Handling**:
```javascript
// In read loop
const result = Protocol.decodeHandshake(this.#inputBuffer);
if (result === null) {
	// Need more data - continue reading
	// If connection closes before complete handshake:
	this.#logger.error('Connection closed during handshake');
	await this.stop({ discard: true });
	throw new Error('Incomplete handshake');
}
```

**Recovery**: None (fatal error, connection already closed)

### 6. Handshake Timeout

**Cause**: Remote doesn't send handshake within timeout period

**Detection**: Timeout timer expires before handshake received

**Handling**:
```javascript
// Set timeout during start()
const timeoutId = setTimeout(() => {
	if (!this.#handshakeComplete) {
		this.#logger.error('Handshake timeout');
		this.stop({ discard: true });
	}
}, this.#handshakeTimeout || 5000);

// Clear timeout after handshake
clearTimeout(timeoutId);
```

**Recovery**: None (fatal error, close connection)

## Related Scenarios

- **[`transport-initialization.md`](transport-initialization.md)** - Complete transport startup sequence (includes handshake as step 7)
- **[`role-determination.md`](role-determination.md)** - Detailed role determination logic
- **[`channel-request.md`](channel-request.md)** - First operation after handshake (requesting channels)
- **[`message-encoding.md`](message-encoding.md)** - Encoding messages after handshake complete
- **[`message-decoding.md`](message-decoding.md)** - Decoding messages after handshake complete

## Implementation Notes

### 1. Handshake is Synchronous Blocking Operation

The handshake must complete before any other operations:
- No channel requests until handshake done
- No data messages until handshake done
- No ACK messages until handshake done

**Rationale**: Role determination required for ID assignment

### 2. Transport ID Generation

Use cryptographically secure transport ID generation:
```javascript
// Browser/Deno
const transportId = crypto.randomUUID();

// Node.js (if crypto.randomUUID not available)
const { randomUUID } = require('crypto');
const transportId = randomUUID();
```

**Rationale**: Prevents transport ID collisions

### 3. Handshake Size Estimation

Conservative estimate for ring buffer reservation:
```javascript
const configJson = JSON.stringify(config);
const handshakeSize = 15 + 2 + configJson.length + 2 + 1;
```

**Rationale**: Avoids multiple reservations, shrink releases unused space

### 4. Incremental Handshake Decoding

Handle fragmented handshake arrival:
```javascript
// Loop until handshake complete
while (!handshakeComplete) {
	const buffer = new Uint8Array(1024);
	const bytesRead = await connection.read(buffer);
	this.#inputBuffer.append(buffer.subarray(0, bytesRead));
	
	const result = Protocol.decodeHandshake(this.#inputBuffer);
	
	if (result !== null) {
		// Handshake complete
		const { config, bytesConsumed } = result;
		// ... process config ...
		
		// Release consumed bytes
		this.#inputBuffer.release(bytesConsumed);
		break;
	}
}
```

**Rationale**: Handshake may arrive in multiple TCP packets

### 5. Role Determination is Deterministic

Both sides compute the same roles independently:
- No negotiation needed
- No race conditions
- No additional messages

**Rationale**: Simplifies protocol, reduces latency

### 6. Foundational Channels (TCC, C2C)

TCC and C2C are special:
- No channel request/accept needed
- Always bidirectional
- IDs reserved (0 and 1)
- Initialized during handshake

**Rationale**: Required for transport operation (TCC) and console logging (C2C)

### 7. Worker Transport Handshake

Worker transport uses object format (not binary):
```javascript
// Send handshake as object
worker.postMessage({
	type: 'handshake',
	config: { transportId, version, c2cEnabled, ... }
});

// Receive handshake as object
worker.onmessage = (event) => {
	if (event.data.type === 'handshake') {
		const { config } = event.data;
		// ... process config ...
	}
};
```

**Rationale**: Worker transport uses structured clone, not binary stream

### 8. Nested Transport Handshake

Nested transport (PTOC) skips transport identifier:
```
\x02{"transportId":"...","version":1}\x03  (config only)
\x01                                       (binary stream marker)
```

**Rationale**: Already inside PolyTransport, identifier redundant

### 9. Handshake Logging

Log handshake details for debugging:
```javascript
this.#logger.debug('Handshake sent:', {
	transportId: this.#transportId,
	version: config.version,
	c2cEnabled: config.c2cEnabled
});

this.#logger.debug('Handshake received:', {
	remoteTransportId: this.#remoteTransportId,
	remoteVersion: config.version,
	role: this.#role === Transport.EVEN_ROLE ? 'EVEN' : 'ODD'
});
```

**Rationale**: Aids troubleshooting connection issues

### 10. Security Considerations

- **Transport ID collision**: Should never happen with proper generation
- **Version mismatch**: Reject incompatible versions (prevent protocol confusion)
- **Malformed handshake**: Validate all fields (prevent injection attacks)
- **Handshake timeout**: Prevent resource exhaustion (close stalled connections)

**Rationale**: Handshake is first point of contact with potentially untrusted remote

### 11. ACK-Class Message Handling

Handshake is an ACK-class message:
- Fire-and-forget (no ACK-on-ACK)
- Uses ring buffer space only (no transport budget)
- Ring space freed immediately after send
- `exact: true` parameter bypasses `RESERVE_ACK_BYTES` requirement

**Rationale**: Handshake must not consume transport budget (no way to restore it)

**Architectural Reference**: [`arch/scenarios/ack-generation-processing.md`](ack-generation-processing.md) - ACK messages use ring buffer only

### 12. VirtualRWBuffer for Input Accumulation

Input uses VirtualRWBuffer for accumulation:
- Append incoming data from reader-allocated buffers
- Zero-copy decoding via DataView interface
- Release consumed bytes after processing
- No pinning or migration complexity

**Rationale**: Simplified architecture (Update 2026-01-07-B)

**Architectural Reference**: [`arch/transport-input-processing.md`](../transport-input-processing.md) - VirtualRWBuffer for input accumulation
