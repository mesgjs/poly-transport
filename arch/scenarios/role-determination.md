# Transport Role Determination Scenario

## Overview

This scenario describes how two PolyTransport instances determine their roles (EVEN_ROLE vs ODD_ROLE) during the handshake process. Role determination is critical for preventing ID collisions when both transports simultaneously request channels or register message types.

## Preconditions

- Both transports have generated unique UUIDs via `crypto.randomUUID()`
- Handshake exchange is in progress
- Both transports have received each other's configuration (including `transportId`)

## Architectural Context

**Requirements Reference**: [`arch/bidi-chan-even-odd-update.md:31-33`](../bidi-chan-even-odd-update.md:31)

The bidirectional channel model requires that each transport assign itself a role based on UUID comparison:
- **EVEN_ROLE** (0): Assigns even IDs (0, 2, 4, 6, ...)
- **ODD_ROLE** (1): Assigns odd IDs (1, 3, 5, 7, ...)

This prevents ID collisions when both transports simultaneously request the same named resource.

## Actors

- **Transport A**: Local transport instance
- **Transport B**: Remote transport instance
- **Protocol Layer** ([`src/protocol.esm.js`](../../src/protocol.esm.js)): Handshake encoding/decoding

## Step-by-Step Sequence

### 1. Generate Local Transport UUID

**Action**: Generate unique identifier for local transport  
**Responsible**: Transport A  
**Timing**: During construction or `_start()`

```javascript
// In Transport constructor or _start()
this.#transportId = crypto.randomUUID();
// Example: "a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c"
```

**State Changes**:
- `#transportId` set to UUID string

**Important**: UUID generation uses `crypto.randomUUID()` which provides cryptographically strong random values, making collisions astronomically unlikely.

### 2. Exchange Transport IDs in Handshake

**Action**: Include `transportId` in handshake configuration  
**Responsible**: Both transports  
**Code Location**: [`protocol.encodeHandshakeInto()`](../../src/protocol.esm.js:388)

**Transport A sends**:
```javascript
{
  transportId: "a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c",
  c2cEnabled: false,
  minChannelId: 2,
  minMessageTypeId: 0,
  version: 1
}
```

**Transport B sends**:
```javascript
{
  transportId: "f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c",
  c2cEnabled: false,
  minChannelId: 2,
  minMessageTypeId: 0,
  version: 1
}
```

### 3. Receive Remote Transport ID

**Action**: Decode remote handshake and extract `transportId`  
**Responsible**: Both transports  
**Code Location**: [`protocol.decodeHandshake()`](../../src/protocol.esm.js:432)

```javascript
// Read and decode remote handshake
const buffer = this.bufferPool.acquire(1024);
const bytesRead = await this.readFromStream(buffer);
const vb = new VirtualBuffer(buffer, 0, bytesRead);
const remoteConfig = protocol.decodeHandshake(vb, 0);

// Extract remote transport ID
const remoteTransportId = remoteConfig.transportId;
// Example: "f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c"

this.bufferPool.release(buffer);
```

**State Changes**:
- Remote configuration stored
- Remote transport ID available for comparison

### 4. Compare Transport IDs Lexicographically

**Action**: Determine role based on UUID comparison  
**Responsible**: Both transports  
**Requirements Reference**: [`arch/bidi-chan-even-odd-update.md:31-33`](../bidi-chan-even-odd-update.md:31)

```javascript
// Constants (defined in transport module)
const EVEN_ROLE = 0;
const ODD_ROLE = 1;

// Lexicographic comparison
if (this.#transportId < remoteConfig.transportId) {
  // Local UUID is lower → EVEN_ROLE
  this.#transportRole = EVEN_ROLE;
  this.#nextChannelId = this.minChannelId;
  // Ensure even starting ID
  if (this.#nextChannelId % 2 !== 0) this.#nextChannelId++;
  
} else if (this.#transportId > remoteConfig.transportId) {
  // Local UUID is higher → ODD_ROLE
  this.#transportRole = ODD_ROLE;
  this.#nextChannelId = this.minChannelId;
  // Ensure odd starting ID
  if (this.#nextChannelId % 2 === 0) this.#nextChannelId++;
  
} else {
  // UUIDs are identical (astronomically unlikely)
  throw new Error('Transport IDs must be unique (both sides generated same UUID)');
}
```

**State Changes**:
- `#transportRole` set to `EVEN_ROLE` (0) or `ODD_ROLE` (1)
- `#nextChannelId` initialized to first even/odd ID >= `minChannelId`
- `#nextMessageTypeId` will be initialized per-channel (not set here)

### 5. Example: Transport A Becomes EVEN_ROLE

**Scenario**: Transport A has lower UUID

**Transport A**:
- Local UUID: `"a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c"`
- Remote UUID: `"f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c"`
- Comparison: `"a3f2..." < "f7e6..."` → **EVEN_ROLE**
- Next channel ID: 2 (even)
- Will assign: 2, 4, 6, 8, ...

**Transport B**:
- Local UUID: `"f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c"`
- Remote UUID: `"a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c"`
- Comparison: `"f7e6..." > "a3f2..."` → **ODD_ROLE**
- Next channel ID: 3 (odd)
- Will assign: 3, 5, 7, 9, ...

### 6. Example: Transport B Becomes EVEN_ROLE

**Scenario**: Transport B has lower UUID

**Transport A**:
- Local UUID: `"f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c"`
- Remote UUID: `"a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c"`
- Comparison: `"f7e6..." > "a3f2..."` → **ODD_ROLE**
- Next channel ID: 3 (odd)
- Will assign: 3, 5, 7, 9, ...

**Transport B**:
- Local UUID: `"a3f2e1d0-c4b5-4a6e-8f7d-9c8b7a6e5d4c"`
- Remote UUID: `"f7e6d5c4-b3a2-4918-8e7d-6c5b4a3e2d1c"`
- Comparison: `"a3f2..." < "f7e6..."` → **EVEN_ROLE**
- Next channel ID: 2 (even)
- Will assign: 2, 4, 6, 8, ...

## Postconditions

- Both transports have determined their roles (EVEN_ROLE or ODD_ROLE)
- Both transports have initialized `#nextChannelId` to first even/odd ID >= `minChannelId`
- Roles are complementary (one EVEN_ROLE, one ODD_ROLE)
- ID assignment will never collide (even vs odd)
- Both transports can now safely request channels and register message types

## Error Conditions

### UUID Collision
- **Condition**: Both transports generated identical UUIDs
- **Probability**: ~1 in 2^122 (astronomically unlikely)
- **Error**: `Error('Transport IDs must be unique (both sides generated same UUID)')`
- **Recovery**: Regenerate UUID and retry handshake

### Missing Transport ID
- **Condition**: Remote handshake doesn't include `transportId` field
- **Error**: `Error('Remote handshake missing transportId')`
- **Recovery**: Reject handshake, close connection

### Invalid Transport ID Format
- **Condition**: `transportId` is not a valid UUID string
- **Error**: `Error('Invalid transportId format')`
- **Recovery**: Reject handshake, close connection

## Related Scenarios

- [`transport-initialization.md`](transport-initialization.md) - Complete initialization sequence
- [`id-jitter-settlement.md`](id-jitter-settlement.md) - How IDs settle during simultaneous requests
- [`channel-request.md`](channel-request.md) - Channel request using role-based IDs
- [`message-type-registration.md`](message-type-registration.md) - Message-type registration using role-based IDs

## Implementation Notes

### Key Design Decisions

1. **Lexicographic Comparison**: Uses standard string comparison (`<`, `>`) for UUID comparison, which is deterministic and consistent across platforms.

2. **EVEN_ROLE Gets Lower UUID**: The transport with the lexicographically lower UUID gets EVEN_ROLE. This is arbitrary but consistent.

3. **Constants vs Strings**: `EVEN_ROLE` and `ODD_ROLE` are numeric constants (0 and 1), not strings, for efficient comparison and storage.

4. **Reserved IDs**: Channel IDs 0 (TCC) and 1 (C2C) are reserved and not affected by role-based assignment. **Users must use named channel requests** (never numeric IDs) to avoid collisions with transport-assigned IDs.

5. **Per-Channel Message-Type IDs**: Message-type ID assignment is per-channel, not transport-wide. Each channel maintains its own `#nextMessageTypeId` counter.

6. **No Role Renegotiation**: Once roles are determined during handshake, they remain fixed for the lifetime of the transport connection.

### Testing Considerations

- Test with various UUID pairs to ensure correct role assignment
- Test with identical UUIDs (mock `crypto.randomUUID()`) to verify error handling
- Test with missing or invalid `transportId` in handshake
- Test that roles are complementary (one EVEN, one ODD)
- Test that `#nextChannelId` is correctly initialized based on role
- Test that even/odd IDs are correctly assigned during channel requests

### Security Considerations

1. **UUID Randomness**: `crypto.randomUUID()` provides cryptographically strong random values, preventing predictable ID assignment.

2. **No Role Manipulation**: Roles are determined by UUID comparison, not by configuration or negotiation, preventing role manipulation attacks.

3. **Collision Detection**: Identical UUIDs are detected and rejected, preventing ambiguous role assignment.

### Performance Considerations

1. **Single Comparison**: Role determination requires only one lexicographic string comparison, which is O(n) where n is UUID length (36 characters).

2. **No Retries**: Role determination succeeds on first attempt (barring UUID collision), avoiding handshake delays.

3. **Cached Role**: Role is determined once during handshake and cached for the lifetime of the transport.
