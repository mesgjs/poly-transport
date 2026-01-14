# Channel Acceptance Scenario

**Status**: 📋 Complete (2026-01-12)

## Overview

This scenario documents how a transport receives and processes a channel request from a remote transport. The transport dispatches a `newChannelRequest` event to registered handlers, which can accept or reject the request. The transport then sends a `chanResp` message back to the requester.

**Key Points**:
- The accepting transport assigns the channel ID (even or odd based on role)
- All `newChannelRequest` handlers are called, but only first acceptance takes effect
- If no handler accepts, request is automatically rejected
- Response sent after all handlers complete (allows async handlers)
- Acceptance creates channel object immediately
- If channel already open, accept with existing ID (idempotent, no new ID assigned)

## Architectural Context

**Key Design Points** (from [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)):
- All channels are bidirectional (unidirectional concept removed)
- Channel responses use TCC data messages (message-type `chanResp`, type 2)
- **Only the accepting transport assigns channel IDs**
- EVEN_ROLE transports assign even channel IDs
- ODD_ROLE transports assign odd channel IDs
- Channel IDs stored in two-element array: `[]` → `[id]` → `[id1, id2]`
- First (lowest) ID used for sending
- Reuse existing ID if channel name already has one

## Preconditions

- Transport is started ([`transport-initialization.md`](transport-initialization.md))
- Transport role determined (EVEN_ROLE or ODD_ROLE) via UUID comparison
- TCC channel (channel 0) is open and operational
- At least one `newChannelRequest` event handler registered
- Remote transport has sent `chanReq` TCC message

## Actors

- **Accepting Transport**: Receives request, accepts or rejects
- **Event Handlers**: User-registered handlers that decide accept/reject
- **Channel Class**: Created upon acceptance
- **Protocol Module**: Encodes/decodes TCC messages
- **ChannelFlowControl**: Manages sending and receiving budgets for TCC

## Step-by-Step Sequence

### 1. Receive Channel Request Message

**Actor**: Transport (via `_handleIncomingMessage`)

**Trigger**: TCC data message received with message-type `chanReq` (type 1)

**Message Format** (JSON body):
```json
{
  "name": "primary",
  "maxBufferBytes": 65536,
  "maxChunkBytes": 16384,
  "maxMessageBytes": 0,
  "lowBufferBytes": 16384
}
```

**Action**:
1. Decode message header and body
2. Extract channel name and remote limits
3. Validate message format

**State Changes**:
- Request parameters extracted
- Ready to dispatch event

---

### 2. Check for Existing Channel

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Check if channel already exists with this name:

**Case A: Channel exists and is open**
- This is a duplicate/redundant request (channel already established)
- Proceed to accept with existing ID (idempotent, no new ID assigned)
- Skip event dispatch (see step 4 directly)

**Case B: Channel exists but is closing**
- Cannot accept while closing
- Skip event dispatch, proceed to reject (see step 8)

**Case C: Channel exists but is closed**
- Can reopen channel
- Proceed to dispatch event (see step 3)

**Case D: Channel doesn't exist**
- New channel request
- Proceed to dispatch event (see step 3)

**State Changes**:
- Channel existence and state determined

---

### 3. Dispatch `newChannelRequest` Event

**Actor**: [`Transport`](../../src/transport/base.esm.js) via [`Eventable`](../../resources/eventable/src/eventable.esm.js)

**Action**: Create and dispatch event to all registered handlers:

```javascript
const event = {
  type: 'newChannelRequest',
  name: request.name,
  remoteLimits: {
    maxBufferBytes: request.maxBufferBytes,
    maxChunkBytes: request.maxChunkBytes,
    maxMessageBytes: request.maxMessageBytes,
    lowBufferBytes: request.lowBufferBytes
  },
  accepted: false,  // Will be set to true by first accept() call
  localLimits: null,  // Will be set by accept() call
  accept: (options = {}) => {
    if (event.accepted) return;  // Already accepted, ignore
    event.accepted = true;
    event.localLimits = {
      maxBufferBytes: options.maxBufferBytes ?? channelDefaults.maxBufferBytes,
      maxChunkBytes: options.maxChunkBytes ?? channelDefaults.maxChunkBytes,
      maxMessageBytes: options.maxMessageBytes ?? channelDefaults.maxMessageBytes,
      lowBufferBytes: options.lowBufferBytes ?? channelDefaults.lowBufferBytes
    };
  }
};

await transport._dispatchEvent('newChannelRequest', event);
```

**State Changes**:
- Event dispatched to all handlers (awaited)
- `event.accepted` set to true if any handler called `accept()`
- `event.localLimits` set by accepting handler

---

### 4. Assign Channel ID (If Accepted)

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Trigger**: `event.accepted === true` OR channel already open (Case A)

**Action**: Assign or reuse channel ID:

**Check for Existing Channel and ID**:
```javascript
const existingChannel = #channels.get(request.name);
let channelId;
let isNewId = false;

if (existingChannel && existingChannel.ids.length > 0) {
  // Reuse existing ID (first one in array)
  channelId = existingChannel.ids[0];
  isNewId = false;
} else {
  // Assign new ID (even or odd will be based on role)
  channelId = #nextChannelId;
  #nextChannelId += 2;
  isNewId = true;
}
```

**State Changes**:
- Channel ID determined (new or reused)
- Next ID counter incremented (if new ID assigned)

---

### 5. Create or Update Channel Object

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Create new channel or update existing:

**Case A: Channel exists and is open** (duplicate request):
```javascript
// Channel already open, just send acceptance with existing ID
// No changes to channel object needed
```

**Case B: Channel exists but is closed** (reopen):
```javascript
existingChannel.state = 'open';
// Recreate flow control with new limits
existingChannel.flowControl = new ChannelFlowControl(event.localLimits.maxBufferBytes, request.maxBufferBytes);
existingChannel.remoteLimits = {
  maxBufferBytes: request.maxBufferBytes,
  maxChunkBytes: request.maxChunkBytes,
  maxMessageBytes: request.maxMessageBytes,
  lowBufferBytes: request.lowBufferBytes
};
existingChannel.localLimits = event.localLimits;
```

**Case C: Channel doesn't exist** (new channel):
```javascript
const channel = new Channel({
  transport: this,
  name: request.name,
  ids: [channelId],  // Single ID from this acceptance
  state: 'open',
  flowControl: new ChannelFlowControl(event.localLimits.maxBufferBytes, request.maxBufferBytes),
  localLimits: event.localLimits,
  remoteLimits: {
    maxBufferBytes: request.maxBufferBytes,
    maxChunkBytes: request.maxChunkBytes,
    maxMessageBytes: request.maxMessageBytes,
    lowBufferBytes: request.lowBufferBytes
  }
});

#channels.set(request.name, channel);
#channels.set(channelId, channel);
```

**State Changes**:
- Channel created or updated (not for Case A - already open)
- Channel registered in `#channels` map by name and ID (if new)
- Flow control instances created/recreated (not for Case A)
- Channel state set to `'open'` (or remains `'open'` for Case A)

---

### 6. Encode Acceptance Response

**Actor**: [`Protocol`](../../src/protocol.esm.js)

**Action**: Create TCC data message with `chanResp` message-type:

**Response Format** (JSON body):
```json
{
  "name": "primary",
  "id": 257,
  "accepted": true,
  "maxBufferBytes": 65536,
  "maxChunkBytes": 16384,
  "maxMessageBytes": 0,
  "lowBufferBytes": 16384
}
```

**Header Encoding**:
- Header type: 2 (channel data)
- Channel ID: 0 (TCC)
- Sequence number: Next TCC send sequence
- Message type: 2 (`chanResp` from TCC pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded response body

**State Changes**:
- TCC send sequence incremented
- Message encoded into output ring buffer

---

### 7. Check TCC Sending Budget and Send

**Actor**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js) (TCC instance) and Transport

**Action**: Verify sufficient budget and send:

```javascript
const chunkBytes = headerBytes + dataBytes;
if (!tccSendFlow.canSend(chunkBytes)) {
  await tccSendFlow.waitForBudget(chunkBytes);
}

const seq = tccSendFlow.recordSent(chunkBytes);
await transport._sendMessage(0, messageBuffer);
```

**State Changes**:
- Chunk recorded in TCC `ChannelFlowControl` in-flight map
- TCC sending budget reduced by `chunkBytes`
- Message sent to remote transport

---

### 8. Encode Rejection Response (If Not Accepted)

**Actor**: [`Protocol`](../../src/protocol.esm.js)

**Trigger**: `event.accepted === false` (no handler called `accept()`) OR channel is closing

**Action**: Create TCC data message with `chanResp` message-type:

**Response Format** (JSON body):
```json
{
  "name": "primary",
  "accepted": false,
  "reason": "No handler accepted channel request"
}
```

**Common Rejection Reasons**:
- "No handler accepted channel request" (default)
- "Channel is closing" (channel in closing state)
- "Channel limit exceeded" (resource limit)
- "Invalid channel name" (validation failure)
- Custom reasons from handlers

**Header Encoding**:
- Header type: 2 (channel data)
- Channel ID: 0 (TCC)
- Sequence number: Next TCC send sequence
- Message-type ID: 2 (`chanResp` from TCC pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded response body

**State Changes**:
- TCC send sequence incremented
- Message encoded into output ring buffer

---

### 9. Check TCC Sending Budget and Send Rejection

**Actor**: [`ChannelFlowControl`](../../src/channel-flow-control.esm.js) (TCC instance) and Transport

**Action**: Same as step 7 (verify budget and send)

**State Changes**:
- Chunk recorded in TCC `ChannelFlowControl` in-flight map
- TCC sending budget reduced by `chunkBytes`
- Message sent to remote transport

---

## Postconditions

**Acceptance Case**:
- Channel instance exists in `'open'` state
- Channel has assigned ID (even or odd based on role)
- Channel registered in `#channels` map by name and ID
- Flow control instances configured
- Acceptance response sent to requester

**Rejection Case**:
- No channel created (or existing channel unchanged)
- Rejection response sent to requester with reason
- Remote transport will add channel name to `#rejectedChannels`

## Error Conditions

### Transport Not Started
- **Trigger**: Request received before transport started
- **Handling**: Should not happen (TCC not operational)
- **Recovery**: Implementation bug

### Invalid Request Format
- **Trigger**: Malformed JSON or missing required fields
- **Handling**: Reject request with error reason
- **Recovery**: Remote should fix request format

### Channel Is Closing
- **Trigger**: Channel exists in actively-closing state
- **Handling**: Reject request with reason "Channel is closing"
- **Recovery**: Remote should wait and retry

### Insufficient TCC Budget
- **Trigger**: TCC sending budget exhausted
- **Handling**: Wait for ACKs to restore budget (async)
- **Recovery**: Automatic (waits for budget)

### Duplicate ID Assignment
- **Trigger**: Assigned ID already in use for different channel
- **Handling**: Implementation bug (should never happen)
- **Recovery**: Close transport

### Handler Throws Exception
- **Trigger**: Event handler throws during execution
- **Handling**: Catch exception, reject request
- **Recovery**: Log error, send rejection response

## Related Scenarios

- **Prerequisites**:
  - [`transport-initialization.md`](transport-initialization.md) - Transport must be started
  - [`role-determination.md`](role-determination.md) - Role determines ID assignment

- **Counterpart**:
  - [`channel-request.md`](channel-request.md) - Requesting side

- **Follow-up**:
  - [`id-jitter-settlement.md`](id-jitter-settlement.md) - Simultaneous requests
  - [`channel-closure.md`](channel-closure.md) - Closing established channel

- **Related**:
  - [`message-type-registration.md`](message-type-registration.md) - Similar accept/reject pattern
  - [`send-flow-control.md`](send-flow-control.md) - TCC budget management

## Implementation Notes

### Event Handler Pattern

**Event Object Structure**:
```javascript
{
  type: 'newChannelRequest',
  name: string,
  remoteLimits: {
    maxBufferBytes: number,
    maxChunkBytes: number,
    maxMessageBytes: number,
    lowBufferBytes: number
  },
  accepted: boolean,  // Initially false
  localLimits: object | null,  // Set by accept()
  accept: (options) => void
}
```

**Accept Method**:
- Can be called by any handler
- Only first call has effect (subsequent calls ignored)
- Sets `event.accepted = true`
- Sets `event.localLimits` from options (merged with defaults)

**Handler Execution**:
- All handlers called sequentially (awaited)
- Handlers can be async
- Response not sent until all handlers complete
- Allows handlers to perform async validation

### Channel ID Assignment Strategy

**Reuse Existing ID** (channel already has ID):
- Check if channel name already has an ID
- If yes: return first ID in array
- **No new ID assigned**
- Reduces ID exhaustion
- Maintains consistency across close/reopen cycles
- Provides idempotent acceptance for duplicate requests

**Assign New ID** (channel doesn't have ID):
- EVEN_ROLE: next even ID (256, 258, 260, ...)
- ODD_ROLE: next odd ID (257, 259, 261, ...)
- Starting point: `minChannelId` from handshake (default 2)
- Increment by 2 after each assignment

**ID Storage**:
```javascript
#nextChannelId = 2;  // Actual value based on handshake and role
```

### Handling Duplicate Requests

**Scenario**: Channel already open, receive another request

**Behavior**: Accept with existing ID (idempotent)
- No new ID assigned
- No changes to channel object
- Send acceptance response with existing ID
- Remote will receive response and match to pending request

**Rationale**:
- Idempotent operation (safe to repeat)
- Handles race conditions gracefully
- Simplifies remote logic (doesn't need to detect duplicates)

### Simultaneous Requests Handling

**Scenario**: Both transports request same channel simultaneously

**Acceptance Side**:
1. Receive request from remote
2. Check if channel exists (from local request)
3. If exists and open: accept with existing ID (Case A)
4. If doesn't exist: dispatch event, assign new ID if accepted
5. Send acceptance with assigned ID

**Result**: Both sides end up with two IDs (one even, one odd), automatically settle to lowest.

See [`id-jitter-settlement.md`](id-jitter-settlement.md) for detailed analysis.

### Default Rejection

**Behavior**: If no handler calls `accept()`, request is automatically rejected.

**Reason**: `"No handler accepted channel request"`

**Rationale**:
- Explicit opt-in for channel acceptance
- Prevents accidental channel creation
- Security: untrusted clients can't create arbitrary channels

### Application-Level Policies

**Resource Limits**:
- Handlers can enforce maximum channel count
- Handlers can validate channel names (whitelist/blacklist)
- Handlers can check remote limits (reject if too high)

**Example Handler**:
```javascript
transport.addEventListener('newChannelRequest', (event) => {
  // Enforce channel limit
  if (transport.channels.size >= MAX_CHANNELS) {
    return;  // Don't accept (will be rejected)
  }
  
  // Validate channel name
  if (!ALLOWED_CHANNELS.includes(event.name)) {
    return;  // Don't accept
  }
  
  // Accept with local limits
  event.accept({
    maxBufferBytes: 65536,
    maxChunkBytes: 16384,
    maxMessageBytes: 0,
    lowBufferBytes: 16384
  });
});
```

### Channel Reuse on Acceptance

**Closed Channel Reopen**:
- If channel exists but is closed, acceptance reopens it
- Reuses existing ID (no new assignment)
- Recreates flow control with new limits
- Updates state to `'open'`

**Open Channel (Duplicate Request)**:
- If channel exists and is open, acceptance is idempotent
- Reuses existing ID (no new assignment)
- No changes to channel object
- Sends acceptance response

### Security Considerations

**Untrusted Requesters**:
- Handlers should validate channel names
- Handlers should enforce resource limits
- Handlers should check remote limits (reject if excessive)

**Malicious Requests**:
- Many rapid requests (DoS attempt)
- Excessive buffer limits (memory exhaustion)
- Invalid channel names (injection attempts)

**Handler Protection**:
- Catch handler exceptions
- Reject request if handler throws
- Log errors for debugging

### Performance Considerations

**Handler Execution**:
- All handlers called sequentially (awaited)
- Allows async validation (e.g., database lookups)
- Response delayed until all handlers complete
- Consider timeout for handler execution

**ID Assignment**:
- Simple counter increment (O(1))
- No ID collision detection needed (even/odd separation)
- Reuse existing IDs when possible

**Channel Reuse**:
- Reopening reuses existing ID
- No new ID assignment needed
- Reduces ID exhaustion

**Idempotent Acceptance**:
- Duplicate requests handled gracefully
- No error or special handling needed
- Simplifies remote logic

### Testing Considerations

**Unit Tests**:
- Test successful acceptance (new channel)
- Test default rejection (no handler accepts)
- Test multiple handlers (only first accept counts)
- Test handler with async validation
- Test channel reuse (reopen closed channel)
- Test duplicate request (channel already open)
- Test simultaneous requests (ID jitter)
- Test invalid request format
- Test channel is closing (reject)
- Test handler throws exception
- Test ID assignment (even/odd based on role)
- Test ID reuse (existing channel)

**Integration Tests**:
- Test with real transport implementations
- Test resource limit enforcement
- Test malicious request patterns
- Test handler timeout scenarios
- Test channel reuse after closure
- Test idempotent acceptance
