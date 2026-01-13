# Message-Type Registration Scenario

**Status**: 📋 Complete (2026-01-13)

## Overview

This scenario documents how channels register named message types for bidirectional communication. Message types allow filtering and routing of messages within a channel. Registration follows a request/response pattern similar to channel requests, with the accepting side assigning numeric IDs.

**Key Points**:
- Message types are registered per channel (not transport-wide)
- Registration is directional (sender registers with receiver)
- Accepting side assigns message-type ID (even or odd based on role)
- Batch registration supported (multiple types in one request)
- Simultaneous registration from both sides creates ID jitter (automatically settles)
- Message types cleared when channel reaches `closed` state
- Fresh registrations when channel reopens

## Architectural Context

**Key Design Points** (from [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)):
- All channels are bidirectional
- Message-type registration uses TCC message-type mappings
- Control messages sent as channel data messages (type 2 headers)
- Message-type IDs assigned by accepting side (even or odd based on role)
- EVEN_ROLE assigns even message-type IDs
- ODD_ROLE assigns odd message-type IDs
- Message-type IDs stored in two-element array: `[]` → `[id]` → `[id1, id2]`
- First (lowest) ID used for sending
- Pre-loaded TCC message types: `chanReq` (1), `chanResp` (2), `chanClose` (3), `chanClosed` (4)

## Preconditions

- Transport is started ([`transport-initialization.md`](transport-initialization.md))
- Transport role determined (EVEN_ROLE or ODD_ROLE)
- Channel is open ([`channel-request.md`](channel-request.md), [`channel-acceptance.md`](channel-acceptance.md))
- Channel not in closing state
- TCC message-type mappings loaded (`mesgTypeReq` = 5, `mesgTypeResp` = 6)

## Actors

- **Requesting Channel**: Initiates message-type registration
- **Accepting Channel**: Receives request, assigns message-type ID
- **Protocol Module**: Encodes/decodes control messages
- **SendFlowControl**: Manages channel sending budget
- **ReceiveFlowControl**: Manages channel receiving budget

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

### 4. Create Pending Registration Record

**Actor**: [`Channel`](../../src/channel.esm.js)

**Action**: Track pending registration:

```javascript
const pendingReg = {
  names: newTypes,
  promises: [{ resolve, reject }],  // Array to support multiple concurrent requests
  timeout: setTimeout(() => {
    // Timeout doesn't remove pending record (response may still arrive)
    reject(new TimeoutError('Message-type registration timed out'));
  }, timeout)
};

#pendingMessageTypeRegs.set(requestKey, pendingReg);
```

**Note**: Like channel requests, timeout rejects the promise but doesn't remove the pending record. The response will still be processed when it arrives.

**State Changes**:
- Pending registration tracked
- Timeout timer started

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
- Message type: 2 (channel data)
- Channel ID: Channel's ID (for sending)
- Sequence number: Next channel send sequence
- Message-type ID: 5 (`mesgTypeReq` from TCC pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded request body

**State Changes**:
- Channel send sequence incremented
- Message encoded into output ring buffer

---

### 6. Check Channel Sending Budget and Send

**Actor**: [`SendFlowControl`](../../src/flow-control.esm.js) (channel instance) and Channel

**Action**: Verify sufficient budget and send:

```javascript
const chunkBytes = headerBytes + dataBytes;
if (!channelSendFlow.canSend(chunkBytes)) {
  await channelSendFlow.waitForCredit(chunkBytes);
}

const seq = channelSendFlow.recordSent(chunkBytes);
await transport._sendMessage(channelId, messageBuffer);
```

**State Changes**:
- Chunk recorded in channel `SendFlowControl` in-flight map
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
        ids: [typeId],
        direction: 'receive'  // We're receiving messages with this type
      });
    }
    #messageTypes.set(typeId, #messageTypes.get(name));
  }
  
  assignments.push({ name, id: typeId });
}
```

**State Changes**:
- Message-type IDs assigned (new or reused)
- Message-type records created/updated
- Next ID counter incremented (if new IDs assigned)

---

### 9. Encode Registration Response (Remote Side)

**Actor**: [`Protocol`](../../src/protocol.esm.js) (remote)

**Action**: Create channel control message with `mesgTypeResp` message-type:

**Response Format** (JSON body):
```json
{
  "assignments": [
    { "name": "userMessage", "id": 1024 },
    { "name": "systemAlert", "id": 1026 },
    { "name": "statusUpdate", "id": 1028 }
  ]
}
```

**Header Encoding**:
- Message type: 2 (channel data)
- Channel ID: Channel's ID (for sending)
- Sequence number: Next channel send sequence
- Message-type ID: 6 (`mesgTypeResp` from TCC pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded response body

**State Changes**:
- Channel send sequence incremented
- Message encoded into output ring buffer

---

### 10. Check Channel Sending Budget and Send Response (Remote Side)

**Actor**: [`SendFlowControl`](../../src/flow-control.esm.js) (channel instance, remote) and Channel

**Action**: Same as step 6 (verify budget and send)

**State Changes**:
- Chunk recorded in channel `SendFlowControl` in-flight map
- Channel sending budget reduced by `chunkBytes`
- Message sent to requesting transport

---

### 11. Receive Registration Response (Requesting Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (requesting)

**Trigger**: Channel control message received with message-type `mesgTypeResp` (6)

**Action**:
1. Decode message header and body
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
const typeIds = [];

for (const assignment of response.assignments) {
  const existing = #messageTypes.get(assignment.name);
  
  if (existing) {
    // Add ID to existing record (may create jitter)
    if (!existing.ids.includes(assignment.id)) {
      existing.ids.push(assignment.id);
      existing.ids.sort((a, b) => a - b);  // Keep sorted (lowest first)
    }
  } else {
    // Create new record
    #messageTypes.set(assignment.name, {
      name: assignment.name,
      ids: [assignment.id],
      direction: 'send'  // We're sending messages with this type
    });
  }
  
  #messageTypes.set(assignment.id, #messageTypes.get(assignment.name));
  typeIds.push(assignment.id);
}
```

**State Changes**:
- Message-type records created/updated
- IDs stored in sorted array (lowest first)
- Reverse mapping (ID → record) created

---

### 13. Resolve Pending Registration (Requesting Side)

**Actor**: [`Channel`](../../src/channel.esm.js) (requesting)

**Action**: Complete registration:

```javascript
const pendingReg = #pendingMessageTypeRegs.get(requestKey);
if (pendingReg) {
  clearTimeout(pendingReg.timeout);
  
  // Resolve all promises waiting for this registration
  for (const { resolve } of pendingReg.promises) {
    resolve(typeIds);
  }
  
  #pendingMessageTypeRegs.delete(requestKey);
}
```

**State Changes**:
- Timeout timer cleared
- All waiting promises resolved
- Pending registration removed

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
  "assignments": [
    { "name": "type1", "id": 1024 },
    { "name": "type2", "id": 1026 },
    { "name": "type3", "id": 1028 }
  ]
}
```

### Simultaneous Registration (ID Jitter)

**Scenario**: Both sides register same message type simultaneously

**Requesting Side A**:
1. Sends `mesgTypeReq` for "userMessage"
2. Receives `mesgTypeResp` with ID 1024 (even)
3. Stores ID 1024 in `ids` array: `[1024]`

**Requesting Side B** (simultaneously):
1. Sends `mesgTypeReq` for "userMessage"
2. Receives `mesgTypeResp` with ID 1025 (odd)
3. Stores ID 1025 in `ids` array: `[1025]`

**Accepting Side A** (receives B's request):
1. Assigns ID 1024 (even, because A is EVEN_ROLE)
2. Sends `mesgTypeResp` with ID 1024
3. B receives response, adds 1024 to array: `[1025, 1024]` → sorted: `[1024, 1025]`

**Accepting Side B** (receives A's request):
1. Assigns ID 1025 (odd, because B is ODD_ROLE)
2. Sends `mesgTypeResp` with ID 1025
3. A receives response, adds 1025 to array: `[1024, 1025]`

**Result**: Both sides have `[1024, 1025]`, use 1024 (lowest) for sending. Automatic settlement.

See [`id-jitter-settlement.md`](id-jitter-settlement.md) for detailed analysis (same pattern as channels).

### Message-Type Lifecycle

**Registration**:
- Message types registered when needed
- Batch registration supported
- Idempotent (can re-register existing types)

**Usage**:
- Sender uses first (lowest) ID from array
- Receiver matches incoming ID to message-type record
- Filtering by message type in `read({ only })` operations

**Clearing**:
- Message types cleared when channel reaches `closed` state
- Not cleared during `closing`/`localClosing`/`remoteClosing` (may still need them)
- Fresh registrations when channel reopens

**Persistence**:
- Message types are per-channel (not transport-wide)
- Different channels can have different message-type mappings
- Same name can have different IDs on different channels

### Pre-Loaded TCC Message Types

**TCC Channel** (channel 0):
- Pre-loaded with standard message types
- No registration needed for these types
- Both sides agree on IDs during handshake

**Standard TCC Types**:
- `chanReq` (1) - Channel request
- `chanResp` (2) - Channel response
- `chanClose` (3) - Channel close initiation
- `chanClosed` (4) - Channel close completion
- `mesgTypeReq` (5) - Message-type registration request
- `mesgTypeResp` (6) - Message-type registration response

**Usage**:
```javascript
// TCC types pre-loaded, no registration needed
#messageTypes.set('chanReq', { name: 'chanReq', ids: [1], direction: 'both' });
#messageTypes.set(1, #messageTypes.get('chanReq'));
// ... etc for other TCC types
```

### Pending Registration Management

**Multiple Concurrent Requests**:
- Multiple calls to `addMessageType()` for same type
- All join same pending registration
- Single request sent to remote
- All promises resolved when response received

**Timeout Handling**:
- Timeout rejects individual promise
- Pending registration remains (response may still arrive)
- Late response still processed (resolves any remaining promises)

**Example**:
```javascript
// Two concurrent requests for same type
const promise1 = channel.addMessageType('userMessage');
const promise2 = channel.addMessageType('userMessage');

// Only one request sent to remote
// Both promises resolve when response received
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
