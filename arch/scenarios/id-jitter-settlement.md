# ID Jitter Settlement Scenario

## Overview

When both transports simultaneously request the same named channel (or message-type), each accepting transport assigns its own ID (even or odd based on role). This creates temporary "ID jitter" where the resource has two IDs. The system automatically settles to the lower ID through the ID storage and selection mechanism.

This scenario documents how ID jitter occurs, how it's detected, and how the system automatically settles to a single, consistent ID without requiring explicit coordination.

**Key Principles**:
- IDs are **only assigned by the accepting transport**, never by the requester
- **Local requests only send remote requests if no ID exists yet**
- If the local transport already accepted a remote request (and assigned an ID), the local request **resolves immediately** with that channel
- **Accept messages must reach the write ring before local waiters are resolved** (prevents using ID before acceptance is processed)
- **No auto-accept** - If there's no explicit accept, it's **auto-rejected**
- This enables **one-round-trip channel opening** (a key benefit of bidirectional channels)

## Preconditions

- Both transports have completed handshake and role determination
- Transport A has ROLE_EVEN (assigns even IDs: 2, 4, 6, 8, ...)
- Transport B has ROLE_ODD (assigns odd IDs: 3, 5, 7, 9, ...)
- Both transports want to establish a channel named "data-sync"
- Neither transport has previously registered this channel name
- Both transports have `newChannelRequest` event handlers that call `event.accept()`

## Actors

- **Transport A** (ROLE_EVEN) - Initiates channel request and accepts incoming request
- **Transport B** (ROLE_ODD) - Initiates channel request and accepts incoming request
- **Channel** - Bidirectional channel object with ID array
- **Protocol** - Encodes/decodes channel request/response messages
- **OutputRingBuffer** - Write ring for outgoing messages

## Step-by-Step Sequence

### Phase 1: Simultaneous Requests (No IDs Exist Yet)

**Step 1a: Transport A initiates request**
- **Actor**: Transport A
- **Action**: User calls `transportA.requestChannel('data-sync')`
- **Processing**:
  - Checks if channel "data-sync" already exists (active or pending)
  - Not found (no ID registered yet)
  - Must send remote request
- **State Change**:
  - Creates pending request entry: `{ name: 'data-sync', promise, waiters: [...] }`
  - **No ID assigned yet** (ID will come from acceptor)
  - Encodes `chanReq` message (TCC data message, type 1):
    ```json
    {
      "name": "data-sync",
      "maxBufferBytes": 65536,
      "maxChunkBytes": 16384,
      "maxMessageBytes": 1048576,
      "lowBufferBytes": 16384
    }
    ```
  - Sends message on TCC channel to Transport B

**Step 1b: Transport B initiates request**
- **Actor**: Transport B
- **Action**: User calls `transportB.requestChannel('data-sync')` (nearly simultaneously)
- **Processing**:
  - Checks if channel "data-sync" already exists (active or pending)
  - Not found (no ID registered yet)
  - Must send remote request
- **State Change**:
  - Creates pending request entry: `{ name: 'data-sync', promise, waiters: [...] }`
  - **No ID assigned yet** (ID will come from acceptor)
  - Encodes `chanReq` message (TCC data message, type 1):
    ```json
    {
      "name": "data-sync",
      "maxBufferBytes": 65536,
      "maxChunkBytes": 16384,
      "maxMessageBytes": 1048576,
      "lowBufferBytes": 16384
    }
    ```
  - Sends message on TCC channel to Transport A

### Phase 2: Request Reception and Acceptance (IDs Assigned by Acceptors)

**Step 2a: Transport A receives and accepts request from B**
- **Actor**: Transport A (acceptor)
- **Action**: Receives `chanReq` message from Transport B
- **Processing**:
  - Decodes message: name="data-sync", config={...}
  - Checks if channel name already exists:
    - Finds pending request for "data-sync" (from step 1a)
    - Channel object doesn't exist yet (only pending request entry)
  - Fires `newChannelRequest` event
  - Event handler calls `event.accept()`
- **State Change**:
  - **Assigns next even ID**: `4` (Transport A has ROLE_EVEN)
  - Creates channel object with ID array: `[4]`
  - Registers channel in active channels map: `{ 'data-sync' => channel }`
  - Encodes `chanResp` message (TCC data message, type 2):
    ```json
    {
      "name": "data-sync",
      "id": 4,
      "accept": true
    }
    ```
  - **Writes acceptance message to write ring** (OutputRingBuffer)
  - **After message reaches write ring**: Resolves local pending promise (from step 1a) with channel object
  - Removes pending request entry
  - **Current sending ID**: `4` (only ID in array)
  - **One-round-trip opening**: Local request resolved after acceptance written to ring

**Step 2b: Transport B receives and accepts request from A**
- **Actor**: Transport B (acceptor)
- **Action**: Receives `chanReq` message from Transport A
- **Processing**:
  - Decodes message: name="data-sync", config={...}
  - Checks if channel name already exists:
    - Finds pending request for "data-sync" (from step 1b)
    - Channel object doesn't exist yet (only pending request entry)
  - Fires `newChannelRequest` event
  - Event handler calls `event.accept()`
- **State Change**:
  - **Assigns next odd ID**: `5` (Transport B has ROLE_ODD)
  - Creates channel object with ID array: `[5]`
  - Registers channel in active channels map: `{ 'data-sync' => channel }`
  - Encodes `chanResp` message (TCC data message, type 2):
    ```json
    {
      "name": "data-sync",
      "id": 5,
      "accept": true
    }
    ```
  - **Writes acceptance message to write ring** (OutputRingBuffer)
  - **After message reaches write ring**: Resolves local pending promise (from step 1b) with channel object
  - Removes pending request entry
  - **Current sending ID**: `5` (only ID in array)
  - **One-round-trip opening**: Local request resolved after acceptance written to ring

**Jitter State**: At this point, Transport A uses ID 4 for sending, Transport B uses ID 5 for sending. This is the "jitter" period.

### Phase 3: Response Reception and Settlement

**Step 3a: Transport A receives acceptance response from B**
- **Actor**: Transport A (original requester)
- **Action**: Receives `chanResp` message from Transport B
- **Processing**:
  - Decodes message: name="data-sync", id=5 (odd), accept=true
  - Looks up channel by name "data-sync"
  - Channel already active (created in step 2a when accepting B's request)
  - Current ID array: `[4]`
  - Validates ID parity: 5 is odd, Transport B has ROLE_ODD ✓
  - Checks for duplicate: 5 not in array ✓
  - **No pending request** (already resolved in step 2a after acceptance written to ring)
- **State Change**:
  - Adds ID 5 to array: `[4, 5]` (sorted ascending)
  - **Sending ID remains**: `4` (still lowest, no change)
  - **Settlement complete for A**: Now uses ID 4 for sending (unchanged)

**Step 3b: Transport B receives acceptance response from A**
- **Actor**: Transport B (original requester)
- **Action**: Receives `chanResp` message from Transport A
- **Processing**:
  - Decodes message: name="data-sync", id=4 (even), accept=true
  - Looks up channel by name "data-sync"
  - Channel already active (created in step 2b when accepting A's request)
  - Current ID array: `[5]`
  - Validates ID parity: 4 is even, Transport A has ROLE_EVEN ✓
  - Checks for duplicate: 4 not in array ✓
  - **No pending request** (already resolved in step 2b after acceptance written to ring)
- **State Change**:
  - Adds ID 4 to array: `[4, 5]` (sorted ascending)
  - **Sending ID changes**: `5` → `4` (now uses lowest)
  - **Settlement complete for B**: Now uses ID 4 for sending

## Postconditions

- Both transports have active channel named "data-sync"
- Both transports have ID array `[4, 5]` for the channel
- Both transports use ID `4` (lowest) for sending messages
- Both transports accept messages on either ID `4` or `5`
- No protocol violations occurred
- Both user promises resolved successfully (in step 2, after acceptances written to ring)
- Channel is fully operational and bidirectional
- **One-round-trip opening achieved**: Local requests resolved when accepting remote request (after acceptance written to ring)

## ID Jitter Timeline

```
Time  Transport A (ROLE_EVEN)           Transport B (ROLE_ODD)
----  ------------------------------    ------------------------------
T0    requestChannel('data-sync')       requestChannel('data-sync')
      No ID exists → send request       No ID exists → send request
      Pending: { name, waiters }        Pending: { name, waiters }
      Sends chanReq(name) →             Sends chanReq(name) →

T1    ← Receives chanReq(name)          ← Receives chanReq(name)
      Handler calls accept()            Handler calls accept()
      Assigns ID: 4                     Assigns ID: 5
      Creates channel, IDs: [4]         Creates channel, IDs: [5]
      Writes chanResp(id=4) to ring     Writes chanResp(id=5) to ring
      RESOLVES LOCAL PROMISE ✓          RESOLVES LOCAL PROMISE ✓
      Sending ID: 4                     Sending ID: 5  ← JITTER
      Sends chanResp(id=4) →            Sends chanResp(id=5) →

T2    ← Receives chanResp(id=5)         ← Receives chanResp(id=4)
      IDs: [4, 5]                       IDs: [4, 5]
      Sending ID: 4 (settled)           Sending ID: 4 (settled) ← SETTLED
```

**Key Observations**:
- **T0**: No IDs exist yet → must send remote requests
- **T1**: Jitter begins - A uses ID 4, B uses ID 5
  - **Critical**: Local promises resolve after acceptance written to ring
  - **One-round-trip opening**: Channel usable after T1, before T2
  - **Ordering guarantee**: Acceptance message in ring before ID can be used
- **T2**: Settlement complete - both use ID 4

The jitter period (T1-T2) is typically one round-trip time, but the channel is **already usable** at T1.

## One-Round-Trip Opening (Non-Jitter Case)

**Scenario**: Transport A requests channel, Transport B has not requested it

```
Time  Transport A (requester)           Transport B (acceptor)
----  ------------------------------    ------------------------------
T0    requestChannel('data-sync')       (idle)
      No ID exists → send request
      Pending: { name, waiters }
      Sends chanReq(name) →

T1    (waiting for response)            ← Receives chanReq(name)
                                        Handler calls accept()
                                        Assigns ID: 5
                                        Creates channel, IDs: [5]
                                        Writes chanResp(id=5) to ring
                                        Sending ID: 5
                                        Sends chanResp(id=5) →

T2    ← Receives chanResp(id=5)         (idle)
      Creates channel, IDs: [5]
      RESOLVES LOCAL PROMISE ✓
      Sending ID: 5
```

**Key Observation**: In the non-jitter case, channel opens in one round-trip (T0→T1→T2).

**Optimization**: If Transport A later calls `requestChannel('data-sync')` again:
- Finds existing channel with ID `[5]`
- **Resolves immediately** without sending remote request
- **Zero-round-trip opening** for subsequent requests

## Auto-Rejection

**Scenario**: Transport receives channel request but no handler calls `event.accept()`

**Example**:
- Transport A sends `chanReq` for "data-sync"
- Transport B receives request, fires `newChannelRequest` event
- No handler calls `event.accept()` (or no handler registered)
- **Auto-rejected**: Transport B sends `chanResp` with `accept: false`

**Handling**:
- Transport B does not assign ID
- Transport B does not create channel
- Transport B sends rejection response
- Transport A receives rejection, rejects pending promise
- No channel created on either side

## Error Conditions

### Duplicate ID of Same Parity

**Scenario**: Transport receives acceptance with (different) ID of same parity as already assigned

**Example**:
- Transport A (ROLE_EVEN) has ID array `[4]`
- Receives `chanResp` with id=6 (even)
- This is a protocol violation (acceptor should never assign duplicate parity)

**Handling**:
- Throw `ProtocolViolationError` with reason 'DuplicateIdParity'
- Close the channel
- Emit transport-level error event

### Rejection After Acceptance

**Scenario**: One transport accepts, the other rejects

**Example**:
- Transport A requests channel "data-sync" from B (step 1)
- Transport B requests channel "data-sync" from A (step 2, nearly simultaneous)
- Transport A receives B's request, accepts it, assigns ID 4 (step 3)
- Transport B receives A's request, rejects it (no handler calls `event.accept()`) (step 4)
- Transport A receives rejection from B (step 5)
- Transport B receives acceptance from A with ID 4 (step 6)

**Handling**:
- **Transport A**: Keeps channel active (already accepted B's request and assigned ID 4)
  - ID array: `[4]`
  - Local waiters (from step 1) resolve successfully when A accepts B's request (step 3)
  - Later rejection from B (step 5) is ignored (channel already active)
  - Channel remains active because A accepted B's request (step 3)
- **Transport B**: Receives acceptance from A with ID 4 (step 6)
  - Creates channel with ID array: `[4]`
  - Local waiters (from step 2) resolve with channel
  - Channel is now active
- **Final state**: Both transports have channel with ID array `[4]`
  - Both can send and receive on ID 4
  - Channel is fully bidirectional

**Note**: This is a slightly pathological scenario. Since channels are now bidirectional, both transports should typically agree on which channels they will use. Requesting a channel you will reject, or rejecting a channel you will request, is unusual (unless for timeline/sequencing reasons).

### Both Transports Reject

**Scenario**: Both transports reject each other's requests (no handlers call `event.accept()`)

**Handling**:
- Neither transport creates a channel
- Both pending promises reject
- No IDs assigned
- No cleanup needed (no channel exists)

## Related Scenarios

- [`role-determination.md`](role-determination.md) - How ROLE_EVEN vs ROLE_ODD is determined
- [`channel-request.md`](channel-request.md) - Channel request process
- [`channel-acceptance.md`](channel-acceptance.md) - Channel acceptance process
- [`message-type-registration.md`](message-type-registration.md) - Similar jitter for message types

## Implementation Notes

### ID Storage

**Data Structure**:
```javascript
class Channel {
  #ids = [];  // Zero, one, or two-element array, sorted ascending
  
  get sendingId() {
    if (this.#ids.length === 0) {
      throw new Error('Channel has no assigned IDs');
    }
    return this.#ids[0];  // Always use lowest ID for sending
  }
  
  acceptsId(id) {
    return this.#ids.includes(id);  // Accept messages on any ID
  }
  
  addId(id) {
    if (!this.#ids.includes(id)) {
      this.#ids.push(id);
      this.#ids.sort((a, b) => a - b);  // Keep sorted ascending
    }
  }
}
```

### Request Handling with One-Round-Trip Optimization

**Data Structure**:
```javascript
class Transport {
  #pendingRequests = new Map();  // name → { promise, resolve, reject }
  #activeChannels = new Map();   // name → Channel
  #outputRing;                   // OutputRingBuffer
  
  async requestChannel(name, options) {
    // Check if channel already exists (active)
    const existingChannel = this.#activeChannels.get(name);
    if (existingChannel) {
      // ID already registered → resolve immediately (zero round-trips)
      return existingChannel;
    }
    
    // Check if request already pending
    if (this.#pendingRequests.has(name)) {
      // Add to waiters, return existing promise
      return this.#pendingRequests.get(name).promise;
    }
    
    // No ID exists yet → must send remote request
    const { promise, resolve, reject } = Promise.withResolvers();
    this.#pendingRequests.set(name, { promise, resolve, reject });
    
    // Send request (no ID in request)
    await this.#sendChannelRequest(name, options);
    
    return promise;
  }
  
  async #handleIncomingChannelRequest(name, config) {
    // Check if channel already exists
    let channel = this.#activeChannels.get(name);
    
    if (channel) {
      // Channel already exists (from previous acceptance)
      // Fire event with existing channel
      const event = new ChannelRequestEvent(name, channel, config);
      await this.dispatchEvent('newChannelRequest', event);
      
      if (event.accepted) {
        // Return existing channel's first ID
        await this.#sendChannelResponse(name, channel.sendingId, true);
      } else {
        // Auto-rejected (no accept called)
        await this.#sendChannelResponse(name, null, false);
      }
      return;
    }
    
    // No existing channel → fire event
    const event = new ChannelRequestEvent(name, null, config);
    await this.dispatchEvent('newChannelRequest', event);
    
    if (event.accepted) {
      // Assign ID and create channel
      const id = this.#assignNextId();  // Even or odd based on role
      channel = new Channel(name, [id], config);
      this.#activeChannels.set(name, channel);
      
      // Write acceptance to ring BEFORE resolving local waiters
      await this.#sendChannelResponse(name, id, true);
      
      // After acceptance written to ring, resolve any pending local request
      const pending = this.#pendingRequests.get(name);
      if (pending) {
        pending.resolve(channel);
        this.#pendingRequests.delete(name);
      }
    } else {
      // Auto-rejected (no accept called)
      await this.#sendChannelResponse(name, null, false);
      
      // Reject any pending local request
      const pending = this.#pendingRequests.get(name);
      if (pending) {
        pending.reject(new Error('Channel request rejected'));
        this.#pendingRequests.delete(name);
      }
    }
  }
  
  #handleChannelAcceptance(name, remoteId, config) {
    // Look up channel (should exist if we accepted incoming request)
    let channel = this.#activeChannels.get(name);
    
    if (channel) {
      // Channel exists → add remote ID (settlement)
      channel.addId(remoteId);
      
      // Pending request should already be resolved (in #handleIncomingChannelRequest)
      // But check anyway for edge cases
      const pending = this.#pendingRequests.get(name);
      if (pending) {
        pending.resolve(channel);
        this.#pendingRequests.delete(name);
      }
    } else {
      // No existing channel → create one with remote ID
      channel = new Channel(name, [remoteId], config);
      this.#activeChannels.set(name, channel);
      
      // Resolve pending request
      const pending = this.#pendingRequests.get(name);
      if (pending) {
        pending.resolve(channel);
        this.#pendingRequests.delete(name);
      } else {
        // Unexpected acceptance (no pending request, no existing channel)
        throw new ProtocolViolationError('UnexpectedAcceptance');
      }
    }
  }
  
  #handleChannelRejection(name, reason) {
    // Look up channel (might exist if we accepted incoming request)
    const channel = this.#activeChannels.get(name);
    
    if (channel) {
      // Channel exists (we accepted, they rejected)
      // Keep channel active (asymmetric state)
      // Pending request should already be resolved
    } else {
      // No channel (we requested, they rejected)
      // Reject pending request
      const pending = this.#pendingRequests.get(name);
      if (pending) {
        pending.reject(new Error(`Channel request rejected: ${reason}`));
        this.#pendingRequests.delete(name);
      }
    }
  }
}
```

### Automatic Settlement

The settlement is **automatic** and requires no explicit coordination:

1. **ID array is always sorted ascending** - Ensures consistent ordering
2. **First ID is always used for sending** - Ensures lowest ID is selected
3. **Both IDs are accepted for receiving** - Allows messages during jitter period
4. **Adding IDs is idempotent** - Duplicate adds have no effect
5. **IDs only come from acceptors** - Guarantees recipient recognizes the ID
6. **Local requests resolve after acceptance written to ring** - Ensures ordering guarantee
7. **No auto-accept** - If no handler calls `event.accept()`, it's auto-rejected

### Performance Considerations

- **Jitter duration**: Typically 1 round-trip time (milliseconds)
- **Channel usable during jitter**: Local promises resolve after acceptance written to ring
- **No message loss**: Messages sent during jitter are accepted on either ID
- **No coordination overhead**: Settlement happens automatically through ID sorting
- **Memory overhead**: Minimal (one extra integer per resource during jitter)
- **One-round-trip opening**: Key benefit of bidirectional channels
- **Zero-round-trip for existing channels**: Subsequent requests resolve immediately
- **Ordering guarantee**: Acceptance in ring before ID can be used

### Testing Strategies

**Unit Tests**:
- Test ID array sorting and selection
- Test duplicate ID detection (same parity)
- Test idempotent ID addition
- Test pending request tracking
- Test immediate resolution when channel exists
- Test auto-rejection when no handler calls `event.accept()`

**Integration Tests**:
- Simulate simultaneous requests with controlled timing
- Verify both transports settle to same sending ID
- Verify messages accepted on both IDs during jitter
- Test asymmetric acceptance/rejection scenarios
- Test both-reject scenario
- Verify one-round-trip opening (local promise resolves after acceptance written to ring)
- Verify zero-round-trip for existing channels
- Verify ordering guarantee (acceptance in ring before ID used)

**Timing Tests**:
- Measure jitter duration under various network conditions
- Verify settlement completes within expected timeframe
- Test behavior under extreme timing variations
- Measure time-to-usable for one-round-trip opening
- Verify acceptance reaches ring before promise resolution

### Security Considerations

- **ID validation**: Always validate received IDs match expected parity for acceptor's role
- **Duplicate detection**: Reject duplicate IDs of same parity as protocol violation
- **Resource limits**: Limit number of pending channel requests to prevent DoS
- **Timeout enforcement**: Reject requests that don't complete within timeout
- **Unexpected acceptances**: Reject acceptances with no corresponding pending request or active channel
- **Ordering guarantee**: Acceptance must reach ring before ID can be used (prevents race conditions)

### Message-Type Jitter

The same jitter mechanism applies to message-type registration:

- Message types also stored in zero/one/two-element ID array
- IDs only assigned by acceptor
- Local requests resolve immediately if ID already exists
- Acceptance must reach ring before local waiters resolved
- No auto-accept (auto-rejected if no handler calls `event.accept()`)
- Lowest ID used for sending
- Both IDs accepted for receiving
- Automatic settlement through sorting and selection

See [`message-type-registration.md`](message-type-registration.md) for details.

## Design Rationale

### Why Allow Jitter?

**Alternative**: Require explicit coordination to prevent simultaneous requests

**Problems with coordination**:
- Adds complexity and latency
- Requires additional protocol messages
- Creates potential deadlock scenarios
- Doesn't align with distributed systems principles

**Benefits of allowing jitter**:
- Simpler protocol (no coordination needed)
- Lower latency (no waiting for coordination)
- More robust (no deadlock scenarios)
- Automatic settlement (no explicit resolution needed)
- **Enables one-round-trip opening** (key benefit)

### Why Only Acceptor Assigns IDs?

**Guarantee**: The acceptor already recognizes the ID (because they assigned it)

**Simplicity**: No need for ID negotiation or confirmation

**Correctness**: Prevents ID collision scenarios

**Efficiency**: Single round-trip for ID assignment

**One-round-trip opening**: Local request can resolve after accepting remote request (after acceptance written to ring)

### Why Use Lowest ID?

**Consistency**: Both transports independently arrive at same ID through sorting

**Predictability**: Lower ID is always the "winner" (deterministic)

**Simplicity**: No need for additional tie-breaking logic

### Why Accept Both IDs?

**Robustness**: Messages sent during jitter period are not lost

**Simplicity**: No need to track jitter state or buffer messages

**Performance**: No message retransmission needed

### Why Resolve After Acceptance Written to Ring?

**Ordering guarantee**: Prevents using ID in message before acceptance is processed

**Correctness**: Ensures acceptance message is sent before ID can be used

**Race prevention**: Avoids potential race conditions with message ordering

**Simplicity**: Clear ordering semantics for implementation

### Why Auto-Reject Instead of Auto-Accept?

**Security**: Prevents unauthorized channel creation

**Explicit consent**: Requires explicit handler to accept channels

**Predictability**: Clear default behavior (reject unless explicitly accepted)

**Flexibility**: Allows custom acceptance logic in handlers

## Future Considerations

### Metrics and Monitoring

Consider tracking:
- Frequency of ID jitter occurrences
- Duration of jitter periods
- Number of messages sent on non-primary IDs
- Asymmetric acceptance/rejection rates
- One-round-trip opening success rate
- Zero-round-trip resolution rate (existing channels)
- Auto-rejection rate

### Optimization Opportunities

- **Jitter prediction**: Detect patterns in simultaneous requests
- **Proactive coordination**: Optionally coordinate for high-frequency resources
- **ID caching**: Cache frequently-used channel IDs for faster lookup

These optimizations should only be considered if jitter becomes a measurable performance issue in production.
