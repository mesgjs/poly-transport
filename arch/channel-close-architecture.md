# Channel Close Architecture

**Date**: 2026-03-31  
**Status**: [APPROVED]

## Executive Summary

**Purpose**: Define the architecture for graceful and immediate channel closure in PolyTransport, ensuring synchronized completion, proper resource cleanup, and support for channel recovery.

**Key Principles**:
1. **Bidirectional closure**: Either side can initiate closure at any time
2. **No confirmation required**: `chanClose` is a notification, not a request
3. **Symmetric protocol**: Both sides follow the same closure logic
4. **Synchronized completion**: Both sides must send `chanClosed` before channel is fully closed
5. **No generation tracking**: Channels must complete stable, synchronized close before reopening

## Problem Statement

Channels need a robust closure mechanism that:
- Handles graceful shutdown (all data exchanged)
- Supports immediate shutdown (discard input to unwedge stuck channels)
- Manages cross-close scenarios (both sides close simultaneously)
- Ensures proper resource cleanup (buffers, message types, event handlers)
- Enables channel recovery (reopen after close)

## Channel States

Channels transition through five states during their lifecycle:

```
open → closing → localClosing/remoteClosing → closed
```

### State Definitions

- **`open`**: Normal operation, data flowing bidirectionally
- **`closing`**: Close initiated (locally or remotely), both sides working on closure (no `chanClosed` from either yet)
- **`localClosing`**: Remote sent `chanClosed`, we're still finishing our side (waiting on write ring, readers, `beforeClose` handlers)
- **`remoteClosing`**: We sent `chanClosed`, waiting for remote to finish their side
- **`closed`**: Both `chanClosed` messages exchanged, channel fully closed and synchronized

### State Transitions

From **`open`**:
- Receive `chanClose` OR call `close()` → **`closing`**

From **`closing`**:
- Send `chanClosed` → **`remoteClosing`**
- Receive `chanClosed` → **`localClosing`**

From **`remoteClosing`**:
- Receive `chanClosed` → **`closed`**

From **`localClosing`**:
- Send `chanClosed` → **`closed`**

## Close Parameters

The `close({ discard })` method accepts a single parameter:

### `discard: false` (Default - Graceful Closure)

**Purpose**: Normal closure with all data exchanged

**Behavior**:
- Send `chanClose` with `discard: false` flag
- Emit `beforeClose` event
- No new writes accepted (throw `StateError`)
- Wait to receive ACKs for all pending writes (`await flowControl.allWritesAcked()`)
- Wait for all reads to be consumed by application
- Wait for `beforeClose` event handlers to complete
- Send `chanClosed` when all conditions met

**Use Case**: Normal channel shutdown, ensure all data is processed

### `discard: true` (Immediate - Unwedge Channel)

**Purpose**: Discard input to unwedge a stuck channel for restart

**Behavior**:
- Send `chanClose` with `discard: true` flag
- Emit `beforeClose` event
- **Input side**: Treat read buffers and any new input as consumed (ACK immediately)
- **Output side**: Wait to receive ACKs for all pending writes (output must complete)
  - Data leaves sender's ring → becomes receiver's input → receiver discards it (but still ACKs)
  - Cannot discard from ring (can't determine what's written, can't splice channel data, can't reclaim budget)
- Cancel in-progress event handlers
- Send `chanClosed` after all ACKs received (indicating output complete)

**Use Case**: Unwedge a stuck channel for restart

**Rationale for Output Completion**:
- Cannot discard from ring buffer (impractical):
  - Can't determine what's already written
  - Can't splice out channel data from ring
  - Can't reclaim budget for discarded data
- Data must leave sender's ring → become receiver's input → receiver discards
- Receiver still ACKs (critical for transport budget restoration)

## Message Types

### `chanClose` (TCC Data Message)

**Purpose**: Initiate channel closure

**Data Fields**:
- `channelId`: Channel identifier
- `discard`: Boolean flag indicating immediate (true) or graceful (false) closure

**Behavior**:
- Can be sent by either side at any time
- Does not require confirmation
- Receiving side transitions to `closing` state
- Both sides can send simultaneously (cross-close)

### `chanClosed` (TCC Data Message)

**Purpose**: Signal completion of local closure conditions

**Data Fields**:
- `channelId`: Channel identifier

**Behavior**:
- Sent after all local closure conditions are met
- Receiving side transitions from `closing`/`remoteClosing` to `localClosing`/`closed`
- Channel reaches `closed` state when both sides have sent `chanClosed`

## Closure Conditions

### Graceful Closure (`discard: false`)

**Local conditions that must be met before sending `chanClosed`**:
1. ~~Write ring empties (all data sent)~~ [We only know if all of our ACKs have been received]
2. All ACKs received for our sent data
3. `beforeClose` event handlers complete

**Note**: We do NOT wait for reads to be consumed:
- We don't know what might still be coming from remote
- Remote manages their own write completion (mirrored condition)

### Discard Input Closure (`discard: true`)

**Local conditions that must be met before sending `chanClosed`**:
1. ~~Write ring empties (all data sent)~~
2. All ACKs received for our sent data
3. Input discarded (all read buffers treated as consumed, ACKs sent)
4. Event handlers cancelled

**Note**: Input (both buffered and new) is ACKed and discarded immediately, but output must complete normally.

## Cross-Close Scenarios

### Scenario 1: Both Graceful (`discard: false`)

**Flow**:
1. Both sides call `close({ discard: false })` simultaneously
2. Both send `chanClose` with `discard: false`
3. Both transition to `closing` state
4. Both receive remote's `chanClose`
5. Both remain in `closing` state
6. Both continue graceful shutdown process
7. Both wait for local conditions (may complete in any order)
8. Both send `chanClosed` (when local conditions met)
9. Both receive remote's `chanClosed` (may arrive during or after step 8)
10. Both transition to `closed` state
11. Both dispatch `closed` event
12. Both clear message type registrations

**Result**: Symmetric graceful closure, all data exchanged

### Scenario 2: Accelerated to Discard Input

**Flow**:
1. Local side calls `close({ discard: false })`
2. Send `chanClose` with `discard: false`
3. Transition to `closing` state
4. Begin graceful shutdown
5. Receive remote's `chanClose` with `discard: true`
6. **Switch to discard input mode**:
   - Discard input (treat read buffers as consumed)
   - Generate ACKs immediately
   - Release buffers
   - Cancel event handlers
   - Abandon graceful input processing
7. Wait for output completion (all ACKs received)
8. Send `chanClosed` message
9. Receive remote's `chanClosed` (if not already received)
10. Transition to `closed` state
11. Dispatch `closed` event
12. Clear message type registrations

**Rationale**: If remote wants to discard input (unwedge), we should too. Continuing graceful input processing is pointless.

**Result**: Input discarded (unwedged), output completed, channel ready for restart

### Scenario 3: Mixed - Remote Discard Input

**Flow**:
1. Receive remote's `chanClose` with `discard: true`
2. Transition to `closing` state
3. Discard input immediately
4. Local side calls `close({ discard: false })` during closure
5. Already in `closing` state with `discard: true`
6. Ignore graceful request, continue discard input mode
7. Send `chanClose` with `discard: true` (match remote's behavior)
8. Wait for output completion (all ACKs received)
9. Send `chanClosed` message
10. Receive remote's `chanClosed` (if not already received)
11. Transition to `closed` state
12. Dispatch `closed` event
13. Clear message type registrations

**Result**: Input discarded (remote's preference wins), output completed, channel ready for restart

## Message Type Clearing

Message type registrations are cleared when the channel reaches `closed` state:

**During `closing`/`localClosing`/`remoteClosing`**:
- Message types remain registered
- Graceful closure may still need to process incoming messages
- Type handlers may be needed for final data processing

**At `closed`**:
- Message types are cleared
- Channel is fully synchronized and inactive
- No more data will be processed
- Channel can be reopened with fresh request and message type registrations

## Reopening Closed Channels

After a channel reaches `closed` state, the channel can be reopened using the standard `requestChannel()` flow.

### Channel Record States

**Active Channel**:
- Full Channel object with all resources
- State: `open`, `closing`, `localClosing`, `remoteClosing`
- Stored in transport's channel map

**Nulled Channel Record**:
- Minimal record: `{ name, id, token, state: 'closed' }`
- No Channel object, no resources
- Stored in transport's channel map
- Preserves channel identity for reopening

### Reopening Process

When `requestChannel(name)` is called for a closed channel:

1. **Check channel map**: Find existing record by name
2. **Check state**:
   - If `state === 'closed'`: Channel can be reopened (continue)
   - If `state === 'open'`: Return existing channel (no reopening needed)
   - If state is `closing`, `localClosing`, or `remoteClosing`: Throw `StateError` (cannot reopen until fully closed)
3. **Extract identity**: Get `id` and `token` from nulled record
4. **Create pending request**: Standard `requestChannel()` flow (promise, timeout, etc.)
5. **Send channel request**: Standard `chanOpen` protocol with existing `id`
6. **Wait for acceptance**:
   - **Local acceptance** (we accept remote request): Create fresh Channel object with reused `id` and `token`, resolve promise
   - **Remote acceptance** (remote accepts our request): Create fresh Channel object with reused `id` and `token`, resolve promise
   - **Rejection**: Reject promise, keep nulled record
7. **Initialize fresh state**: New flow control, message types, event handlers
8. **Transition to `open`**: Channel starts fresh lifecycle

**Key Principle**: Channel object is only created when acceptance occurs (either local or remote), not when request is sent. This matches the standard channel creation flow.

**Use Case**: Recovery from "wedged" channel - close with `discard: true`, then reopen

## Error Handling

### StateError

Thrown when attempting operations incompatible with current channel state:

- **New writes on closing channel**: `channel.write()` throws `StateError`
- **New message type registrations on closing channel**: Throws `StateError`
- **Operations on closed channel**: Throws `StateError`
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

## Flow Control Integration

### Graceful Closure (`discard: false`)

**Output side**:
- Wait for all in-flight chunks to be ACK'd (output complete)
- ChannelFlowControl tracks in-flight bytes
- When in-flight bytes reach zero, output is complete

**Input side**:
- Wait for all received chunks to be consumed by application (input complete)
- ChannelFlowControl tracks buffer usage
- When buffer usage reaches zero, input is complete
- Generate and send final ACKs

### Discard Input Closure (`discard: true`)

**Input side**:
- Generate ACKs immediately for all received data (treat as consumed)
- ChannelFlowControl.recordConsumed() for all sequences
- Release buffers to pool
- No waiting for application consumption

**Output side**:
- Wait for all in-flight chunks to be ACK'd (must complete)
- Cannot discard from write ring (impractical)
- Data must leave sender's ring → become receiver's input → receiver discards (but still ACKs)

### Budget Management

**ACKs received during closure**:
- Restore budget (for consistency)
- Enable output completion

**ACKs sent during closure**:
- Restore remote's budget (critical!)
- Without ACKs, transport budget hemorrhages

**No new sends**:
- ChannelFlowControl rejects new data sends during closure
- Exception: ACK messages must still be sent (transport-level, not channel-level)

## Implementation Responsibilities

### Transport Responsibilities

1. **Track channel state**: Maintain state machine for each channel
2. **Enforce write restrictions**: Reject writes on closing channels
3. **Manage closure conditions**: Track write ring, ACKs, reads, event handlers
4. **Send closure messages**: Send `chanClose` and `chanClosed` at appropriate times
5. **Handle cross-close**: Detect and switch to discard input mode when remote sends `discard: true`
6. **Clear message types**: Clear registrations at `closed` state
7. **Dispatch events**: Fire `beforeClose` and `closed` events
8. **Release resources**: Release Channel object and all associated resources at `closed` state
9. **Maintain channel record**: Keep "nulled" record with name, ID, and token for reopening

### Channel Responsibilities

1. **Expose close API**: `close({ discard })` method
2. **Delegate to transport**: Channel.close() calls Transport._closeChannel()
3. **Provide state query**: `channel.state` property
4. **Event registration**: Support `beforeClose` and `closed` event listeners
5. **Resource cleanup**: Release buffers, clear internal state when closed

## State Transition Diagram

```
                                    open
                                      |
                                      | (receive chanClose OR call close())
                                      v
                                   closing
                                      |
                    +-----------------+-----------------+
                    |                                   |
                    | (send chanClosed)                 | (receive chanClosed)
                    v                                   v
              remoteClosing                       localClosing
                    |                                   |
                    | (receive chanClosed)              | (send chanClosed)
                    v                                   v
                  closed <-----------------------------+
```

## Key Design Decisions

### Why Synchronized Completion?

**Problem**: How do we know when both sides are done?

**Solution**: Both sides must send `chanClosed` before channel reaches `closed` state

**Benefits**:
- Clear synchronization point
- No ambiguity about channel state
- Enables safe reopening (no generation tracking needed)
- Prevents race conditions

### Why No Confirmation Required?

**Problem**: Should `chanClose` require a response?

**Solution**: No - `chanClose` is a notification, not a request

**Benefits**:
- Simpler protocol (fewer messages)
- Symmetric (both sides follow same logic)
- Handles cross-close naturally
- No timeout management needed

### Why Discard Input But Complete Output?

**Problem**: Why not discard output too?

**Solution**: Cannot discard from ring buffer (impractical)

**Rationale**:
- Can't determine what's already written to ring
- Can't splice out channel data from ring
- Can't reclaim budget for discarded data
- Data must leave sender's ring → become receiver's input → receiver discards

**Benefits**:
- Simpler implementation
- Maintains budget accounting integrity
- Receiver still ACKs (critical for transport budget)

### Why Accelerate to Discard Input?

**Problem**: What if one side wants graceful, other wants discard?

**Solution**: If remote sends `discard: true`, switch to discard input mode

**Rationale**:
- If remote wants to unwedge, continuing graceful input processing is pointless
- Remote's preference wins (they're trying to recover)
- Symmetric behavior (both sides discard input)

**Benefits**:
- Faster recovery from stuck channels
- Consistent behavior across both sides
- Simpler state management

## Testing Considerations

1. **State transitions**: Verify all state transition paths
2. **Cross-close scenarios**: Test all combinations of `discard` flags
3. **Acceleration**: Verify graceful → discard input transition
4. **Message type clearing**: Verify cleared at `closed`, not before
5. **Reopening**: Verify channel can be reopened after `closed`
6. **Error conditions**: Verify `StateError` thrown appropriately
7. **Late messages**: Verify handling during closure vs after `closed`
8. **Event dispatch**: Verify `beforeClose` and `closed` events fire correctly
9. **Flow control**: Verify budget restoration during closure
10. **Protocol violations**: Verify detection and handling

## Related Documents

- [`arch/scenarios/channel-closure.md`](scenarios/channel-closure.md) - Detailed closure scenarios
- [`arch/requirements.md`](requirements.md) - Channel lifecycle requirements
- [`arch/flow-control-model.md`](flow-control-model.md) - Flow control integration
- [`src/channel.esm.js`](../src/channel.esm.js) - Channel implementation
- [`src/transport/base.esm.js`](../src/transport/base.esm.js) - Transport base class

## Open Questions

1. Should we add timeout handling for closure completion? [Maybe later]
2. Should we emit events for closure failures (not just protocol violations)? [Maybe later]
3. Should `discard` be a channel constructor option or a close() parameter? [close() parameter - decided]

## Approval Required

This architecture document requires approval before implementation because:
1. It defines fundamental channel lifecycle behavior
2. It affects flow control integration
3. It impacts error handling and recovery strategies

**Next Steps**: Review this document and provide feedback or approval to proceed with implementation.

## Resource Release on Close

When a channel reaches `closed` state, all resources must be released:

**Released Resources**:
1. **Channel object**: The Channel instance itself is released
2. **Message type registrations**: Cleared from channel
3. **Event handlers**: Removed from channel
4. **Flow control state**: In-flight tracking, buffer usage, sequence numbers
5. **Read/write buffers**: Released to pool
6. **Internal data structures**: Chunk queues, type chains, etc.

**Retained Resources** (in "nulled" channel record):
1. **Channel name**: String identifier
2. **Channel ID**: Settled numeric ID (after any ID switch)
3. **Local token**: For insider access control

**Reopening Behavior**:
- Requesting a closed channel creates a **fresh Channel object**
- Reuses the same name, ID, and token
- Fresh message type registrations
- Fresh flow control state
- Fresh event handlers
- New channel lifecycle starts in `open` state

**Rationale**:
- Clean resource management (no leaks)
- Clear separation between closed and reopened channels
- Enables recovery from "wedged" channels
- Maintains channel identity (name + ID) for protocol consistency

## Additional Notes

- Attempts to close TCC channel 0 or C2C channel 1 should log a warning but otherwise be ignored
- Stopping the transport should skip attempting to close these channels in order to avoid generating the warning
