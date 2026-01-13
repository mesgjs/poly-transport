# Transport Shutdown Scenario

## Overview

This scenario describes the complete process of gracefully stopping a PolyTransport instance, including channel cleanup, event dispatch, timeout handling, and resource release.

**Important**: As of 2026-01-12, all channels are bidirectional (see [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)). Channels close as complete units, not in separate directions.

**Nomenclature Note**: As of 2026-01-12-C, transports **stop** (not "close"). Channels still **close**. See requirements.md:1217-1228.

## Preconditions

- Transport is in `started` state (`#started === true`)
- Transport is not already stopped (`#stopped === false`)
- Zero or more channels are active
- Message processing loop is running
- Buffer pool and output ring buffer are allocated

## Actors

- **Application Code**: Initiates transport closure
- **Transport Base Class** ([`src/transport/base.esm.js`](../../src/transport/base.esm.js)): Orchestrates shutdown sequence
- **Transport Implementation**: Specific transport subclass (HTTP, WebSocket, Worker, Pipe, Nested)
- **Channel**: Individual channel instances (not yet implemented)
- **SendFlowControl** ([`src/flow-control.esm.js`](../../src/flow-control.esm.js)): Manages outbound flow control
- **ReceiveFlowControl** ([`src/flow-control.esm.js`](../../src/flow-control.esm.js)): Manages inbound flow control
- **OutputRingBuffer** ([`src/output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js)): Output buffer cleanup
- **BufferPool** ([`src/buffer-pool.esm.js`](../../src/buffer-pool.esm.js)): Buffer release
- **Eventable**: Event handling infrastructure

## Step-by-Step Sequence

### 1. Initiate Transport Shutdown

**Action**: Application calls `stop()` to begin shutdown
**Responsible**: Application Code, Transport Base
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:89)

```javascript
await transport.stop({
  discard: false,  // false = graceful, true = immediate
  timeout: 5000,   // Optional timeout in milliseconds
});
```

**Options**:
- `discard`: If `true`, discard pending data and stop immediately; if `false`, flush pending data first
- `timeout`: Maximum time to wait for graceful stop (in milliseconds)

**Validation**:
- If `#stopped === true`, return immediately (already stopped, idempotent)

**State Changes**:
- None yet (stop is multi-step process)

### 2. Dispatch `beforeStopping` Event (Transport Level)

**Action**: Notify handlers that transport is about to stop
**Responsible**: Transport Base, Eventable
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:97)

```javascript
await this._dispatchEvent('beforeStopping', {});
```

**Event Details**:
- **Type**: `'beforeStopping'`
- **Detail**: `{}` (empty object)
- **Timing**: Before any channels are closed
- **Purpose**: Allow handlers to perform cleanup, save state, or cancel pending operations

**Handler Execution**:
- All registered handlers are awaited sequentially (Eventable behavior)
- Handlers can be async functions
- Errors in handlers are logged but don't prevent stop

**Use Cases**:
- Save pending state to persistent storage
- Cancel pending operations
- Log closure event
- Notify other components

### 3. Close All Channels

**Action**: Close each active channel
**Responsible**: Transport Base, Channel
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:100-107)

```javascript
const channelClosePromises = [];
for (const channel of this.#channels.values()) {
  channelClosePromises.push(
    channel.close({ discard, timeout }).catch(err => {
      this.#logger.error('Error closing channel:', err);
    })
  );
}
```

**Channel Closure Options**:
- `discard`: Passed through from transport `stop()` options
- `timeout`: Passed through from transport `stop()` options

**Parallel Closure**:
- All channels close concurrently (not sequentially)
- Errors in individual channel closures are logged but don't prevent other channels from closing
- Each channel follows its own closure sequence (see Channel Closure Sequence below)

**Error Handling**:
- Channel closure errors are caught and logged
- Transport closure continues even if some channels fail to close

### 4. Channel Closure Sequence (Per Channel)

**Action**: Each channel performs its own shutdown  
**Responsible**: Channel (not yet implemented)

#### 4a. Dispatch Channel `beforeClosing` Event

**Event Details**:
- **Type**: `'beforeClosing'`
- **Detail**: `{}` (empty object, no direction since channels are bidirectional)
- **Timing**: Before channel stops accepting new data
- **Purpose**: Allow handlers to perform channel-specific cleanup

#### 4b. Stop Accepting New Data

**For Bidirectional Channel**:
- Stop accepting new `write()` calls
- Stop processing incoming chunks
- Optionally discard pending writes and unprocessed chunks (if `discard === true`)

#### 4c. Flush Pending Data (If Graceful)

**If `discard === false`**:
- Wait for all pending writes to complete
- Send any buffered data
- Wait for ACKs if flow control requires it

**If `discard === true`**:
- Discard all pending writes immediately
- Clear send and receive buffers

#### 4d. Send Channel Close Message

**Action**: Send close message to remote via TCC
**Message Type**: TCC data message (type 2) with message-type `chanClose`
**Purpose**: Notify remote that channel is closing

**Close Message Format** (per [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md)):
```javascript
{
  // Sent as TCC data message (type 2)
  // Message-type: 'chanClose' (TCC message-type mapping)
  "channelId": [4, 5],  // ID array for the closing channel
  "reason": "graceful shutdown"  // Optional reason
}
```

**Note**: Channel close uses TCC data messages (not channel control messages) to ensure closure can proceed even if the channel itself is wedged or has no remaining budget.

#### 4e. Wait for Remote Close Acknowledgment

**Action**: Wait for remote to acknowledge closure  
**Timeout**: Use channel `timeout` option

**State Transitions** (for bidirectional channel as a whole):
- `open` → `closing` (when close initiated)
- `closing` → `localClosing` (if remote signals done before local finishes flushing/`beforeClose`)
- `closing` → `remoteClosing` (if local done flushing/`beforeClose` but remote not signaled yet)
- `localClosing` → `closed` (when local finishes after remote signaled)
- `remoteClosing` → `closed` (when remote signals after local finished)
- `closing` → `closed` (if both sides complete simultaneously [can't happen - JS context is single-threaded])

#### 4f. Release Channel Resources

**Action**: Clean up channel-specific resources  
**Resources**:
- SendFlowControl: Clear in-flight chunk tracking
- ReceiveFlowControl: Clear received chunk tracking
- Pending read/write promises: Reject with closure error
- Event listeners: Remove all handlers

#### 4g. Dispatch Channel `closed` Event

**Event Details**:
- **Type**: `'closed'`
- **Detail**: `{}` (empty object, no direction since channels are bidirectional)
- **Timing**: After channel is fully closed
- **Purpose**: Notify handlers that channel is closed

**State Changes**:
- Channel state transitions to `closed`
- Channel remains registered in transport's `#channels` map (per requirements.md:700-702)
- Channel can be reopened later (will reuse same ID array)

### 5. Wait for All Channels to Close (With Timeout)

**Action**: Wait for all channel closure promises to resolve
**Responsible**: Transport Base
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:110-121)

```javascript
if (timeout) {
  let timer;
  await Promise.race([
    Promise.all(channelClosePromises),
    new Promise((_, reject) =>
      timer = setTimeout(() => reject(new Error('Close timeout')), timeout)
    )
  ]);
  clearTimeout(timer);
} else {
  await Promise.all(channelClosePromises);
}
```

**Timeout Behavior**:
- If `timeout` is specified and expires, reject with `Error('Close timeout')`
- If `timeout` is not specified, wait indefinitely for all channels to close
- Timeout applies to the entire channel closure process, not individual channels

**Error Handling**:
- Timeout error propagates to caller
- Individual channel errors are already caught and logged (step 3)

### 6. Stop Transport Implementation

**Action**: Subclass performs transport-specific cleanup
**Responsible**: Transport Implementation
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:124), subclass `_stop()` method

```javascript
await this._stop();
```

**Expected Actions** (per requirements):
- **For byte-stream transports** (HTTP, WebSocket, Pipe, Nested):
  1. Flush output ring buffer (if graceful)
  2. Close underlying connection (socket, pipe, nested channel)
  3. Stop message processing loop
  4. Release output ring buffer
  5. Release buffer pool buffers
  
- **For Worker transport**:
  1. Send final messages (if graceful)
  2. Remove `postMessage` handler
  3. Release transferred buffers

**Resource Cleanup**:
- Output ring buffer: Release all reservations, zero buffer
- Buffer pool: Release all acquired buffers
- Pending operations: Cancel or complete
- Event listeners: Remove transport-specific handlers

### 7. Mark Transport as Stopped

**Action**: Update transport state
**Responsible**: Transport Base
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:126)

```javascript
this.#stopped = true;
```

**State Changes**:
- `#stopped = true`
- Transport can no longer be started or used
- All subsequent operations will throw `Error('Transport is stopped')`

### 8. Dispatch `stopped` Event (Transport Level)

**Action**: Notify handlers that transport is stopped
**Responsible**: Transport Base, Eventable
**Code Location**: [`Transport.stop()`](../../src/transport/base.esm.js:129)

```javascript
await this._dispatchEvent('stopped', {});
```

**Event Details**:
- **Type**: `'stopped'`
- **Detail**: `{}` (empty object)
- **Timing**: After transport is fully stopped
- **Purpose**: Final notification that transport is stopped

**Handler Execution**:
- All registered handlers are awaited sequentially
- Handlers can be async functions
- Errors in handlers are logged but don't affect stop (already stopped)

**Use Cases**:
- Log stop completion
- Notify other components
- Clean up external resources
- Update UI state

### 9. Return from `stop()`

**Action**: Promise resolves, indicating successful stop
**Responsible**: Transport Base

**Return Value**: `Promise<void>` resolves

**Possible Rejections**:
- Timeout error (if timeout specified and exceeded)
- Transport-specific errors from `_stop()`
- Other unexpected errors

## Postconditions

- Transport is in `stopped` state (`#stopped === true`)
- All channels are closed (but remain registered per requirements.md:700-702)
- All event handlers have been notified
- All resources are released:
  - Output ring buffer released
  - Buffer pool buffers released
  - Underlying connection closed
  - Message processing loop stopped
- Transport cannot be restarted (stop is permanent)

## Error Conditions

### Timeout Errors
- **Stop timeout**: If `timeout` specified and channel closure exceeds it
- **Behavior**: Reject with `Error('Stop timeout')`
- **Recovery**: Force-close remaining channels, continue with transport stop

### Channel Closure Errors
- **Individual channel errors**: Logged but don't prevent other channels from closing
- **Behavior**: Log error, continue with other channels
- **Recovery**: Best-effort closure of remaining channels

### Transport-Specific Errors
- **Connection close errors**: Errors closing underlying connection
- **Behavior**: Propagate to caller
- **Recovery**: Transport is marked stopped regardless

### Resource Release Errors
- **Buffer release errors**: Errors releasing buffers or ring buffer
- **Behavior**: Log error, continue with stop
- **Recovery**: Best-effort cleanup, mark transport stopped

## Related Scenarios

- [`transport-initialization.md`](transport-initialization.md) - Transport startup
- [`channel-closure.md`](channel-closure.md) - Individual channel closure
- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - Ring buffer cleanup
- [`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md) - Buffer pool cleanup

## Implementation Notes

### Current Implementation Status

**✅ Implemented** (in [`src/transport/base.esm.js`](../../src/transport/base.esm.js)):
- Transport `stop()` method with options
- `beforeStopping` and `stopped` event dispatch
- Parallel channel closure with error handling
- Timeout support for channel closure
- State management (`#stopped` flag)
- Idempotent stop (returns immediately if already stopped)

**❌ Not Yet Implemented**:
- Channel class and `channel.close()` method
- Channel closure sequence (steps 4a-4g)
- Transport-specific `_stop()` implementations
- Output ring buffer cleanup in `_stop()`
- Buffer pool cleanup in `_stop()`
- Channel close messages in protocol (TCC `chanClose`)

### Discrepancies Between Requirements and Implementation

1. **Channel Closure**: Requirements specify detailed channel closure sequence, but no Channel class exists yet.

2. **Close Messages**: Channel close uses TCC data messages with message-type `chanClose` (per [`arch/bidi-chan-even-odd-update.md`](../bidi-chan-even-odd-update.md:108-109)), but protocol implementation doesn't include this yet.

3. **Resource Cleanup**: Requirements specify buffer and ring buffer cleanup, but `_stop()` implementations don't exist yet.

4. **Force-Close on Timeout**: Current implementation rejects on timeout but doesn't force-close remaining channels.

5. **Channel State Management**: Channels remain registered after closure (per requirements.md:700-702), but Channel class doesn't exist yet to manage state transitions.

### Key Design Decisions

1. **Idempotent Stop**: Calling `stop()` on already-stopped transport returns immediately without error.

2. **Parallel Channel Closure**: All channels close concurrently for faster shutdown.

3. **Error Isolation**: Individual channel closure errors don't prevent other channels from closing.

4. **Timeout Scope**: Timeout applies to entire channel closure process, not individual channels.

5. **Event Order**: `beforeStopping` → channel closures → `stopped` (requirements.md:313-317).

6. **Graceful vs Discard**: `discard` option controls whether pending data is flushed or discarded.

7. **Permanent Stop**: Once stopped, transport cannot be restarted (would need new instance).

### Testing Considerations

- Test graceful stop (discard=false) with pending data
- Test immediate stop (discard=true) discarding pending data
- Test timeout behavior (both with and without timeout)
- Test stop with zero channels
- Test stop with multiple channels
- Test stop with channel errors
- Test idempotent stop (calling stop() twice)
- Test event handler execution order
- Test resource cleanup (ring buffer, buffer pool)
- Test stop while channels are actively sending/receiving

### Security Considerations

1. **Resource Cleanup**: All resources must be released to prevent leaks:
   - Output ring buffer must be zeroed
   - Buffer pool buffers must be released
   - Pending operations must be cancelled

2. **Data Flushing**: Graceful stop must ensure all data is sent before stopping (unless timeout expires).

3. **Timeout Enforcement**: Timeout must be enforced to prevent indefinite hangs.

4. **Error Handling**: Errors during stop must not leave transport in inconsistent state.

### Performance Considerations

1. **Parallel Closure**: Closing channels concurrently reduces total shutdown time.

2. **Timeout Tuning**: Timeout should be tuned based on expected data volume and network latency.

3. **Graceful vs Immediate**: Immediate stop (discard=true) is faster but loses pending data.

4. **Event Handler Performance**: Slow event handlers can delay stop; consider timeout for handlers.

5. **Resource Release**: Buffer release should be fast (already implemented in BufferPool).

## Event Sequence Diagram

```
Application
    │
    ├─► transport.stop({ discard, timeout })
    │
Transport Base
    │
    ├─► Dispatch 'beforeStopping' event (transport level)
    │   └─► Await all handlers
    │
    ├─► For each channel (parallel):
    │   │
    │   ├─► channel.close({ discard, timeout })
    │   │   │
    │   │   ├─► Dispatch 'beforeClosing' event (channel level)
    │   │   │   └─► Await all handlers
    │   │   │
    │   │   ├─► Stop accepting new data
    │   │   │
    │   │   ├─► Flush pending data (if graceful)
    │   │   │
    │   │   ├─► Send close message to remote
    │   │   │
    │   │   ├─► Wait for remote acknowledgment
    │   │   │
    │   │   ├─► Release channel resources
    │   │   │
    │   │   ├─► Dispatch 'closed' event (channel level)
    │   │   │   └─► Await all handlers
    │   │
    │   └─► (Errors caught and logged)
    │
    ├─► Wait for all channels (with timeout)
    │
    ├─► Call _stop() (subclass implementation)
    │   │
    │   ├─► Flush output ring buffer
    │   ├─► Close underlying connection
    │   ├─► Stop message processing loop
    │   ├─► Release output ring buffer
    │   └─► Release buffer pool buffers
    │
    ├─► Set #stopped = true
    │
    ├─► Dispatch 'stopped' event (transport level)
    │   └─► Await all handlers
    │
    └─► Return (Promise resolves)
```

## Timeout Handling

### Without Timeout

```javascript
await transport.stop({ discard: false });
// Waits indefinitely for all channels to close gracefully
```

### With Timeout

```javascript
try {
  await transport.stop({ discard: false, timeout: 5000 });
  // Successfully stopped within 5 seconds
} catch (err) {
  if (err.message === 'Stop timeout') {
    // Timeout expired, some channels may not have closed gracefully
    // Transport is still marked as stopped
  }
}
```

### Timeout Behavior

- Timeout applies to the entire channel closure process (step 5)
- Individual channels don't have separate timeouts
- If timeout expires:
  - Remaining channels may not have closed gracefully
  - Transport continues with `_stop()` and marks itself stopped
  - Error is thrown to caller
  - Transport is still in stopped state (stop is permanent)

## Graceful vs Immediate Stop

### Graceful Stop (discard=false)

```javascript
await transport.stop({ discard: false, timeout: 10000 });
```

**Behavior**:
- Wait for all pending writes to complete
- Flush all buffered data
- Wait for ACKs if flow control requires it
- Send close messages to remote
- Wait for remote acknowledgments
- May take significant time depending on data volume

**Use Cases**:
- Normal application shutdown
- Ensuring all data is delivered
- Maintaining data integrity

### Immediate Stop (discard=true)

```javascript
await transport.stop({ discard: true });
```

**Behavior**:
- Discard all pending writes immediately
- Clear send and receive buffers
- Send close messages to remote (but don't wait for ACKs)
- Don't wait for remote acknowledgments
- Fast shutdown

**Use Cases**:
- Emergency shutdown
- Error recovery
- Timeout recovery
- Application crash/restart
