# Bidirectional-Channel And Even/Odd Role Update

Date: 2026-01-12

## Background

The original channel model (one or two independent, unidirectional parts) was originally conceived as a way to manage channel and message-type id assignment, with each direction just-in-time assigning ids to resources it would agree to use ("accept").

## Issues

- Bidirectional communication (common use case) requires managing two separate unidirectional channels
  - This increases user interface complexity and cognitive load
- Logically-related resources (such as a named channel or named message-type) will typically have directionally-different ids
  - This makes protocols more complex and difficult to reason about
  - If the wrong id is used in the wrong context, it might either be invalid (bad), or refer to an unrelated resource (worse)!
- Assignment of ids to named message-types is problematic
  - It's a channel-specific operation (not a transport-level operation) for established channels
  - The map / accept / reject protocol is inherently bidirectional by nature
    - The map request goes in one direction
    - The accept/reject response goes in the other
    - Both should be handled as in-channel traffic (in terms of storage resources and sending-turns)
  - There is currently no provision for in-channel reply messages (as are called for here) within a unidirectional channel
  - The only (established-transport) reply messages are ACK messages
    - They are transport-level (not in-channel)
    - They are only for flow-control (not a general response mechanism)

## Update

NOTE: This update constitutes a radical shift in both design and implementation.

- Each transport must assign itself a transport id using `crypto.randomUUID()`
- Each transport must announce its transport id as part of the transport connection handshake
- The transport with the lexicographically lower id must assign itself the "EVEN_ROLE" transport role, while the transport with the lexcicographically higher id must assign itself the "ODD_ROLE" transport role
- Channels will always be bidirectional, inherently supporting in-channel request/response-style communications
- Each channel or message-type may have zero, one, or two associated ids
  - These should be stored in a two-element array in ascending numeric order
- Either role (or both) may request channel creation or message-type registration by resource name (a string)
  - When a receiving transport "B" accepts a request from a sending transport "A":
    - If "B" already has an id registered for the resource, it returns the first one in the acceptance reply to transport "A"
    - Otherwise, "B" assigns its next sequential resource id (by type) and returns that in the acceptance reply to transport "A"
  - `EVEN_ROLE` transports assign sequential *even* resource ids (without regard to received odd ids)
  - `ODD_ROLE` transports assign sequential *odd* resource ids (without regard to received even ids)
- When a transport receives an acceptance, it adds the remotely-assigned id to the (named) resource
  - (Unless it already has an id of the same type (even or odd), in which case it is a protocol violation)
- When a transport receives a rejection, no (additional) id is assigned
  - The resource will have an id if accepted in the other direction (local waiters will already have resolved), otherwise it won't (and local waiters reject)
- When sending, the transport uses the first (lowest-numbered) id recorded for the asset at the time
  - A resource might briefly be referenced by two different ids ("id jitter") if both directions issue overlapping requests and the higher-valued id processing completes first, but the id should quickly "settle" (automatically, as a by-product of id sorting and selection) to the lowest assigned value after both request round-trips have completed and been processed
- User-created channels and message-types should always use a named mapping (never a direct, numeric by-pass)

The results:

- Both transports can reference a named resource after any request-accept round-trip (in either direction) completes (regardless of whether the request is made by one or both transports and their relative order/timing)
- Never bypassing mapped ids avoids potential issues with collisions between user-assigned and transport-assigned ids
- JSMAWS applet `self.polyTransportChannel` will correctly be a single, bidirectional channel object able to support a PTOC with the original client in the case of WebSocket connections (PTOCs, like all transports, require bidirectional communications)
  - (How one single exposed object was supposed to support bidirectional communications was never previously addressed)

### ACK, Channel Control, And Channel Data Header Types

No change, but some clarifications.

- ACKs: header type 0, *has* a channel, not *on* a channel
  - Used to manage flow-control, *post-processing*, for channel messages
- Channel control: header type 1
  - Used for "meta" messages about the associated channel itself (such as message-type request / accept / reject)
  - These are generated by the transport on behalf of stable channels when resources should count against the channel budget
- Channel data: header type 2
  - Used for data messages within the channel
  - Note: channel setup/close and transport stop messages are *data messages* on the *TCC* channel:
    - Control messages are "in-channel meta (i.e. non-data) messages" *about the associated channel*
    - A first-time channel doesn't exist yet, so you can't send a control message on it to create it ("chicken-and-egg problem")
    - TCC is a "meta **channel**" intended for this type of non-channel/pre-channel situation
    - Channel creation isn't a control message about TCC, is a message about some other, potentially not-yet-existent, resource
    - A channel-close message *would* be a legitimate control-message candidate, but to improve the chances of being able to close a wedged (e.g., no-remaining-channel-budget) channel gracefully, a TCC data message is used instead
    - Closing the TCC is a side effect of stopping the transport, but it's not considered an operation *on the TCC*

### Reserved Channels

- 0: "TCC" Transport control channel (meta channel for transport maintenance, channel setup/teardown)
  - Each transport includes its TCC receiving limits in the handshake
  - Only accessible within the transport implementation (no direct user access)
  - *Data messages* are used for new channel setup (the new channel is not yet established, and has no budget)
  - *Data messages* used for channel closure (in case the channel is unstable and not in-channel closable)
  - This channel "comes and goes" with the transport itself (it cannot be closed separately)
  - NOTE: Message-type mapping for *all channel **control** messages* should be based on the message-type mappings for the TCC channel
  - This should probably have a private-access symbol like `XP_CTRL_CHANNEL` (only accessible within transport implementation modules)
- 1: "C2C" Console-content/exception channel
  - Will be user-accessable via (configurable, not writable) channel symbol `PolyTransport.LOG_CHANNEL`
    - (The applet bootstrap will typically prevent applet access by removing this during environment sanitization)

### Transport Shutdown

- Uses data-format header on TCC with message-type `tranStop`
- A JSON body can be used to share progress between transports (should be kept very short)

### New-Channel Setup

- First mapped channel id = next even (even role) or odd (odd role) Math.max(minChannelId) from handshake
- Channel request / accept / reject use JSON-encoded channel *data* messages over the *TCC channel*
  - Message types: `chanReq` (request), `chanResp` (response - accept/reject)
- Channels are always bidirectional (unidirectional channel concept is removed)
- One channel object manages both directions and all relevant/related methods

### Channel Shutdown

- `beforeClose` and `closed` events like now
- No directional close anymore (entire channel is open or entire channel is closed)
- It seems reasonable that channel shutdown should still be able to function even if the channel itself becomes deadlocked, so this should be implemented (as *data messages*) on the *TCC channel*
  - Message type: `chanClose`

### Message-Type Registration Request / Accept / Reject

- These should be managed with JSON-encoded channel *control* messages directly on the associated channel
- Structure should support batch message-type registration / accept / reject
  - Message type `mesgTypeReq` (request)
  - `{ request: [type, ...] }`
    - (The transport will need to track pending out-bound requests for response validation)
  - Message type `mesgTypeResp` (response)
  - `{ response: { accept: { type: id, ...}, reject: [type, ...] } }`
- Message-type registration continues for the open lifetime of the channel as before

### Pre-Loaded TCC Message-Types

These message types, pre-loaded into the TCC message-type map, are shared between *TCC data messages* and *control messages* for *all channels*.

- 0: `tranStop` - transport shutdown initiation and progress
- 1: `chanReq` - channel setup request
- 2: `chanResp` - channel setup response (accept/reject)
- 3: `mesgTypeReq` - message-type registration request
- 4: `mesgTypeResp` - message-type registration response

### No Other Changes

All other requirements and behavior should remain as-is to the extent that they are compatible and consistent with this update.

- Channels that only need to send (user) data in one direction are still free to do so
- If the application design calls for strict enforcement of (user) data being sent in only one direction, the existing `newChunk` event can be used to implement this
- SendFlowControl and ReceiveFlowControl are still logically different functions
  - These classes should continue to operate as is
  - A channel will use an instance of each
- JSMAWS currently has no reliable transport system and is blocked waiting on PolyTransport
  - It will require a complete overhaul regardless of the PT implementation
  - Simplifying the user interface will likely reduce the integration effort
