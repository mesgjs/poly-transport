# Channel Closure Scenario

## Overview

This scenario documents how channels are closed in PolyTransport, including graceful and immediate closure, cross-close handling, and state transitions.

## Key Principles

1. **Bidirectional closure**: Either side can initiate closure at any time
2. **No confirmation required**: `chanClose` is a notification, not a request
3. **Symmetric protocol**: Both sides follow the same closure logic
4. **Synchronized completion**: Both sides must send `chanClosed` before channel is fully closed
5. **No generation tracking**: Channels must complete stable, synchronized close before reopening

## Channel States During Closure

- **open**: Normal operation, data flowing
- **closing**: Close initiated (locally or remotely), both sides working on closure (no `chanClosed` from either yet)
- **localClosing**: Remote sent `chanClosed`, we're still finishing our side (waiting on write ring, readers, `beforeClose` handlers)
- **remoteClosing**: We sent `chanClosed`, waiting for remote to finish their side
- **closed**: Both `chanClosed` messages exchanged, channel fully closed and synchronized

## Close Parameters

The `close({ discard })` method accepts a single parameter:

- **`discard: true`** - Discard input (unwedge channel):
  - **Input side**: Treat read buffers as consumed (ACK immediately)
  - **Output side**: Wait for write ring to empty (output must complete)
    - Data leaves sender's ring → becomes receiver's input → receiver discards it (but still ACKs)
    - Cannot discard from ring (can't determine what's written, can't splice channel data, can't reclaim budget)
  - Cancel in-progress event handlers
  - Silently discard any new incoming data
  - Send `chanClose` with `discard: true` flag
  - Send `chanClosed` after write ring empty and ACKs sent
  - **Use case**: Unwedge a stuck channel for restart

- **`discard: false`** (default) - Graceful closure:
  - No new writes accepted (throw error)
  - Wait for write ring to empty and receive ACKs
  - Wait for all reads to be consumed by application
  - Wait for `beforeClose` event handlers to complete
  - Send `chanClose` with `discard: false` flag
  - Send `chanClosed` when all conditions met
  - **Use case**: Normal closure, all data exchanged

## Message Types

### chanClose (TCC Data Message)

Sent to initiate channel closure.

**Fields**:
- `channelId`: Channel identifier
- `discard`: Boolean flag indicating immediate (true) or graceful (false) closure

**Behavior**:
- Can be sent by either side at any time
- Does not require confirmation
- Receiving side transitions to `closing` state
- Both sides can send simultaneously (cross-close)

### chanClosed (TCC Data Message)

Sent when a side has completed its portion of the closure.

**Fields**:
- `channelId`: Channel identifier

**Behavior**:
- Sent after all local closure conditions are met
- Receiving side transitions from `closing`/`remoteClosing` to `localClosing`/`closed`
- Channel reaches `closed` state when both sides have sent `chanClosed`

## Detailed Scenarios

### Scenario 1: Graceful Closure (Initiator)

**Initial State**: Channel is `open`

**Steps**:

1. **User calls `channel.close({ discard: false })`**
   - Channel transitions to `closing` state
   - No new writes accepted (throw `ChannelStateError`)
   - Existing writes continue to be processed

2. **Send `chanClose` message**
   - Set `discard: false` flag
   - Message sent via TCC data channel

3. **Wait for local conditions**
   - Write ring empties (all data sent)
   - All ACKs received for our sent data
   - `beforeClose` event handlers complete
   - **Note**: We do NOT wait for reads to be consumed
     - We don't know what might still be coming from remote
     - Remote manages their own write completion (mirrored condition)

4. **Send `chanClosed` message** (when local conditions met)
   - If in `closing`: Transition to `remoteClosing` state
   - If in `localClosing`: Transition to `closed` state

5. **Receive remote's `chanClosed` message** (may arrive during step 3 or during or after step 4)
   - If in `closing`: Transition to `localClosing` state
   - If in `remoteClosing`: Transition to `closed` state

6. **When `closed` state is reached**
   - Dispatch `closed` event
   - Clear message type registrations
   - Channel remains registered but inactive

**Result**: Channel gracefully closed, all data exchanged

### Scenario 2: Graceful Closure (Receiver)

**Initial State**: Channel is `open`

**Steps**:

1. **Receive `chanClose` message from remote**
   - `discard: false` flag set
   - Channel transitions to `closing` state
   - No new writes accepted (throw `ChannelStateError`)

2. **Wait for local conditions**
   - Finish sending any queued data
   - Wait for ACKs for our sent data
   - Wait for `beforeClose` handlers to complete

3. **Send `chanClosed` message** (when local conditions met)
   - If in `closing`: Transition to `remoteClosing` state
   - If in `localClosing`: Transition to `closed` state

4. **Receive remote's `chanClosed` message** (may arrive during step 2 or during or after step 3)
   - If in `closing`: Transition to `localClosing` state
   - If in `remoteClosing`: Transition to `closed` state

5. **When `closed` state is reached**
   - Dispatch `closed` event
   - Clear message type registrations

**Result**: Channel gracefully closed, all data exchanged

### Scenario 3: Discard Input Closure (Initiator)

**Initial State**: Channel is `open`

**Steps**:

1. **User calls `channel.close({ discard: true })`**
   - Channel transitions to `closing` state
   - **Input side**: Treat read buffers as consumed
     - Generate ACKs for all received data
     - Release buffers to pool
   - **Output side**: Must wait for write ring to empty
     - Cannot discard from ring (impractical)
     - Data must leave ring → become receiver's input → receiver discards
   - Cancel in-progress event handlers

2. **Send `chanClose` message**
   - Set `discard: true` flag
   - Signals remote to discard their input too

3. **Wait for output completion**
   - Write ring empties (all data sent)
   - All ACKs received for our sent data
   - Silently discard any new incoming data

4. **Send `chanClosed` message** (when write ring empty and ACKs received)
   - If remote's `chanClosed` already received: Transition to `closed` state
   - Otherwise: Transition to `remoteClosing` state

5. **Receive remote's `chanClosed` message** (if not already received)
   - Transition from `remoteClosing` to `closed` state
   - Dispatch `closed` event
   - Clear message type registrations

**Result**: Input discarded (unwedged), output completed, channel ready for restart

### Scenario 4: Discard Input Closure (Receiver)

**Initial State**: Channel is `open`

**Steps**:

1. **Receive `chanClose` message from remote**
   - `discard: true` flag set
   - Channel transitions to `closing` state

2. **Discard input**
   - Treat read buffers as consumed
   - Generate ACKs for all received data
   - Release buffers to pool
   - Cancel event handlers

3. **Wait for output completion**
   - Finish sending any queued data (write ring must empty)
   - Wait for ACKs for our sent data
   - Silently discard any new incoming data

4. **Send `chanClosed` message** (when write ring empty and ACKs received)
   - If remote's `chanClosed` already received: Transition to `closed` state
   - Otherwise: Transition to `localClosing` state

5. **Receive remote's `chanClosed` message** (if not already received)
   - Transition from `localClosing` to `closed` state
   - Dispatch `closed` event
   - Clear message type registrations

**Result**: Input discarded (unwedged), output completed, channel ready for restart

### Scenario 5: Cross-Close (Both Graceful)

**Initial State**: Channel is `open`

**Steps**:

1. **Both sides call `close({ discard: false })` simultaneously**
   - Both send `chanClose` with `discard: false`
   - Both transition to `closing` state

2. **Both receive remote's `chanClose`**
   - Both remain in `closing` state
   - Both continue graceful shutdown process

3. **Both wait for local conditions** (may complete in any order with step 4)
   - Write ring empties
   - All ACKs received
   - `beforeClose` handlers complete

4. **Both send `chanClosed`** (when local conditions met)
   - If in `closing`: Transition to `remoteClosing` state
   - If in `localClosing`: Transition to `closed` state

5. **Both receive remote's `chanClosed`** (may arrive during step 3 or during or after step 4)
   - If in `closing`: Transition to `localClosing` state
   - If in `remoteClosing`: Transition to `closed` state

6. **When `closed` state is reached**
   - Both dispatch `closed` event
   - Both clear message type registrations

**Result**: Symmetric graceful closure, all data exchanged

### Scenario 6: Cross-Close (Accelerated to Discard Input)

**Initial State**: Channel is `open`

**Steps**:

1. **Local side calls `close({ discard: false })`**
   - Send `chanClose` with `discard: false`
   - Transition to `closing` state
   - Begin graceful shutdown

2. **Receive remote's `chanClose` with `discard: true`**
   - **Switch to discard input mode**
   - Discard input:
     - Treat read buffers as consumed
     - Generate ACKs immediately
     - Release buffers
   - Cancel event handlers
   - Abandon graceful input processing

3. **Wait for output completion**
   - Write ring must still empty (cannot discard from ring)
   - Wait for ACKs for our sent data
   - Silently discard any new incoming data

4. **Send `chanClosed` message** (when write ring empty and ACKs received)
   - If remote's `chanClosed` already received: Transition to `closed` state
   - Otherwise: Transition to `remoteClosing` state

5. **Receive remote's `chanClosed`** (if not already received)
   - Transition from `remoteClosing` to `closed` state
   - Dispatch `closed` event
   - Clear message type registrations

**Rationale**: If remote wants to discard input (unwedge), we should too. Continuing graceful input processing is pointless.

**Result**: Input discarded (unwedged), output completed, channel ready for restart

### Scenario 7: Cross-Close (Mixed - Remote Discard Input)

**Initial State**: Channel is `open`

**Steps**:

1. **Receive remote's `chanClose` with `discard: true`**
   - Transition to `closing` state
   - Discard input:
     - Treat read buffers as consumed
     - Generate ACKs immediately
     - Release buffers
   - Cancel event handlers

2. **Local side calls `close({ discard: false })` during closure**
   - Already in `closing` state with `discard: true`
   - Ignore graceful request, continue discard input mode
   - Send `chanClose` with `discard: true` (match remote's behavior)

3. **Wait for output completion**
   - Write ring must empty (cannot discard from ring)
   - Wait for ACKs for our sent data
   - Silently discard any new incoming data

4. **Send `chanClosed` message** (when write ring empty and ACKs received)
   - If remote's `chanClosed` already received: Transition to `closed` state
   - Otherwise: Transition to `localClosing` state

5. **Receive remote's `chanClosed`** (if not already received)
   - Transition from `localClosing` to `closed` state
   - Dispatch `closed` event
   - Clear message type registrations

**Result**: Input discarded (remote's preference wins), output completed, channel ready for restart

## State Transition Diagram

```
open
  |
  | (receive chanClose OR call close())
  v
closing
  |
  +-- (send chanClosed) --> remoteClosing
  |                              |
  |                              | (receive chanClosed)
  |                              v
  |                            closed
  |
  +-- (receive chanClosed) --> localClosing
                                   |
                                   | (send chanClosed)
                                   v
                                 closed
```

## Message Type Clearing

Message type registrations are cleared when the channel reaches `closed` state:

- **During `closing`/`localClosing`/`remoteClosing`**: Message types remain registered
  - Graceful closure may still need to process incoming messages
  - Type handlers may be needed for final data processing

- **At `closed`**: Message types are cleared
  - Channel is fully synchronized and inactive
  - No more data will be processed
  - Channel can be reopened with fresh message type registrations

## Reopening Closed Channels

After a channel reaches `closed` state:

1. **No generation tracking needed**: The synchronized `closed` state is sufficient
2. **Reopening requires new `chanOpen` request**: Standard channel request flow
3. **Fresh message type registrations**: Previous registrations were cleared at `closed`
4. **New channel lifecycle**: Reopened channel starts fresh in `open` state

## Error Handling

### ChannelStateError

Thrown when attempting operations incompatible with current channel state:

- **New writes on closing channel**: `channel.write()` throws `ChannelStateError`
- **New message type registrations on closing channel**: Throws `ChannelStateError`
- **Operations on closed channel**: Throws `ChannelStateError`
- **Duplicate close**: Calling `close()` on already-closing channel is idempotent (no error)
- **Error includes context**: State information and operation attempted

### Late Data Messages

**During graceful closure** (`discard: false`):
- Incoming data messages are processed normally
- Application must consume them before closure completes

**During discard input closure** (`discard: true`):
- Incoming data messages are silently discarded
- Still ACK'd (critical for transport budget!)
- No error, no application processing

### Protocol Violations

**After `closed` state**:
- Receiving data messages on closed channel is a `ProtocolViolationError`
- Receiving duplicate `chanClosed` is a `ProtocolViolationError`
- Transport should emit `protocolViolation` event and take corrective action

## Implementation Notes

### Transport Responsibilities

1. **Track channel state**: Maintain state machine for each channel
2. **Enforce write restrictions**: Reject writes on closing channels
3. **Manage closure conditions**: Track write ring, ACKs, reads, event handlers
4. **Send closure messages**: Send `chanClose` and `chanClosed` at appropriate times
5. **Handle cross-close**: Detect and switch to discard input mode when remote sends `discard: true`
6. **Clear message types**: Clear registrations at `closed` state
7. **Dispatch events**: Fire `beforeClose` and `closed` events

### Channel Responsibilities

1. **Expose close API**: `close({ discard })` method
2. **Delegate to transport**: Channel.close() calls Transport._closeChannel()
3. **Provide state query**: `channel.state` property
4. **Event registration**: Support `beforeClose` and `closed` event listeners

### Flow Control Integration

1. **Graceful closure** (`discard: false`):
   - Wait for all in-flight chunks to be ACK'd (output complete)
   - Wait for all received chunks to be consumed by application (input complete)
   - Generate and send final ACKs

2. **Discard input closure** (`discard: true`):
   - **Input**: Generate ACKs immediately for all received data (treat as consumed)
   - **Output**: Wait for all in-flight chunks to be ACK'd (must complete)
   - Cannot discard from write ring (impractical - can't determine what's written, can't splice, can't reclaim budget)
   - Data must leave sender's ring → become receiver's input → receiver discards (but still ACKs)

3. **Budget management**:
   - ACKs received during closure restore budget (for consistency)
   - ACKs sent during closure restore remote's budget (critical!)
   - Without ACKs, transport budget hemorrhages

4. **No new sends**:
   - SendFlowControl rejects new data sends during closure
   - Exception: ACK messages must still be sent (transport-level, not channel-level)

## Testing Considerations

1. **State transitions**: Verify all state transition paths
2. **Cross-close scenarios**: Test all combinations of `discard` flags
3. **Acceleration**: Verify graceful → discard input transition
4. **Message type clearing**: Verify cleared at `closed`, not before
5. **Reopening**: Verify channel can be reopened after `closed`
6. **Error conditions**: Verify `ChannelStateError` thrown appropriately
7. **Late messages**: Verify handling during closure vs after `closed`
8. **Event dispatch**: Verify `beforeClose` and `closed` events fire correctly

## Related Scenarios

- [`channel-request.md`](channel-request.md) - Channel creation and request handling
- [`channel-acceptance.md`](channel-acceptance.md) - Channel acceptance and rejection
- [`message-type-registration.md`](message-type-registration.md) - Message type lifecycle (TODO)
- [`transport-shutdown.md`](transport-shutdown.md) - Transport-level shutdown (closes all channels)

## References

- [`arch/requirements.md`](../requirements.md) - Channel lifecycle requirements
- [`src/transport/base.esm.js`](../../src/transport/base.esm.js) - Transport base class (TODO: channel closure implementation)
- [`src/channel.esm.js`](../../src/channel.esm.js) - Channel class (TODO: implementation)
