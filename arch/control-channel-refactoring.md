# Control Channel Refactoring Plan

**Date**: 2026-03-11/12  
**Status**: [APPROVED]

## Executive Summary

**Problem**: ControlChannel and Transport have circular dependencies, duplicated state, and split responsibilities.

**Solution**: ControlChannel becomes a simple Channel with pre-loaded message types. Transport owns all channel lifecycle logic including the TCC reader loop. Channel de-chunks by default with `{ dechunk: false }` option for relay scenarios.

**Key Insight**: Default de-chunking improves usability (most common case), with opt-out for PTOC relay scenarios.

## Problem Statement

The current implementation has incorrect responsibility assignment between [`Transport`](../src/transport/base.esm.js) and [`ControlChannel`](../src/control-channel.esm.js), resulting in:

1. **Circular Dependencies**: Transport → ControlChannel → Transport
2. **Duplicated State**: Both classes store pending channel request state
3. **Split Responsibilities**: Channel lifecycle logic scattered across both classes
4. **Awkward Flow**: Local requests bounce between classes unnecessarily
5. **Confusing Ownership**: Unclear which class "owns" channel request logic

### Current Architecture Problems

**ControlChannel (lines 19-118)**:
- Stores `#pendingRequests` map (duplicate state)
- Has `requestChannel()` method that forwards to transport
- Has `#onChannelResponse()` that resolves promises
- Has reader loop that dispatches back to `transport.onChannelRequest()`

**Transport Base (lines 163, 334-418)**:
- Stores `pendingChannelRequests` map (duplicate state!)
- Has `requestChannel()` that creates promises then forwards to ControlChannel
- Has complex promise coordination logic
- Receives callbacks from ControlChannel via `onChannelRequest()`

**Data Flow Issues**:
```
Local Request:
  User → Transport.requestChannel() → ControlChannel.requestChannel() → wire

Remote Request:
  wire → ControlChannel reader → Transport.onChannelRequest() → event handlers

Response:
  wire → ControlChannel.#onChannelResponse() → resolve promise in ControlChannel
       → Transport.requestChannel() promise chain → create channel in Transport
```

This is **circular dependency hell** with **duplicated state** and **split responsibilities**.

## Proposed Solution

### Core Principles

1. **ControlChannel is just a Channel** with pre-loaded message types (no business logic, no reader loop)
2. **Transport owns all channel lifecycle logic** (requests, responses, creation, events)
3. **Channel de-chunks by default** (`{ dechunk: true }`) for usability
4. **Opt-out for relay scenarios** (`{ dechunk: false }`) enables PTOC relay without reassembly
5. **Remote request = remote approval** (channel ready immediately when local accepts remote request)
6. **Channel promise resolves when ready** (can be before remote response arrives)
7. **"First Accept or Last Reject" rule** (pending request lifecycle independent of channel lifecycle)
8. **Channel reopening**: Requesting a closed channel creates a new channel with the same name and ID (recovery from "wedged" channel)

### De-chunking Strategy

**Default Behavior (`dechunk: true`)**:
- Channel accumulates chunks until EOM
- `channel.read()` returns complete message
- Most common use case - simplifies application code
- TCC reader gets complete JSON messages automatically
- No manual chunk accumulation needed in readers

**Opt-Out for Relay (`dechunk: false`)**:
- Channel returns individual chunks
- Enables PTOC relay: read chunk → write chunk (no reassembly)
- Only needed for specialized use cases (relay, streaming)
- Reduces memory overhead for pass-through scenarios

**Chunking Model**:
- **At Transport Level**: Chunks from different channels can be interleaved
  - Example: `[Chan1-Chunk1, Chan2-Chunk1, Chan1-Chunk2, Chan2-Chunk2]`
- **At Channel Level**: Chunks from same message are never interleaved
  - Channel write queue ensures atomic multi-chunk sends: `[Chunk1, Chunk2, Chunk3+EOM]`
  - Each channel's reader sees only that channel's chunks in order

### New Responsibility Model

#### Transport Should Own:
1. **All channel request state** (`#pendingChannelRequests` map)
2. **TCC reader loop** (reads complete messages via default de-chunking)
3. **Channel request initiation** (`requestChannel()`)
4. **Channel request reception** (remote request handling)
5. **Channel response handling** (both local and remote)
6. **Channel creation and registration** (`#createChannel()`)
7. **Channel ID allocation** (`#nextChannelId`, increments by 2)
8. **Event emission** (`newChannel`)
9. **Promise resolution** (both local and remote)

#### ControlChannel Should Be:
1. **Just a regular Channel** with pre-loaded message types
2. **No business logic** - no state, no methods beyond Channel base class
3. **No reader loop** - Transport reads from it
4. **Message type pre-loading** - Constructor pre-loads TCC message type IDs

#### Channel Should Provide:
1. **Default de-chunking** (`dechunk: true`) - accumulate chunks until EOM
2. **Opt-out de-chunking** (`dechunk: false`) - return individual chunks
3. **Consistent API** - `read({ dechunk })` option

### Refactored Architecture

```javascript
// ControlChannel - Just a Channel with pre-loaded message types
class ControlChannel extends Channel {
  constructor (options) {
    super(options);
    this._get_();
    this.#preloadMessageTypes();
    // NO reader loop - Transport will read from this channel
  }
  
  /**
   * Pre-load channel's message-type id <-> name mappings
   * This avoids round-trip negotiation for foundational message types
   * @private
   */
  #preloadMessageTypes () {
    const _thys = this.#_;
    const types = _thys.messageTypes;
    for (const [id, name] of [
      TCC_DTAM_TRAN_STOP,
      TCC_DTAM_CHAN_REQUEST,
      TCC_DTAM_CHAN_RESPONSE,
      TCC_CTLM_MESG_TYPE_REG_REQ,
      TCC_CTLM_MESG_TYPE_REG_RESP
    ]) {
      types.set(id, name);
      types.set(name, id);
    }
  }
  
  // That's it! No other methods, no state, no reader loop
}

// Transport Base - Owns ALL channel lifecycle logic
class Transport {
  #pendingChannelRequests = new Map(); // name -> { channelPromise, channelResolve, channelReject, options }
  // NOTE: This map tracks OUR outgoing requests, not channel availability
  // Entry exists from when we send request until we receive response
  // Channel may be created (by accepting remote request) before we receive response
  
  // ============================================================
  // CONTROL CHANNEL READER (moved from ControlChannel)
  // ============================================================
  
  /**
   * Execute the control-channel reader loop
   * Reads TCC messages (de-chunked by default), parses JSON, handles messages
   * 
   * NOTE: No manual chunk accumulation needed - Channel de-chunks by default
   * 
   * @private
   */
  async #tccReader() {
    const _thys = this.#_;
    const tcc = _thys.channels.get(CHANNEL_TCC);
    const { logger } = _thys;
    
    for (;;) {
      try {
        // Read complete message (de-chunked by default)
        const message = await tcc.read();
        if (!message) break; // Channel closed
        
        const { messageTypeId, data, done } = message;
        const text = data?.length ? data.decode() : message.text;
        
        try {
          // Parse JSON data (already complete message thanks to default de-chunking)
          const parsed = JSON.parse(text);
          
          // Handle control messages
          switch (messageTypeId) {
            case TCC_DTAM_CHAN_REQUEST[0]:
              await this.#onChannelRequest(parsed);
              break;
            case TCC_DTAM_CHAN_RESPONSE[0]:
              await this.#onChannelResponse(parsed);
              break;
            case TCC_DTAM_TRAN_STOP[0]:
              await this.#onTransportStop(parsed);
              break;
            case TCC_CTLM_MESG_TYPE_REG_REQ[0]:
              await this.#onMessageTypeRegRequest(parsed);
              break;
            case TCC_CTLM_MESG_TYPE_REG_RESP[0]:
              await this.#onMessageTypeRegResponse(parsed);
              break;
            default:
              // Unknown message type - protocol violation
              logger.error(`PolyTransport protocol violation (unknown TCC message type ${messageTypeId}); stopping transport`);
              await this.stop();
          }
        } finally {
          // Always mark message as processed (enables backpressure)
          done();
        }
      } catch (err) {
        // Channel closed or error - exit reader loop
        break;
      }
    }
  }
  
  // ============================================================
  // PUBLIC API
  // ============================================================
  
  /**
   * Request a new channel (local request initiated by this side)
   * @param {string} name - Channel name
   * @param {Object} options - Channel options
   * @returns {Promise<Channel>} The requested channel
   */
  async requestChannel(name, options) {
    const _thys = this.#_;
    const { channels, state, pendingChannelRequests } = _thys;
    
    // 1. Validate transport state
    if (state !== Transport.STATE_ACTIVE) {
      throw new StateError('Transport is not active');
    }
    
    // 2. Check if channel already exists and is open
    const existing = channels.get(name);
    if (existing && existing.state === Channel.STATE_OPEN) {
      return existing;
    }
    
    // 3. Check if request already pending - return existing promise
    const pending = pendingChannelRequests.get(name);
    if (pending) {
      return pending.channelPromise;
    }
    
    // 4. Merge options with defaults
    const channelOptions = {
      maxBufferBytes: options.maxBufferBytes ?? _thys.maxBufferBytes,
      maxChunkBytes: options.maxChunkBytes ?? _thys.maxChunkBytes,
      lowBufferBytes: options.lowBufferBytes ?? _thys.lowBufferBytes
    };
    
    // 5. Create promise and store in #pendingChannelRequests
    const request = { options: channelOptions };
    request.channelPromise = new Promise((resolve, reject) => {
      request.channelResolve = resolve;
      request.channelReject = reject;
    });
    pendingChannelRequests.set(name, request);
    
    // 6. Send control message via TCC
    const tcc = channels.get(CHANNEL_TCC);
    const requestData = JSON.stringify({
      channelName: name,
      maxBufferBytes: channelOptions.maxBufferBytes,
      maxChunkBytes: channelOptions.maxChunkBytes
    });
    await tcc.write(TCC_DTAM_CHAN_REQUEST[0], requestData);
    
    // 7. Return promise
    // NOTE: Promise resolves as soon as channel is ready (or rejected)
    // This can happen locally (accepting remote request) before remote response arrives
    return request.channelPromise;
  }
  
  // ============================================================
  // PRIVATE IMPLEMENTATION
  // ============================================================
  
  /**
   * Handle incoming channel request (remote request from other side)
   * @private
   * @param {Object} request - Parsed request: { channelName, maxBufferBytes, maxChunkBytes }
   */
  async #onChannelRequest(request) {
    const { channelName, maxBufferBytes, maxChunkBytes } = request;
    const _thys = this.#_;
    const { channels, pendingChannelRequests } = _thys;
    
    // 1. Check if channel already exists
    const existing = channels.get(channelName);
    if (existing && existing.state === 'open') {
      // Channel already exists - send rejection
      const response = JSON.stringify({
        name: channelName,
        accepted: false
      });
      const tcc = channels.get(CHANNEL_TCC);
      await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);
      return;
    }
    
    // 2. Emit 'newChannel' event with accept/reject methods
    let accepted = false;
    const event = Object.freeze({
      channelName,
      remoteLimits: Object.freeze({ maxBufferBytes, maxChunkBytes }),
      accept: () => { accepted = true; },
      reject: () => { accepted = false; }
    });
    await this.dispatchEvent('newChannel', event);
    
    // 3. Check if channel was added while waiting for event handlers
    const existingAfterEvent = channels.get(channelName);
    
    // 4. Send response based on event handlers
    const tcc = channels.get(CHANNEL_TCC);
    if (accepted) {
      let channel, channelId;
      
      if (existingAfterEvent) {
        // Channel was created while waiting - use its existing ID
        channel = existingAfterEvent;
        channelId = channel.id;
      } else {
        // Create new channel with new ID
        channelId = _thys.nextChannelId;
        _thys.nextChannelId += 2; // Increment by 2 for even/odd separation
        
        channel = this.#createChannel(channelName, channelId, {
          localLimit: _thys.maxBufferBytes,
          remoteLimit: maxBufferBytes,
          maxChunkBytes: Math.min(_thys.maxChunkBytes, maxChunkBytes)
        });
      }
      
      // Send acceptance response
      const response = JSON.stringify({
        name: channelName,
        accepted: true,
        id: channelId,
        maxBufferBytes: _thys.maxBufferBytes,
        maxChunkBytes: _thys.maxChunkBytes
      });
      await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);
      
      // Resolve local pending request if exists
      // NOTE: Remote request = remote approval, so channel is ready now
      const pending = pendingChannelRequests.get(channelName);
      if (pending) {
        pending.channelResolve(channel);
        // DON'T delete pending request yet - we still need to receive response to OUR request
        // The pending request tracks OUR outgoing request lifecycle, not channel availability
      }
    } else {
      // Send rejection response
      const response = JSON.stringify({
        name: channelName,
        accepted: false
      });
      await tcc.write(TCC_DTAM_CHAN_RESPONSE[0], response);
      
      // DON'T reject local pending request here!
      // "First accept or last reject" rule: Even if we reject the remote request,
      // the remote might still accept OUR request (messages are in-order, so they
      // will see our request before our reject response).
      // We must wait for the response to OUR request to complete the lifecycle.
    }
  }
  
  /**
   * Handle incoming channel response (response to our local request)
   * @private
   * @param {Object} response - Parsed response: { name, accepted, id?, maxBufferBytes?, maxChunkBytes? }
   */
  async #onChannelResponse(response) {
    const { name, accepted, id, maxBufferBytes, maxChunkBytes } = response;
    const _thys = this.#_;
    const { channels, channelTokens, pendingChannelRequests } = _thys;
    
    // 1. Lookup pending request
    const pending = pendingChannelRequests.get(name);
    if (!pending) {
      // No pending request - protocol violation
      await this.dispatchEvent('protocolViolation', {
        type: 'unexpectedChannelResponse',
        channelName: name
      });
      return;
    }
    
    // 2. Handle response
    if (accepted) {
      // Check if channel already exists (created by accepting remote request)
      const existing = channels.get(name);
      if (existing) {
        // Channel was created by accepting remote request while we waited
        // Add the second role ID (perform ID switch if remote ID is lower)
        const token = channelTokens.get(existing);
        const ids = existing.idsRW(token);
        if (ids && !Transport.addRoleId(id, ids)) {
          const error = new Error('Failed to add role ID - duplicate or invalid');
          pending.channelReject(error);
          pendingChannelRequests.delete(name);
          return;
        }
        // Register new ID in channels map
        channels.set(id, existing);
        // NOTE: Promise already resolved when we accepted remote request
        // This response just adds the second ID
      } else {
        // Channel doesn't exist yet - create it now
        const channel = this.#createChannel(name, id, {
          localLimit: pending.options.maxBufferBytes,
          remoteLimit: maxBufferBytes,
          maxChunkBytes: Math.min(pending.options.maxChunkBytes, maxChunkBytes)
        });
        // Resolve promise with new channel
        pending.channelResolve(channel);
      }
    } else {
      // Request rejected by remote
      // Check if channel already exists (we accepted their request, they rejected ours)
      const existing = channels.get(name);
      if (existing) {
        // "First accept" rule: Channel exists because we accepted their request
        // Even though they rejected ours, the channel is valid and promise already resolved
        // Just clean up - don't reject the promise
      } else {
        // No channel exists - both sides rejected or we rejected and they rejected
        pending.channelReject(new Error('Channel request rejected by remote'));
      }
    }
    
    // 3. Clean up pending request (NOW we can delete it - response received)
    pendingChannelRequests.delete(name);
  }
  
  /**
   * Create and register a new channel
   * @private
   */
  #createChannel(name, id, options) {
    // Existing implementation (already in Transport)
    // ... (lines 215-248 from current base.esm.js)
  }
  
  /**
   * Start transport (called after handshake)
   * @protected
   */
  async onRemoteConfig(config) {
    const [thys, _thys] = [this.__this, this];
    if (_thys !== thys.#_) throw new Error('Unauthorized');
    
    // ... existing handshake logic ...
    
    // Initialize nextChannelId based on role
    const { role, minChannelId } = _thys;
    _thys.nextChannelId = (role === Transport.ROLE_EVEN) 
      ? toEven(minChannelId) 
      : toOdd(minChannelId);
    
    // ... create TCC and C2C channels ...
    
    // Start TCC reader loop (moved from ControlChannel)
    this.#tccReader();
    
    // ... rest of startup ...
  }
}
```

### Data Flow After Refactoring

```
Local Request (simple case):
  User → Transport.requestChannel() → TCC.write() → wire
  wire → TCC.read() (de-chunked) → Transport.#onChannelResponse()
       → create channel → resolve promise → return channel

Remote Request (simple case):
  wire → TCC.read() (de-chunked) → Transport.#onChannelRequest()
       → emit 'newChannel' event → event handlers accept/reject
       → create channel → TCC.write() → wire

Bidirectional Request (both sides request same channel simultaneously):
  Local: Transport.requestChannel() → pending promise → TCC.write() → wire
  Remote: wire → TCC.read() (de-chunked) → Transport.#onChannelRequest()
       → emit event → accept → create channel → resolve local promise (channel ready!)
       → TCC.write(response) → wire
       → pending request NOT deleted (still waiting for response to OUR request)
  Response: wire → TCC.read() (de-chunked) → Transport.#onChannelResponse()
       → channel already exists → add second role ID → delete pending request (lifecycle complete)

Bidirectional Request with Asymmetric Acceptance (we accept, they reject):
  Local: Transport.requestChannel() → pending promise → TCC.write() → wire
  Remote: wire → TCC.read() (de-chunked) → Transport.#onChannelRequest()
       → emit event → accept → create channel → resolve local promise (channel ready!)
       → TCC.write(response) → wire
       → pending request NOT deleted (still waiting for response to OUR request)
  Response: wire → TCC.read() (de-chunked) → Transport.#onChannelResponse()
       → response.accepted = false, but channel exists
       → "First accept" rule: channel is valid, promise already resolved
       → delete pending request (lifecycle complete, no rejection)

PTOC Relay (with dechunk: false):
  wire → channel.read({ dechunk: false }) → get chunk
       → relayChannel.write(chunk) → wire
  (No message reassembly - just pass chunks through)
```

## Benefits

1. **Single Source of Truth**: Only Transport tracks pending requests
2. **Clear Ownership**: Transport owns all channel lifecycle logic
3. **No Circular Calls**: Transport reads from TCC directly (one-way flow)
4. **Simpler ControlChannel**: Literally just a Channel with pre-loaded message types
5. **Better Encapsulation**: ControlChannel has no special behavior beyond message type pre-loading
6. **Easier to Understand**: All control message handling in one place (Transport)
7. **Reduced Coupling**: ControlChannel doesn't need to know about Transport internals
8. **Consistent Pattern**: Transport represents "application" reading TCC data messages (instead of a "self-reading" channel)
9. **Better Usability**: Default de-chunking simplifies application code
10. **Flexible for Relay**: Opt-out de-chunking enables efficient PTOC relay
11. **Correct Backpressure**: `message.done()` called after processing
12. **Correct Promise Resolution**: Channel promise resolves when ready (locally or remotely)

## Migration Strategy

### Phase 1: Implement Channel De-chunking
1. Add `dechunk` option to `Channel.read({ dechunk = true })`
2. When `dechunk: true` (default):
   - Accumulate chunks until EOM
   - Return complete message
3. When `dechunk: false`:
   - Return individual chunks
   - Existing behavior for relay scenarios

### Phase 2: Move Reader Loop to Transport
1. Add `#tccReader()` method to Transport (simplified - no manual chunk accumulation)
2. Add `#nextChannelId` field initialization in `onRemoteConfig()`
3. Move control message handling logic from ControlChannel to Transport:
   - `#onChannelRequest(parsed)` - handles remote requests
   - `#onChannelResponse(parsed)` - handles remote responses
   - `#onTransportStop(parsed)` - handles transport stop
   - `#onMessageTypeRegRequest(parsed)` - handles message type registration requests
   - `#onMessageTypeRegResponse(parsed)` - handles message type registration responses
4. Call `#tccReader()` from `onRemoteConfig()` after TCC creation

### Phase 3: Simplify ControlChannel
1. Remove `#pendingRequests` map from ControlChannel
2. Remove `requestChannel()` method from ControlChannel
3. Remove `#onChannelResponse()` method from ControlChannel
4. Remove `#startResponseReader()` method from ControlChannel
5. Keep only constructor with `#preloadMessageTypes()`

### Phase 4: Update Transport.requestChannel()
1. Remove call to `ControlChannel.requestChannel()`
2. Write directly to TCC using `tcc.write()`
3. Keep all promise resolution logic in Transport
4. Update to handle bidirectional request case (channel created locally before response)

### Phase 5: Testing
1. Update unit tests for Channel (test de-chunking with `dechunk` option)
2. Update unit tests for Transport (test channel lifecycle directly)
3. Update unit tests for ControlChannel (test only message type pre-loading)
4. Add integration tests for:
   - Simple local request → remote acceptance
   - Simple remote request → local acceptance
   - Bidirectional request (both sides request same channel)
   - Request rejection (local and remote)
   - ID switch when remote ID is lower
   - PTOC relay with `dechunk: false`
5. Verify all scenarios still work correctly

### Phase 6: Documentation
1. Update architecture.md with new responsibility model
2. Update requirements.md with de-chunking behavior
3. Update code comments to reflect new architecture
4. Note: Scenarios remain as-is for reference (significantly out of date)

## Implementation Checklist

- [ ] Phase 1: Implement Channel De-chunking
  - [ ] Add `dechunk` option to `Channel.read()`
  - [ ] Implement chunk accumulation when `dechunk: true`
  - [ ] Return individual chunks when `dechunk: false`
  - [ ] Test both modes
- [ ] Phase 2: Move reader loop to Transport
  - [ ] Add `#tccReader()` method (simplified)
  - [ ] Add `#nextChannelId` field initialization
  - [ ] Add `#onChannelRequest(parsed)`
  - [ ] Add `#onChannelResponse(parsed)`
  - [ ] Add `#onTransportStop(parsed)`
  - [ ] Add `#onMessageTypeRegRequest(parsed)`
  - [ ] Add `#onMessageTypeRegResponse(parsed)`
  - [ ] Call `#tccReader()` from `onRemoteConfig()`
- [ ] Phase 3: Simplify ControlChannel
  - [ ] Remove `#pendingRequests` map
  - [ ] Remove `requestChannel()` method
  - [ ] Remove `#onChannelResponse()` method
  - [ ] Remove `#startResponseReader()` method
  - [ ] Keep only constructor with `#preloadMessageTypes()`
- [ ] Phase 4: Update Transport.requestChannel()
  - [ ] Remove call to `ControlChannel.requestChannel()`
  - [ ] Write directly to TCC using `tcc.write()`
  - [ ] Keep all promise resolution in Transport
  - [ ] Handle bidirectional request case
- [ ] Phase 5: Update Tests
  - [ ] Update Channel unit tests (de-chunking)
  - [ ] Update Transport unit tests
  - [ ] Update ControlChannel unit tests
  - [ ] Add integration tests (simple local, simple remote, bidirectional, rejection, ID switch, PTOC relay)
- [ ] Phase 6: Update Documentation
  - [ ] Update architecture.md
  - [ ] Update requirements.md
  - [ ] Update code comments
  - [ ] Note scenarios are out of date (reference only)

## Risk Assessment

**Low Risk**:
- Changes are mostly internal refactoring
- Public API (`Transport.requestChannel()`) remains unchanged
- ControlChannel becomes simpler (less code = fewer bugs)
- Clearer separation of concerns
- Default de-chunking improves usability

**Medium Risk**:
- Complex promise coordination logic needs careful migration
- Bidirectional request handling (both sides request same channel) needs thorough testing
- ID switch logic (when remote ID is lower) needs careful implementation
- De-chunking implementation needs testing with both modes

**Mitigation**:
- Implement in phases with testing at each step
- Keep existing code until new code is fully tested
- Add comprehensive integration tests for edge cases
- Document all assumptions and edge cases
- Test with both byte-stream and object/postMessage transports
- Test PTOC relay with `dechunk: false`

## Open Questions

1. Should we add timeout handling for pending channel requests in Transport? [Maybe later]
2. Should we emit events for channel request failures (not just protocol violations)? [Maybe later]
3. Should `dechunk` be a channel constructor option or a read() option? [Yes - channel default (default true) + per-read override]

## Clarifications

### "First Accept or Last Reject" Rule

The pending request map (`#pendingChannelRequests`) tracks **OUR outgoing request lifecycle**, NOT channel availability. This is critical for correct bidirectional request handling.

**Key Principles**:

1. **Pending request exists from send to response**: Entry created when we send request, deleted only when we receive response to OUR request
2. **Channel may exist before response**: If we accept a remote request while waiting for response to our request, channel is created and promise resolved, but pending request remains
3. **First accept wins**: If either side accepts, the channel is valid - even if the other side rejects
4. **Messages are ordered**: Remote sees our request before our response to their request

**Scenarios**:

**Bidirectional Accept** (both sides accept):
- We send request → pending entry created
- Remote request arrives → we accept → channel created, promise resolved
- Pending entry NOT deleted (still waiting for response to OUR request)
- Response arrives (accepted) → add second role ID → delete pending entry

**Asymmetric Accept** (we accept, they reject):
- We send request → pending entry created
- Remote request arrives → we accept → channel created, promise resolved
- Pending entry NOT deleted (still waiting for response to OUR request)
- Response arrives (rejected) → channel already exists, promise already resolved
- "First accept" rule: channel is valid, don't reject promise → delete pending entry

**Asymmetric Accept** (they accept, we reject):
- We send request → pending entry created
- Remote request arrives → we reject → send rejection response
- Pending entry NOT deleted (still waiting for response to OUR request)
- Response arrives (accepted) → channel created, promise resolved → delete pending entry
- "First accept" rule: their acceptance creates valid channel despite our rejection

**Mutual Reject** (both sides reject):
- We send request → pending entry created
- Remote request arrives → we reject → send rejection response
- Pending entry NOT deleted (still waiting for response to OUR request)
- Response arrives (rejected) → no channel exists, reject promise → delete pending entry

**Why This Matters**:

Without this rule, we would delete the pending request when handling the remote request, which would:
1. Lose track of whether we initiated a request
2. Treat the response to our request as unsolicited (protocol violation)
3. Fail to add the second role ID in bidirectional accept case
4. Incorrectly reject the promise in asymmetric accept case

**Channel Reopening**: Requesting a closed channel creates a new channel with the same name and ID. This provides a way to attempt recovery from a "wedged" channel.

## Approval Required

This refactoring requires approval before implementation because:
1. It changes fundamental responsibility assignment
2. It affects multiple core classes
3. It requires careful migration to avoid breaking existing functionality

**Next Steps**: Review this plan and provide feedback or approval to proceed with implementation.

# User Notes 2026-03-17-A

- It was previously my expectation that chunks could only be interleaved at the transport level (with chunks from different channels being interleaved), not the channel level (ie chunks from different messages would not be interleaved)
- This does not adequately support an important "streaming" use case or reflect that the UI already allows a user to `write` several data sets, possibly with different message types, with none of the data sets having the `eom` option set
- The `write` method should support an addition `together: true` option to indicate whether chunks should be sent together in the same channel write-queue cycle (see below for additional details)
- Control-message chunks (`HDR_TYPE_CHAN_CONTROL`) will not be interleaved with other control-message chunks
  - Control messages do not support streaming or interleaving (with each other, they could be interleaved with data messages)
- Read should return `{ messageType, messageTypeId, text, data, dataSize, eom, done, process }`
- `messageType` is the message type *string* if the message-type id maps to one, else same as `messageTypeId`
- `messageTypeId` is the numeric message-type id used in transmission
- `text` the concatenation of textual (JS UTF-16) chunk data, if any (else omitted)
- `data` a VirtualBuffer containing concatenated Uint8 chunk data, if any (else omitted)
- `dataSize` (total bytes; effectively text.length * 2 + virtualBuffer.length)
- `eom` whether EOM flag was present in last chunk (always true if de-chunked)
- `done` is a closure to `flowControl.markComplete` on all original sequence numbers
- `process` will `try` its (possibly async) callback and `finally` call `done`
- Allow read option `withHeaders: false` to return a supplemental `headers` array (object-per-chunk) for testing/debugging:
- `headers`:
  - `channelId`
  - `messageTypeId`,
  - `dataSize`
  - `flags`
  - `sequence`
- Note: It is the *user's reponsibility* to make sure `done` is called, either directly or indirectly (i.e. via `process`)

## "Together" Cycles

(Conceptual outlines for comparison only)

- **Together: true** (single task, inner chunk iteration)
  - Queue channel-write task
    - Iterate over chunks
      - Wait for channel send-budget
      - Pass chunk to transport
- **Together: false** (outer chunk iteration, task-per-chunk)
  - Interate over chunks
    - Queue channel-write task
      - Wait for channel send-budget
      - Pass chunk to transport

## De-Chunking Process

### Control-Message Chunks

- `controlChunks` a Set of control-message chunk descriptors, in the order received: `{ header, data }`
- Control-message chunks will be accumulated until an `eom: true` chunk
- As final chunks arrive, messages are assembled, dispatched, and marked processed

### Data-Message Chunks

#### Data Structures

- `typeRemapping` will maintain a higher-id-to-lower-id mapping entry for message-type ids that settle to a lower value
- `dataChunks` a Set of data-message chunk descriptors, in the order received: `{ activeType, header, data, eom, next, nextEOM }`
  - `activeType` the currently-active message-type id (may have settled from the transmitted header value)
  - `header` the chunk header object
  - `data` the chunk data (JS UTF-16 text or VirtualBuffer-wrapped Uint8)
  - `eom` true if this is an eom chunk
  - `next` next same-type descriptor if not currently the last
  - `nextEOM` (only for eom chunks) next same-type eom descriptor if not currently the last
- `eomChunks` the subset of `dataChunks` for which eom is true
- `typeChain` is a Map of active-type to `{ read, readEOM, write, writeEOM }`
  - `read` is the first chunk descriptor in the type-chain
  - `readEOM` is the first eom chunk descriptor in the type-chain, if any
  - `write` is the last chunk descriptor in the type-chain
  - `writeEOM` is the last eom chunk descriptor in the type-chain, if any
- `allReader` (modify existing) containing `{ waiting: true, dechunk: true }`
  - `waiting` true if a reader is still actively waiting
  - `dechunk` true if the reader wants a complete message instead of chunks
- `filteredReaders` (modify existing) Map active type to `{ waiting: true, dechunk: true, resolve }`
  - `waiting` and `dechunk` as for `allReader`
- If a message-type id settles to a lower value, update the chunk descriptor objects and rekey the maps

#### Strategies

- If a message type id settles to a lower value, the remapping entry is added and all data structures, waiters, etc are updated to use/reference the new id
- **Adding (data) chunks**:
  - Chunk descriptors are always added to `dataChunks`
  - Descriptors are linked into the `typeChain` entry for the active type (`read`/`write` portion)
  - If the chunk is an eom chunk:
    - The descriptor is also added to `eomChunks`
    - It is linked into the `typeChain` entry (`readEOM`/`writeEOM` portion)
    - `nextEOM` is added at the previous `writeEOM` descriptor if there was one
- **Removing (data) chunks**:
  - Remove from `dataChunks`
  - Update associated `typeChain` (`read` moves to `next` or `null`)
  - If chunk is an eom chunk
    - Remove from `eomChunks`
    - Update associated `typeChain` (`readEOM` moves to `nextEOM` or `null`)
- **Unfiltered reader in message (`dechunk: true`) mode**:
  - (Get first complete message of any type)
  - If `eomChunks` is empty, wait for the `allReader` promise (with `dechunk: true`)
  - If `eomChunks` is not empty
    - Determine the active type of the first eom chunk (this is the first complete, queued message)
    - Use the `typeChain` Map entry for that active type to dequeue, assemble, and dispatch the first message
- **Unfiltered reader in chunk (`dechunk: false`) mode**:
  - (Get first chunk of any type)
  - If `dataChunks` is empty, set up the `allReader` promise (with `dechunk: false`)
  - If `dataChunks` is not empty, dequeue and dispatch the first chunk
- **Filtered reader in message mode**:
  - (Get first complete message from a list of possible types)
  - Start with an undefined current-best candidate
  - Examine the `readEOM` descriptor (if any) in the `typedChain` for each filter type
    - If the current-best candidate is undefined or the current candidate has a lower sequence
      - Set the current candidate as the new current-best candidate
  - If there is no current-best candidate, set up the `filteredReaders` promises (with `dechunk: true`)
  - If there is a current-best candidate, use its type and `typeChain` to dequeue, assemble, and dispatch the first message
- **Filtered reader in chunk mode**:
  - (Get first chunk from a list of possible types)
  - Start with an undefined current-best candidate
  - Examine the `read` descriptor in the `typedChain` for each filter type
    - If the current-best candidate is undefined or the current candidate has a lower sequence
      - Set the current candidate as the new current-best candidate
  - If there is no current-best candidate, set up the `filteredReaders` promises (with `dechunk: false`)
  - If there is a current-best candidate, dequeue and dispatch it
