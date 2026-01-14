# Channel Request Scenario

**Status**: 📋 Complete (2026-01-12)

## Overview

This scenario documents how a transport requests a new bidirectional channel from a remote transport. Channel requests are sent as TCC data messages with message-type `chanReq` (type 1). The requesting transport waits for a response (`chanResp`, type 2) which either accepts the request (providing a channel ID) or rejects it.

**Key Points**:
- The requesting transport does NOT assign a channel ID - only the accepting transport assigns IDs
- Multiple simultaneous `requestChannel()` calls for the same name join the same pending request
- Only one TCC request message sent at a time per channel (transport is reliable/ordered)
- Timeout rejects individual promise but pending request remains (response will still arrive)
- Pending request removed only when response received

## Architectural Context

**Key Design Points** (from [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md) and [`arch/requirements.md`](../requirements.md) Update 2026-01-12-D):
- All channels are bidirectional (unidirectional concept removed)
- Channel requests use TCC data messages (not control messages)
- **Only the accepting transport assigns channel IDs**
- EVEN_ROLE transports assign even channel IDs
- ODD_ROLE transports assign odd channel IDs
- Channel IDs stored in two-element array in ascending order: `[]` → `[id]` → `[id1, id2]`
- First (lowest) ID used for sending
- ID jitter possible during simultaneous requests (settles automatically)
- **Transports are reliable/ordered** (TCP-like) - no message loss, only delay
- **One TCC request message in flight at a time per channel**
- **Timeout does not remove pending request** - response will still arrive
- **Cannot request channel while it's `closing`** - throws `ChannelClosingError`

## Preconditions

- Transport is started ([`transport-initialization.md`](transport-initialization.md))
- Transport role determined (EVEN_ROLE or ODD_ROLE) via UUID comparison
- TCC channel (channel 0) is open and operational
- Remote transport has at least one `newChannelRequest` event handler registered
- If channel exists, it must not be in `closing` state

## Actors

- **Requesting Transport**: Initiates channel request
- **Remote Transport**: Receives request, accepts or rejects
- **Channel Class**: Created upon successful acceptance
- **Protocol Module**: Encodes/decodes TCC messages
- **ChannelFlowControl**: Manages sending and receiving budgets for TCC

## Step-by-Step Sequence

### 1. User Calls `transport.requestChannel(name, options)`

**Actor**: User code

**Action**: Initiates channel request with:
- `name`: String identifier for the channel (e.g., `'primary'`, `'console'`)
- `options`: Optional configuration object:
  - `timeout`: Timeout in milliseconds (default: transport-configured value)
  - `maxBufferBytes`: Local maximum buffer size (default: from channel defaults)
  - `maxChunkBytes`: Local maximum chunk size (default: from channel defaults)
  - `maxMessageBytes`: Local maximum message size (default: from channel defaults)
  - `lowBufferBytes`: Local low-water mark for ACKs (default: from channel defaults)

**State Changes**:
- None yet (validation occurs first)

---

### 2. Transport Validates Request

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Validation Checks**:
1. Transport must be started (not stopped)
   - Throws error if `!isStarted` or `isStopped`
2. Channel name must be a non-empty string
   - Throws `TypeError` if invalid
3. Check if channel name is permanently rejected
   - Throws error if `#rejectedChannels.has(name)`
4. Check if channel exists and is in `closing` state
   - Throws `ChannelClosingError` if channel exists and `channel.state === 'closing'`
   - Must wait until channel fully closed before reopening
5. Merge options with channel defaults to get complete configuration

**State Changes**:
- Local receiving limits determined (will be sent in request)

---

### 3. Check Channel and Request Status

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Determine current state of channel and any pending requests:

**Case A: Channel exists and is open**
- Return existing channel immediately
- No request sent, no pending request created/updated

**Case B: Channel exists but is closed**
- Channel has ID(s) from previous acceptance(s)
- Proceed to check for pending request (Case C or D)

**Case C: Request already pending**
- A TCC request message has been sent and response not yet received
- Join the existing request:
  - Create new promise for this caller
  - Add promise to pending request's promises array
  - Return the new promise (will resolve/reject when response arrives)
- **No new TCC request message sent** (transport is reliable/ordered, one message in flight)

**Case D: No channel (or channel is closed) and no pending request**
- Proceed with new request

**Data Structures**:
```javascript
// Transport internal state
#channels = new Map();  // Keys: name (string) OR id (number) → Channel instance
#pendingRequests = new Map();  // name → { promises: [], localLimits }
#rejectedChannels = new Set();  // Permanently rejected channel names
```

**State Changes**:
- If returning existing channel: none
- If joining pending request: new promise added
- Otherwise: proceed to next step

---

### 4. Create Pending Request Record

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Create pending request record (NOT a channel object yet):

```javascript
const pendingRequest = {
  name,
  promises: [],  // Array of { resolve, reject, timeout }
  localLimits: {
    maxBufferBytes,
    maxChunkBytes,
    maxMessageBytes,
    lowBufferBytes
  }
};

#pendingRequests.set(name, pendingRequest);
```

**State Changes**:
- Pending request recorded in `#pendingRequests` map
- No channel object created yet

---

### 5. Create Request Promise and Timeout

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Set up promise that will resolve/reject based on response:

```javascript
const promiseRecord = {
  resolve: null,
  reject: null,
  timeout: null
};

const requestPromise = new Promise((resolve, reject) => {
  promiseRecord.resolve = resolve;
  promiseRecord.reject = reject;
  
  // Set up timeout if specified
  if (timeout) {
    promiseRecord.timeout = setTimeout(() => {
      // Timeout does NOT remove pending request
      // Response will still arrive (transport is reliable/ordered)
      reject(new TimeoutError(`Channel request timed out after ${timeout}ms`));
      // Null out resolve/reject to mark as resolved
      promiseRecord.resolve = null;
      promiseRecord.reject = null;
    }, timeout);
  }
});

pendingRequest.promises.push(promiseRecord);
```

**State Changes**:
- Promise created and added to pending request's promises array
- Timeout timer started (if timeout specified)

**Note**: Timeout does NOT remove pending request - response will still arrive.

---

### 6. Encode Channel Request Message

**Actor**: [`Protocol`](../../src/protocol.esm.js)

**Action**: Create TCC data message with `chanReq` message-type:

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

**Note**: No channel ID in request - only the acceptor assigns IDs.

**Header Encoding**:
- Header type: 2 (channel data)
- Channel ID: 0 (TCC)
- Sequence number: Next TCC send sequence
- Message type: 1 (`chanReq` from TCC pre-loaded types)
- EOM flag: true (single-chunk message)
- Data: JSON-encoded request body

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

### 8. Wait for Response

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Action**: Return promise to user, which will resolve/reject when response arrives:

```javascript
return requestPromise;
```

**Possible Outcomes**:
1. **Accept response arrives** → Promise resolves with channel (see step 9)
2. **Reject response arrives** → Promise rejects, name added to `#rejectedChannels` (see step 10)
3. **Timeout expires** → Promise rejects with `TimeoutError`, pending request remains (see step 11)
4. **Transport stops** → All promises reject with error

**State Changes**:
- User code awaits promise
- Pending request tracked in `#pendingRequests` map

---

### 9. Handle Response (Accept)

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Trigger**: TCC data message received with message-type `chanResp` (type 2)

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

**Action**:
1. Retrieve pending request from `#pendingRequests` by name
   - If no pending request: throw `ProtocolViolationError('UnexpectedAcceptance')`
2. Check if channel already exists
   - **Case A: Channel exists and is open** (simultaneous requests):
     - Add new ID to channel's ID array
     - Sort IDs ascending: `[existingId, newId]` → sorted
     - Verify no duplicate even/odd IDs (protocol violation if duplicate)
     - See `Transport.addRoleId(id, ids)`
     - Update remote limits if needed
     - Update `#channels` map with new ID as key
   - **Case B: Channel exists but is closing**:
     - This shouldn't happen (step 2 prevents requests while closing)
     - If it does: protocol violation or implementation bug
   - **Case C: Channel exists but is closed**:
     - Reopen channel: update state to `'open'`
     - Add new ID to channel's ID array (if not already present)
     - Recreate flow control instances with new limits
     - Update `#channels` map with new ID as key
   - **Case D: Channel doesn't exist** (first acceptance):
     - Create new Channel instance:
       ```javascript
       const channel = new Channel({
         transport: this,
         name,
         ids: [response.id],  // Single ID from acceptor
         state: 'open',
         flowControl: new ChannelFlowControl(pendingRequest.localLimits.maxBufferBytes, response.maxBufferBytes),
         localLimits: pendingRequest.localLimits,
         remoteLimits: {
           maxBufferBytes: response.maxBufferBytes,
           maxChunkBytes: response.maxChunkBytes,
           maxMessageBytes: response.maxMessageBytes,
           lowBufferBytes: response.lowBufferBytes
         }
       });
       ```
     - Register channel in `#channels` map with both name and ID as keys:
       ```javascript
       #channels.set(name, channel);
       #channels.set(response.id, channel);
       ```
3. Resolve all non-timed-out promises with channel instance:
   ```javascript
   for (const promiseRecord of pendingRequest.promises) {
     if (promiseRecord.timeout) clearTimeout(promiseRecord.timeout);
     // Only resolve if promise hasn't already been rejected by timeout
     if (promiseRecord.resolve) {
       promiseRecord.resolve(channel);
     }
   }
   ```
4. Remove pending request:
   ```javascript
   #pendingRequests.delete(name);
   ```

**State Changes**:
- Channel created/updated/reopened with ID from acceptor
- Channel state set to `'open'`
- Channel registered in `#channels` map (by name and ID)
- Flow control instances created/recreated and configured
- All non-timed-out promises resolved
- Pending request removed

---

### 10. Handle Response (Reject)

**Actor**: [`Transport`](../../src/transport/base.esm.js)

**Trigger**: TCC data message received with message-type `chanResp` (type 2)

**Response Format** (JSON body):
```json
{
  "name": "primary",
  "accepted": false,
  "reason": "Channel limit exceeded"
}
```

**Action**:
1. Retrieve pending request from `#pendingRequests` by name
   - If no pending request: throw `ProtocolViolationError('UnexpectedRejection')`
2. Add channel name to `#rejectedChannels` Set (permanent rejection)
3. Check if channel already exists (from acceptance in other direction)
   - **Case A: Channel exists**: Resolve all non-timed-out promises with existing channel
   - **Case B: Channel doesn't exist**: Reject all non-timed-out promises with error
4. Clear all timeouts and resolve/reject all promises:
   ```javascript
   for (const promiseRecord of pendingRequest.promises) {
     if (promiseRecord.timeout) clearTimeout(promiseRecord.timeout);
     if (promiseRecord.resolve || promiseRecord.reject) {
       if (channel) {
         promiseRecord.resolve(channel);  // Other direction succeeded
       } else {
         promiseRecord.reject(new Error(`Channel rejected: ${response.reason}`));
       }
     }
   }
   ```
5. Remove pending request:
   ```javascript
   #pendingRequests.delete(name);
   ```

**State Changes**:
- Channel name added to `#rejectedChannels` (permanent)
- All non-timed-out promises resolved (if channel exists) or rejected (if not)
- Pending request removed

**Note**: Rejection only blocks future requests from this transport. The remote transport can still request the same channel name.

---

### 11. Handle Timeout

**Actor**: Timeout timer

**Trigger**: Timeout expires before response received

**Action**:
1. Reject the specific promise that timed out:
   ```javascript
   promiseRecord.reject(new TimeoutError(`Channel request timed out after ${timeout}ms`));
   // Null out resolve/reject to mark as resolved
   promiseRecord.resolve = null;
   promiseRecord.reject = null;
   ```
2. **Do NOT remove pending request** - response will still arrive (transport is reliable/ordered)
3. **Do NOT add to `#rejectedChannels`** - timeout is not permanent rejection

**State Changes**:
- Single promise rejected with `TimeoutError`
- Pending request remains (waiting for response)
- Promise marked as resolved (nulled resolve/reject functions)
- Channel name NOT added to `#rejectedChannels` (can retry)

**Note**: When response arrives, it will skip already-resolved promises (see step 9 or 10).

---

## Postconditions

**Success Case**:
- Channel instance exists in `'open'` state
- Channel has at least one ID (from acceptor)
- Channel registered in `#channels` map by name and ID(s)
- Flow control instances configured
- All non-timed-out promises resolved with channel instance
- Pending request removed

**Failure Cases (Rejection)**:
- No channel created (unless accepted in other direction)
- Channel name added to `#rejectedChannels` (permanent)
- All non-timed-out promises resolved (if channel exists) or rejected (if not)
- Pending request removed

**Failure Cases (Timeout)**:
- Single promise rejected with `TimeoutError`
- Pending request remains (waiting for response)
- Channel name NOT added to `#rejectedChannels` (can retry)
- Response will still arrive and be processed

## Error Conditions

### Transport Not Started
- **Trigger**: `requestChannel()` called before `start()` or after `stop()`
- **Handling**: Throw error immediately
- **Recovery**: Start transport before requesting channels

### Invalid Channel Name
- **Trigger**: Name is not a non-empty string
- **Handling**: Throw `TypeError` immediately
- **Recovery**: Provide valid string name

### Channel Permanently Rejected
- **Trigger**: Channel name in `#rejectedChannels` Set
- **Handling**: Throw error immediately
- **Recovery**: None (permanent rejection)

### Channel Is Closing
- **Trigger**: Channel exists in any actively-closing state
- **Handling**: Throw `ChannelClosingError` immediately
- **Recovery**: Wait for channel to fully close, then retry

### Timeout
- **Trigger**: No response within timeout period
- **Handling**: Reject specific promise with `TimeoutError`, pending request remains
- **Recovery**: Retry request (creates new promise, joins existing pending request)

### Remote Rejection
- **Trigger**: Remote transport rejects request
- **Handling**: Add to `#rejectedChannels`, resolve/reject all promises based on channel existence
- **Recovery**: None (permanent rejection from this direction)

### Insufficient TCC Budget
- **Trigger**: TCC sending budget exhausted
- **Handling**: Wait for ACKs to restore budget (async)
- **Recovery**: Automatic (waits for budget)

### Transport Stopped During Request
- **Trigger**: `transport.stop()` called while request pending
- **Handling**: Reject all pending promises for all channels
- **Recovery**: None (transport stopped)

### Unsolicited Response
- **Trigger**: Response arrives with no matching pending request
- **Handling**: Throw `ProtocolViolationError('UnexpectedAcceptance')` or `ProtocolViolationError('UnexpectedRejection')`
- **Recovery**: May close transport (security issue)

### Duplicate ID (Same Parity)
- **Trigger**: Acceptance provides ID with same parity as existing ID
- **Handling**: Throw `ProtocolViolationError('DuplicateChannelId')`
- **Recovery**: Close transport (protocol violation)

## Related Scenarios

- **Prerequisites**:
  - [`transport-initialization.md`](transport-initialization.md) - Transport must be started
  - [`role-determination.md`](role-determination.md) - Role determines ID assignment

- **Follow-up**:
  - [`channel-acceptance.md`](channel-acceptance.md) - Remote side handling
  - [`id-jitter-settlement.md`](id-jitter-settlement.md) - Simultaneous requests
  - [`channel-closure.md`](channel-closure.md) - Closing established channel

- **Related**:
  - [`message-type-registration.md`](message-type-registration.md) - Similar request/response pattern
  - [`send-flow-control.md`](send-flow-control.md) - TCC budget management

## Implementation Notes

### Channel Storage Strategy

**Single Map with Multiple Keys**:
```javascript
#channels = new Map();  // Keys: name (string) OR id (number) → Channel instance

// Register channel by name and all IDs
#channels.set(name, channel);
for (const id of channel.ids) {
  #channels.set(id, channel);
}

// Lookup by name or ID
const channel = #channels.get(nameOrId);
```

**Benefits**:
- Single source of truth (one channel object)
- Fast lookup by name or ID
- Channel knows its own name and IDs
- No separate name-to-ID mapping needed

### Pending Request Tracking (Simplified)

**Pending Request Structure**:
```javascript
{
  name: string,
  promises: [     // Array of promise records
    {
      resolve: Function | null,  // Null if already resolved/rejected
      reject: Function | null,   // Null if already resolved/rejected
      timeout: Timer | null
    },
    ...
  ],
  localLimits: {
    maxBufferBytes: number,
    maxChunkBytes: number,
    maxMessageBytes: number,
    lowBufferBytes: number
  }
}
```

**Simplified Semantics**:
- Pending request exists = TCC message in flight
- Pending request doesn't exist = no TCC message in flight
- No count needed (only one TCC message at a time per channel)
- Transport is reliable/ordered (no loss, only delay)

**Request Logic**:
- If pending request exists: join (add promise, no TCC sent)
- If pending request doesn't exist: create, send TCC message
- Response arrives: resolve all non-timed-out promises, remove pending request
- Timeout: reject promise (null it), pending request remains

**Benefits**:
- Simpler than count-based tracking
- Handles multiple simultaneous user requests efficiently
- Validates against unsolicited responses
- Allows late responses after timeout
- Minimizes TCC traffic (one message per channel)

### Example: Multiple Requests with Timeout

**Scenario**: Req 1 - timeout - Req 2 - Resp

**Flow**:
1. **Req 1**: Create pending request, send TCC, add promise1
2. **timeout**: Reject promise1 (null resolve/reject), pending request remains
3. **Req 2**: Pending request exists, add promise2, **no TCC sent**
4. **Resp**: Resolve promise2 (skip promise1 - already nulled), remove pending request

**Result**: Req 2 successfully gets the channel via the response to Req 1.

### Permanent Rejection Tracking

**Rejected Channels Set**:
```javascript
#rejectedChannels = new Set();  // Channel names permanently rejected
```

**When Added**:
- Only on explicit remote rejection (not timeout)
- Prevents future requests for this channel name from this transport

**Directional Nature**:
- Rejection only blocks requests from the rejected direction
- Remote transport can still request the same channel name
- If remote requests and local accepts, channel can still be created

### Channel ID Assignment

**Key Principle**: Only the accepting transport assigns IDs.

**Acceptor Behavior**:
- Check if channel name already has an ID
- If yes: return existing ID (first one in array)
- If no: assign next sequential ID (even or odd based on role)
- Return assigned ID in `chanResp`

**Requester Behavior**:
- Send request with name only (no ID)
- Receive ID from acceptor in response
- Create channel with received ID
- If channel already exists (simultaneous request), add new ID to array

### Simultaneous Requests (ID Jitter)

**Scenario**: Both transports request same named channel simultaneously

**Flow**:
1. Transport A (EVEN_ROLE) requests "primary"
2. Transport B (ODD_ROLE) requests "primary"
3. Transport A accepts B's request, assigns ID 256 (even)
4. Transport B accepts A's request, assigns ID 257 (odd)
5. Both transports receive responses
6. Both transports have channel with IDs `[256, 257]`
7. Both use ID 256 (lowest) for sending

**Result**: Automatic settlement to lowest ID, no coordination needed.

See [`id-jitter-settlement.md`](id-jitter-settlement.md) for detailed analysis.

### Channel Reuse After Close

**Transport Policy**: Allows channel reuse after close
- Closed channels retain their IDs
- Reopening uses same IDs (no new assignment needed)
- Reduces ID exhaustion over long-running connections
- **Cannot reopen while channel is `closing`** - must wait for `closed` state

**Application Policy**: May prevent reuse
- Application can track closed channels
- Use `newChannelRequest` event to reject reopening attempts
- Transport provides mechanism, application enforces policy

### Deferred: Channel Generations

**Issue**: How to handle close timeouts and ensure both sides agree on channel state?

**Deferred To**: [`channel-closure.md`](channel-closure.md) scenario

**Questions**:
- Should channels track a generation counter?
- Should requests/responses include generation for validation?
- How to handle generation mismatches?
- How to handle close timeouts and force-close?
- How to handle cross-close scenarios?
- How to distinguish late open vs re-open responses?

These questions will be addressed in the channel closure scenario.

### Security Considerations

**Unsolicited Responses**:
- Responses without matching pending request are protocol violations
- May indicate malicious behavior or implementation bug
- Should trigger `protocolViolation` event
- May result in transport closure

**Duplicate IDs (Same Parity)**:
- Receiving two even IDs or two odd IDs for same channel is a protocol violation
- Indicates implementation bug or malicious behavior
- Must close transport immediately

**Resource Exhaustion**:
- Malicious clients may request many channels
- Trusted transports should limit channel acceptance
- Use `newChannelRequest` event to enforce limits

**Permanent Rejection**:
- Only explicit rejection causes permanent blocking
- Timeout allows retry (may be transient network issue)
- Application can implement additional rejection policies

### Performance Considerations

**Request Joining**:
- Multiple simultaneous user requests share single TCC message
- Reduces network overhead
- All callers receive same result
- Simplified tracking (no count needed)

**Timeout Selection**:
- Default timeout should be reasonable (e.g., 5000ms)
- Too short: false timeouts on slow networks
- Too long: delayed error detection
- Timeout doesn't prevent late response from being processed

**Channel Reuse**:
- Closed channels retain their IDs
- Reopening uses same IDs (no new assignment needed)
- Reduces ID exhaustion over long-running connections

**Reliable Transport Assumption**:
- No retries needed (transport is reliable/ordered)
- One TCC message per channel at a time
- Response will eventually arrive (or connection lost)

### Testing Considerations

**Unit Tests**:
- Test successful request/accept flow
- Test request/reject flow (permanent)
- Test timeout handling (not permanent, pending remains)
- Test multiple user requests joining (single TCC message)
- Test late response after timeout
- Test response while channel closing (should not happen)
- Test channel reopen after close
- Test invalid parameters
- Test transport not started
- Test channel is closing (ChannelClosingError)
- Test simultaneous requests (ID jitter)
- Test duplicate ID detection
- Test permanent rejection blocking

**Integration Tests**:
- Test with real transport implementations
- Test network delays and timeouts
- Test malicious unsolicited responses
- Test resource exhaustion scenarios
- Test channel reuse after closure
- Test application-level rejection policies
- Test complex timing scenarios (Req 1 - timeout - Req 2 - Resp)
