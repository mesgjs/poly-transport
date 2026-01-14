# Message-Type Registration Scenario

**Status**: 📋 Complete (2026-01-13)

## Overview

This scenario documents how channels register named message types for bidirectional communication. Message types allow filtering and routing of messages within a channel. Registration follows a request/response pattern similar to channel requests, with the accepting side assigning numeric IDs.

**Key Points**:
- Message types are registered per channel (not transport-wide)
- Registration uses request/response protocol (like channel requests)
- Accepting side assigns message-type ID (even or odd based on role)
- Results apply to bidirectional channel (both sides can use registered types)
- Batch registration supported (multiple types in one request)
- Simultaneous registration from both sides creates ID jitter (automatically settles)
- Message types cleared when channel reaches `closed` state
- Fresh registrations when channel reopens

## Architectural Context

**Key Design Points** (from [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)):
- All channels are bidirectional
- Message-type registration uses in-channel control messages (not TCC)
- Control messages sent as channel data messages (type 2 headers)
- Message-type IDs assigned by accepting side (even or odd based on role)
- EVEN_ROLE assigns even message-type IDs
- ODD_ROLE assigns odd message-type IDs
- Message-type IDs stored in two-element array: `[]` → `[id]` → `[id1, id2]`
- First (lowest) ID used for sending (like channels)
- Message types stored in channel's Map indexed by name and ID
- Pre-loaded TCC message types: `chanReq` (1), `chanResp` (2), `chanClose` (3), `chanClosed` (4), `mesgTypeReq` (5), `mesgTypeResp` (6)

## Preconditions

- Transport is started ([`transport-initialization.md`](transport-initialization.md))
- Transport role determined (EVEN_ROLE or ODD_ROLE)
- Channel is open ([`channel-request.md`](channel-request.md), [`channel-acceptance.md`](channel-acceptance.md))
- Channel not in closing state
- TCC has pre-loaded message types: `mesgTypeReq` (5), `mesgTypeResp` (6)

## Actors

- **Requesting Channel**: Initiates message-type registration
- **Accepting Channel**: Receives request, assigns message-type ID
- **Protocol Module**: Encodes/decodes control messages
- **ChannelFlowControl**: Manages channel sending and receiving budgets

## Step-by-Step Sequence

### 1. Application Requests Message-Type Registration

**Actor**: Application code

**Trigger**: Application calls `channel.addMessageType(name)` or `channel.addMessageTypes([names])`

**Action**:
```javascript
// Single type
const typeId = await channel.addMessageType('userMessage');

// Batch registration
const typeIds = await channel.addMessageTypes(['userMessage', 'systemAlert', 'statusUpdate']);
```

**State Changes**:
- Registration request initiated
- Promise created (will resolve when response received)

---

### 2. Check Channel State

**Actor**: [`Channel`](../../src/channel.esm.js)

**Action**: Validate channel can register message types:

```javascript
if (channel.state === 'closing' || channel.state === 'localClosing' || channel.state === 'remoteClosing') {
  throw new ChannelStateError('Cannot register message types on closing channel');
}

if (channel.state === 'closed') {
  throw new ChannelStateError('Cannot register message types on closed channel');
}
```

**State Changes**:
- Validation complete (or exception thrown)

---

### 3. Check for Existing Registrations

**Actor**: [`Channel`](../../src/channel.esm.js)

**Action**: Check if message types already registered:

```javascript
const newTypes = [];
const existingIds = [];

for (const name of names) {
  const existing = #messageTypes.get(name);
  if (existing && existing.ids.length > 0) {
    // Already registered, return existing ID
    existingIds.push({ name, id: existing.ids[0] });
  } else {
    // New registration needed
    newTypes.push(name);
  }
}

if (newTypes.length === 0) {
  // All types already registered, resolve immediately
  return existingIds.map(e => e.id);
}
```

**State Changes**:
- Existing registrations identified
- New registrations identified

---

### 4. Create Pending Registration Records

**Actor**: [`Channel`](../../src/channel.esm.js)

**Action**: Track pending registration for each new type:

```javascript
// Create individual pending records for each type
for (const name of newTypes) {
  const pendingReg = {
    name,
    promises: [{ resolve, reject, timeout }],  // Array to support multiple concurrent requests
  };
  
  #pendingMessageTypeRegs.set(name, pendingReg);
}
```

**Note**: Individual pending records per type allow overlapping requests to be handled cleanly. Like channel requests, timeout rejects the promise but doesn't remove the pending record. The response will still be processed when it arrives.

**State Changes**:
- Pending registration tracked for each type
- Timeout timers started

---

### 5. Encode Registration Request

**Actor**: [`Protocol`](../../src/protocol.esm.js)

**Action**: Create channel control message with `mesgTypeReq` message-type:

**Request Format** (JSON body):
```json
{
  "types": ["userMessage", "systemAlert", "statusUpdate"]
}
```

**Header Encoding**:
- Header type: 1 (channel control)
- Channel ID: Channel's ID (for sending, using `ids[0]`)
- Sequence number: Next channel send sequence
- Message type: 5 (`mesgTypeReq` from TCC's pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded request body

**State Changes**:
- Channel send sequence incremented
- Message encoded into output ring buffer

---

### 6. Check Channel Sending Budget and Send

**Actor**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js) (channel instance) and Channel

**Action**: Verify sufficient budget and send:

```javascript
const chunkBytes = headerBytes + dataBytes;
if (!channelSendFlow.canSend(chunkBytes)) {
  await channelSendFlow.waitForBudget(chunkBytes);
}
// Need to get buffer reservation and encode into it
const seq = channelSendFlow.recordSent(chunkBytes);
await transport._sendMessage(channelId, messageBuffer);
```

**State Changes**:
- Chunk recorded in channel `ChannelFlowControl` in-flight map
- Channel sending budget reduced by `chunkBytes`
- Message sent to remote transport

---

### 7. Receive Registration Request (Remote Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (remote)

**Trigger**: Channel control message received with message-type `mesgTypeReq` (5)

**Action**:
1. Decode message header and body
2. Extract message-type names
3. Validate message format

**State Changes**:
- Request parameters extracted
- Ready to process registration

---

### 8. Assign Message-Type IDs (Remote Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (remote)

**Action**: Assign or reuse message-type IDs:

```javascript
const assignments = [];

for (const name of request.types) {
  let typeId;
  const existing = #messageTypes.get(name);
  
  if (existing && existing.ids.length > 0) {
    // Reuse existing ID (first one in array)
    typeId = existing.ids[0];
  } else {
    // Assign new ID (even or odd based on role)
    typeId = #nextMessageTypeId;
    #nextMessageTypeId += 2;
    
    // Create or update message-type record
    if (existing) {
      existing.ids = [typeId];
    } else {
      #messageTypes.set(name, {
        name,
        ids: [typeId]
      });
    }
    // Create reverse mapping (ID → same record object)
    #messageTypes.set(typeId, #messageTypes.get(name));
  }
  
  assignments.push({ name, id: typeId });
}
```

**State Changes**:
- Message-type IDs assigned (new or reused)
- Message-type records created/updated in channel's Map
- Reverse mapping (ID → record) created
- Next ID counter incremented (if new IDs assigned)

---

### 9. Encode Registration Response (Remote Side)

**Actor**: [`Protocol`](../../src/protocol.esm.js) (remote)

**Action**: Create channel control message with `mesgTypeResp` message-type:

**Response Format** (JSON body):
```json
{
  "accept": [
    { "name": "userMessage", "id": 1024 },
    { "name": "systemAlert", "id": 1026 },
    { "name": "statusUpdate", "id": 1028 }
  ],
  "reject": [
    { "name": "prohibited", "reason": "not allowed" }
  ]
}
```

**Header Encoding**:
- Header type: 1 (channel control)
- Channel ID: Channel's ID (for sending, using `ids[0]`)
- Sequence number: Next channel send sequence
- Message type: 6 (`mesgTypeResp` from TCC's pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded response body

**State Changes**:
- Channel send sequence incremented
- Message encoded into output ring buffer

---

### 10. Check Channel Sending Budget and Send Response (Remote Side)

**Actor**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js) (channel instance, remote) and Channel

**Action**: Same as step 6 (verify budget and send)

**State Changes**:
- Chunk recorded in channel `ChannelFlowControl` in-flight map
- Channel sending budget reduced by `chunkBytes`
- Message sent to requesting transport

---

### 11. Receive Registration Response (Requesting Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (requesting)

**Trigger**: Channel control message chunk(s) received with message-type `mesgTypeResp` (6)

**Action**:
1. Assemble and decode message header and body
2. Extract message-type assignments
3. Match to pending registration

**State Changes**:
- Response parameters extracted
- Ready to complete registration

---

### 12. Update Local Message-Type Records (Requesting Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (requesting)

**Action**: Store assigned message-type IDs:

```javascript
for (const assignment of response.assignments) {
  const existing = #messageTypes.get(assignment.name);
  
  if (existing) {
    // Add ID to existing record (may create jitter)
    if (!Transport.addRoleId(assignment.id, existing.ids)) {
      throw new ProtocolViolationError(...);
    }
  } else {
    // Create new record
    #messageTypes.set(assignment.name, {
      name: assignment.name,
      ids: [assignment.id]
    });
  }
  
  // Create reverse mapping (ID → same record object)
  #messageTypes.set(assignment.id, #messageTypes.get(assignment.name));
}
```

**State Changes**:
- Message-type records created/updated in channel's Map
- IDs stored in sorted array (lowest first)
- Reverse mapping (ID → record) created

---

### 13. Resolve Pending Registrations (Requesting Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (requesting)

**Action**: Complete registration for each type:

```javascript
for (const assignment of response.assignments) {
  const pendingReg = #pendingMessageTypeRegs.get(assignment.name);
  if (pendingReg) {
    clearTimeout(pendingReg.timeout);
    
    // Resolve all promises waiting for this type
    for (const { resolve } of pendingReg.promises) {
      resolve(assignment.id);
    }
    
    #pendingMessageTypeRegs.delete(assignment.name);
  }
}
```

**State Changes**:
- Timeout timers cleared for each type
- All waiting promises resolved with assigned IDs
- Pending registrations removed

---

## Postconditions

**Successful Registration**:
- Message-type records exist on both sides
- Requesting side has IDs for sending
- Accepting side has IDs for receiving
- Both sides can use message types for filtering
- Promises resolved with assigned IDs

**Failed Registration** (timeout):
- Promises rejected with `TimeoutError`
- Pending registration remains (response may still arrive)
- Application can retry or handle error

## Error Conditions

### Channel Not Open
- **Trigger**: Registration attempted on closing or closed channel
- **Handling**: Throw `ChannelStateError`
- **Recovery**: Wait for channel to reopen, then retry

### Registration Timeout
- **Trigger**: No response received within timeout period
- **Handling**: Reject promise with `TimeoutError`
- **Recovery**: Application can retry registration

### Invalid Request Format
- **Trigger**: Malformed JSON or missing required fields
- **Handling**: Remote side ignores request (no response)
- **Recovery**: Requesting side times out, can retry

### Insufficient Channel Budget
- **Trigger**: Channel sending budget exhausted
- **Handling**: Wait for ACKs to restore budget (async)
- **Recovery**: Automatic (waits for budget)

### Duplicate Registration
- **Trigger**: Message type already registered
- **Handling**: Return existing ID (idempotent)
- **Recovery**: No error, operation succeeds

### Message-Type ID Exhaustion
- **Trigger**: All IDs in range exhausted (unlikely with 16-bit IDs)
- **Handling**: Implementation-defined (could reject or wrap)
- **Recovery**: Application-level management

## Related Scenarios

- **Prerequisites**:
  - [`transport-initialization.md`](transport-initialization.md) - Transport must be started
  - [`channel-request.md`](channel-request.md) - Channel must be open
  - [`channel-acceptance.md`](channel-acceptance.md) - Channel must be accepted

- **Similar Pattern**:
  - [`channel-acceptance.md`](channel-acceptance.md) - Similar request/response pattern

- **Follow-up**:
  - [`simple-write.md`](simple-write.md) - Using registered message types
  - [`simple-read.md`](simple-read.md) - Filtering by message type

- **Related**:
  - [`channel-closure.md`](channel-closure.md) - Message types cleared at close
  - [`send-flow-control.md`](send-flow-control.md) - Channel budget management

## Implementation Notes

### Message-Type ID Assignment Strategy

**Reuse Existing ID** (type already registered):
- Check if message-type name already has an ID
- If yes: return first ID in array
- **No new ID assigned**
- Provides idempotent registration

**Assign New ID** (type not registered):
- EVEN_ROLE: next even ID (1024, 1026, 1028, ...)
- ODD_ROLE: next odd ID (1025, 1027, 1029, ...)
- Starting point: `minMessageTypeId` from handshake (default 1024)
- Increment by 2 after each assignment

**ID Storage**:
```javascript
#nextMessageTypeId = 1024;  // Actual value based on handshake and role
```

### Batch Registration

**Benefits**:
- Reduces round-trips (one request for multiple types)
- Reduces control message overhead
- Atomic registration (all or none)

**Request Format**:
```json
{
  "types": ["type1", "type2", "type3"]
}
```

**Response Format**:
```json
{
  "accept": [
    { "name": "type1", "id": 1024 },
    { "name": "type2", "id": 1026 },
    { "name": "type3", "id": 1028 }
  ],
  "reject": [
    { "name": "type4", "reason": "unacceptable" }
  ]
}
```

### Simultaneous Registration (With ID Jitter)

**Scenario**: Both sides register same message type simultaneously
Side A: Even role\
Side B: Odd role

1. Side A sends `mesgTypeReq` for "userMessage"
2. Side B sends `mesgTypeReq` for "userMessage"
3. Side B receives A's request
4. Side B has no IDs and assigns ID 725 (odd), which it saves (`[725]`) and sends in a `mesgTypeResp`-with-accept reply to A
5. Side B wakes any waiters, which can now send with ID 725, as the accept is ahead of any data depending upon it in the output ring and guaranteed to arrive first
6. Side A receives B's request
7. Side A has not received B's accept yet (so no A-side IDs yet), and assigns ID 1024 (even), which it saves (`[1024]`) and sends in a `mesgTypeResp`-with-accept reply to B
8. Side A wakes any waiters, which can now send with ID 1024, as the accept is guaranteed to arrive first
9. Side A receives B's accept and adds odd ID 725 (inserting, because it's smaller): `[725, 1024]`
10. Side B receives A's accept and adds even ID 1024 (appending, because it's larger): `[725, 1024]`


**Result**: By the time both request round-trips have completed, both sides have `[725, 1024]`. Both will settle (automatically) on 725 (lowest) for sending, but will also recognize and accept 1024.

See [`id-jitter-settlement.md`](id-jitter-settlement.md) for detailed analysis (same pattern as channels).

### Message-Type Lifecycle

**Registration**:
- Message types registered when needed
- Batch registration supported
- Idempotent (can re-register existing types)

**Usage**:
- Sender uses first (lowest) ID from array (like channels)
- Receiver matches incoming ID to message-type record
- Filtering by message type in `read({ only })` operations
- Both sides of bidirectional channel can use registered types

**Clearing**:
- Message types cleared when channel reaches `closed` state
- Not cleared during `closing`/`localClosing`/`remoteClosing` (may still need them)
- Fresh registrations when channel reopens

**Persistence**:
- Message types stored in channel's message-type Map (indexed by name and ID)
- Message types are per-channel (not transport-wide)
- Different channels can have different message-type mappings
- Same name can have different IDs (for channel data messages) on different channels
- Channel control messages share TCC's (data) message-type mapping and are therefore the same across all channels

### Pre-Loaded Channel Message Types

**Standard TCC / XP_CTRL_CHANNEL / Channel 0 Message Types**:

The TCC message-type mapping is used (shared) by all channels for control messages, in addition to control and data messages on the TCC itself.

These types are pre-loaded only on the TCC. They are not user-visible (channel control messages are handled by the transport, not the user).

(Note: These vary from the original requirements)

- `tranStop` (0) - Transport shutdown (TCC data type)
- `chanReq` (1) - Channel request (TCC data type)
- `chanResp` (2) - Channel response (TCC data type)
- `chanClose` (3) - Channel close initiation (control type)
- `chanClosed` (4) - Channel close completion (control type)
- `mesgTypeReq` (5) - Message-type registration request (control type)
- `mesgTypeResp` (6) - Message-type registration response (control type)

Additional, foundational (i.e. non-negotiated, required-in-advance) types may be added as required. The TCC's next-message-type id-counter should begin at 1024. Non-foundational types can be added via normal registration (by the transport, since there's no user access).

**Usage**:
```javascript
// TCC types pre-loaded (no registration needed)
#messageTypes.set('mesgTypeReq', { name: 'mesgTypeReq', ids: [5] });
#messageTypes.set(5, #messageTypes.get('mesgTypeReq'));
#messageTypes.set('mesgTypeResp', { name: 'mesgTypeResp', ids: [6] });
#messageTypes.set(6, #messageTypes.get('mesgTypeResp'));
// ... etc for other control types
```

***Standard C2C / LOG_CHANNEL / Channel 1 Message Types**

These types are pre-registered (on both side) for the C2C.

(Note: These may vary from the original requirements)

- `except` (0) - uncaught exceptions
- `trace` (1) - detailed execution tracing information
- `debug` (2) - debugging information
- `info` (3) - general/miscellaneous information and logging
- `warn` (4) - warnings/non-fatal errors
- `error` (5) - errors (i.e. fatal)

Additional, foundational (i.e. non-negotiated, required-in-advance) types may be added as required. The C2C's next-message-type id-counter should begin at 1024. Non-foundational types can be added via normal registration.

Note: The JSMAWS Responder will expect to use the `newMessageType` event's `event.preventDefault()` to reject custom registrations on applets' C2C.

### Pending Registration Management

**Individual Pending Records**:
- Each message type has its own pending record
- Allows overlapping requests to be handled cleanly
- Multiple calls to `addMessageType()` for same type join same pending record
- All promises for that type resolved when response received

**Timeout Handling**:
- Timeout rejects individual promise for that type
- Pending registration remains (response may still arrive)
- Late response still processed (resolves any remaining promises)
- Other types in batch request unaffected by one type's timeout

**Example**:
```javascript
// Two concurrent requests for same type
const promise1 = channel.addMessageType('userMessage');
const promise2 = channel.addMessageType('userMessage');

// Both join same pending record
// Both promises resolve when response received

// Overlapping batch requests
const batch1 = channel.addMessageTypes(['type1', 'type2', 'type3']);
const batch2 = channel.addMessageTypes(['type2', 'type3', 'type4']);

// type2 and type3 join existing pending records
// type1 and type4 create new pending records
// All promises resolve when responses received
```

### Security Considerations

**Untrusted Channels**:
- Validate message-type names (length, characters)
- Enforce maximum number of message types per channel
- Reject excessive registration requests (DoS prevention)

**Malicious Requests**:
- Many rapid registrations (DoS attempt)
- Extremely long message-type names (memory exhaustion)
- Invalid message-type names (injection attempts)

**Resource Limits**:
- Maximum message types per channel (e.g., 1000)
- Maximum message-type name length (e.g., 256 bytes)
- Rate limiting for registration requests

### Performance Considerations

**Batch Registration**:
- Reduces round-trips (one request for multiple types)
- More efficient than individual registrations
- Recommended for applications with many message types

**ID Assignment**:
- Simple counter increment (O(1))
- No ID collision detection needed (even/odd separation)
- Reuse existing IDs when possible

**Message-Type Lookup**:
- Bidirectional map (name → record, ID → record)
- O(1) lookup by name or ID
- Efficient for filtering operations

**Idempotent Registration**:
- Re-registering existing type returns existing ID
- No error or special handling needed
- Simplifies application logic

### Testing Considerations

**Unit Tests**:
- Test single message-type registration
- Test batch registration
- Test duplicate registration (idempotent)
- Test simultaneous registration (ID jitter)
- Test registration timeout
- Test channel not open (error)
- Test invalid request format
- Test ID assignment (even/odd based on role)
- Test ID reuse (existing type)
- Test message-type clearing at close
- Test fresh registrations after reopen

**Integration Tests**:
- Test with real channel implementations
- Test resource limit enforcement
- Test malicious registration patterns
- Test concurrent registrations
- Test message-type usage in write/read operations
- Test filtering by message type

### Example Usage

**Simple Registration**:
```javascript
// Register single message type
const typeId = await channel.addMessageType('userMessage');

// Use in write operation
await channel.write('userMessage', data, { eom: true });

// Filter in read operation
const chunk = await channel.read({ only: 'userMessage' });
```

**Batch Registration**:
```javascript
// Register multiple message types at once
const typeIds = await channel.addMessageTypes([
  'userMessage',
  'systemAlert',
  'statusUpdate'
]);

// Use in write operations
await channel.write('userMessage', userData, { eom: true });
await channel.write('systemAlert', alertData, { eom: true });

// Filter in read operation
const chunk = await channel.read({ only: ['userMessage', 'systemAlert'] });
```

**Error Handling**:
```javascript
try {
  const typeId = await channel.addMessageType('userMessage');
} catch (err) {
  if (err instanceof TimeoutError) {
    // Registration timed out, retry
    console.error('Registration timeout, retrying...');
    const typeId = await channel.addMessageType('userMessage');
  } else if (err instanceof ChannelStateError) {
    // Channel not open, wait and retry
    console.error('Channel not open, waiting...');
    await channel.waitForOpen();
    const typeId = await channel.addMessageType('userMessage');
  } else {
    throw err;
  }
}
```

FEEDBACK:
- "Registration is directional" is confusing. The protocol is directional, but the results apply to the (bidirectional) channel.
- Message-type mapping uses in-channel, channel control messages.
- Use a Map indexed by ids and name with value object containing name and ids (like channels map).
- Store it in the associated channel object.
- Send with id[0], just like channels.
- No need to design two different systems.
- Different requests could have overlapping types. I think it will be cleaner just to create pendingReg for individual types (as many as needed for the types in the request).
