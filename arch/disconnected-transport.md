# Disconnected-Transport Feature Architecture

**Date**: 2026-04-07
**Status**: [APPROVED]

## Executive Summary

**Purpose**: Define the architecture for the "disconnected transport" feature — an abrupt, non-negotiated transport termination that bypasses the normal graceful stop handshake. This is used when the underlying connection is lost (e.g., TCP drop, worker termination) or when the user explicitly requests an immediate, non-graceful shutdown.

**Key Principles**:
1. **No I/O**: Once disconnected, no further transport I/O occurs (no TCC messages, no ACKs)
2. **Immediate channel termination**: All channels skip the closing phase and move directly to `disconnected`
3. **Rejection cascade**: All pending reads, writes, close() promises, and requestChannel() promises reject with `'Disconnected'`
4. **Simplified event sequence**: Emits `disconnected` then `stopped` (no `beforeStopping`)
5. **PTOC propagation**: Parent transport `disconnected` event propagates to PTOC as `super.stop({ disconnected: true })`
6. **Distinct terminal states**: `closed` = graceful (reopenable), `disconnected` = abrupt (not reopenable)

---

## Problem Statement

The current `stop()` flow is a graceful, negotiated shutdown:
1. Emits `beforeStopping`
2. Sends `tranStop` via TCC
3. Closes all channels (with `chanClose`/`chanClosed` handshake)
4. Sends `tranStopped` via TCC
5. Waits for remote's `tranStopped`
6. Finalizes and emits `stopped`

This is inappropriate when the underlying connection is already gone (e.g., TCP connection dropped, worker terminated). In those cases:
- Sending TCC messages will fail or be silently dropped
- Waiting for remote responses will hang indefinitely
- The graceful close handshake is meaningless

The disconnected path provides an immediate, non-negotiated shutdown that cleans up all local state without any I/O.

---

## New API

### `transport.stop({ disconnected: true })`

Triggers the disconnected shutdown path.

**Behavior**:
- If transport is already `STATE_STOPPED` or `STATE_DISCONNECTED`: returns existing stopped promise (no-op)
- If transport is in any other state (including `STATE_STOPPING`, `STATE_LOCAL_STOPPING`, `STATE_REMOTE_STOPPING`): immediately takes over and executes the disconnected path
- Does NOT send any TCC messages
- Does NOT wait for remote responses
- Emits `disconnected` event, then `stopped` event (no `beforeStopping`)
- Returns a promise that resolves when the disconnected shutdown is complete

**PTOC Exception**: When called on a PTOC transport, `stop({ disconnected: true })` is treated as `stop({ disconnected: false })` — a graceful stop. The PTOC transport overrides `stop()` to intercept the `disconnected: true` flag and redirect to the graceful path. The PTOC's own channels are disconnected only when the *parent* transport emits `disconnected`.

### Protected `onDisconnect()` method

A new protected method added to `Transport.__protected`:

```javascript
static __protected = Object.freeze({
    // ...existing stubs...
    async onDisconnect () {
        const [thys, _thys] = [this.__this, this];
        if (_thys !== thys.#_) throw new Error('Unauthorized');
        await thys.stop({ disconnected: true });
    }
});
```

**Purpose**: Called by subclasses when they detect a connection drop (e.g., `ByteTransport` detects EOF or socket error). The default implementation calls `stop({ disconnected: true })`.

**Usage by subclasses**:
```javascript
// In ByteTransport's #byteReader(), on connection drop:
_thys.onDisconnect();
```

---

## Transport State Machine Changes

### New State: `STATE_DISCONNECTED`

A new terminal state is added to represent a transport that was abruptly disconnected (as opposed to gracefully stopped):

```javascript
static get STATE_DISCONNECTED () { return 7; }
```

**State string**: `'disconnected'`

**Rationale**: Distinguishes "stopped gracefully" from "stopped due to disconnection". Both are terminal states, but `STATE_DISCONNECTED` signals that the connection was lost rather than cleanly shut down.

**Updated `stateString`**:
```javascript
get stateString () {
    return ['created', 'starting', 'active', 'stopping', 'localStopping', 'remoteStopping', 'stopped', 'disconnected'][this.#_.state];
}
```

### State Transition Diagram

```
STATE_CREATED
    |
    | start()
    v
STATE_STARTING
    |
    | handshake complete
    v
STATE_ACTIVE ─────────────────────────────────────────────────────────────────┐
    |                                                                          |
    | stop()                                                                   | stop({ disconnected: true })
    v                                                                          | OR onDisconnect()
STATE_STOPPING ────────────────────────────────────────────────────────────── |
    |                                                                          |
    | tranStopped received                                                     |
    v                                                                          |
STATE_LOCAL_STOPPING ──────────────────────────────────────────────────────── |
    |                                                                          |
    | tranStopped sent                                                         |
    v                                                                          |
STATE_REMOTE_STOPPING ─────────────────────────────────────────────────────── |
    |                                                                          |
    | tranStopped received                                                     |
    v                                                                          v
STATE_STOPPED                                                    STATE_DISCONNECTED
```

**Note**: Any state except `STATE_STOPPED` and `STATE_DISCONNECTED` can transition to `STATE_DISCONNECTED` when `stop({ disconnected: true })` is called.

---

## Disconnected Shutdown Sequence

### `#disconnectedStop()` — New Private Method in `Transport`

```
1. If state === STATE_STOPPED or STATE_DISCONNECTED: return existing stopped promise (no-op)
2. Capture prior stopped promise (to reject it later)
3. Transition to STATE_DISCONNECTED
4. Create new stopped promise
5. Reject all pending channel requests with 'Disconnected'
6. Disconnect all channels via close({ disconnect: token }) for each
7. Call _thys.stop() (subclass cleanup: wake I/O waiters, clear timers — no I/O)
8. Call _thys.bufferPool?.stop()
9. Reject prior stopped promise with 'Disconnected' (if one existed from graceful stop)
10. Resolve new stopped promise
11. Emit 'disconnected' event
12. Emit 'stopped' event
```

**Key difference from graceful stop**:
- No `beforeStopping` event
- No TCC messages (`tranStop`, `tranStopped`)
- No channel close handshake (`chanClose`, `chanClosed`)
- No waiting for remote responses
- Prior `stop()` promise rejects with `'Disconnected'`
- Transport ends in `STATE_DISCONNECTED` (not `STATE_STOPPED`)

### Channel Disconnection

The transport calls `channel.close({ disconnect: token })` to disconnect a channel. The `disconnect` option acts as a secret handshake — only the transport knows the channel's token, so this option is effectively private to the transport/channel relationship. Externally, `close()` still looks like the same public API.

Internally, `close()` detects the `disconnect` option and immediately delegates to the private `#disconnect()` method:

```javascript
async close ({ discard = false, disconnect } = {}) {
    // Secret handshake: transport passes its token to trigger immediate disconnect
    if (disconnect !== undefined) {
        if (disconnect !== this.#_.token) throw new Error('Unauthorized');
        return this.#disconnect();
    }
    // ... existing close() logic ...
}
```

**Note**: `#disconnect()` does NOT call `transport.nullChannel()` because the transport is also being torn down. The transport will handle its own channel map cleanup (or simply leave it — the transport is in a terminal state).

**Note**: `#disconnect()` does NOT send any TCC messages (no `chanClose`, no `chanClosed`).

---

## Channel State Changes

### New Terminal State: `STATE_DISCONNECTED`

Channels gain a new terminal state that is distinct from `STATE_CLOSED`:

```javascript
static get STATE_DISCONNECTED () { return 'disconnected'; }
```

**Semantics**:
- `STATE_CLOSED` = gracefully closed; channel can be reopened via `requestChannel()`
- `STATE_DISCONNECTED` = abruptly disconnected; channel cannot be reopened (transport is gone)

**Impact on `requestChannel()`**: The transport's `requestChannel()` must check for `STATE_DISCONNECTED` channels and throw `StateError` (or reject) rather than treating them as reopenable closed channels.

**Impact on state guards**: All code that currently checks `state === Channel.STATE_CLOSED` must be updated to also handle `STATE_DISCONNECTED` where appropriate. Specifically:
- `write()` guard: already throws `StateError` for non-`STATE_OPEN` states — no change needed
- `addMessageTypes()` guard: already throws `StateError` for non-`STATE_OPEN` states — no change needed
- `close()` guard: already returns existing promise for non-`STATE_OPEN` states — no change needed
- `receiveMessage()` in transport: currently checks `channel.state === Channel.STATE_CLOSED`; must also check `STATE_DISCONNECTED`
- `requestChannel()` in transport: must distinguish `STATE_CLOSED` (reopenable) from `STATE_DISCONNECTED` (not reopenable)

### `close()` Update: `disconnect` Secret Handshake

The public `close()` method gains a new `disconnect` option that is only meaningful when the transport passes its own channel token as the value:

```javascript
async close ({ discard = false, disconnect } = {}) {
    // Secret handshake: transport passes its token to trigger immediate disconnect
    if (disconnect !== undefined) {
        if (disconnect !== this.#_.token) throw new Error('Unauthorized');
        return this.#disconnect();
    }
    // ... existing close() logic unchanged ...
}
```

### New Private `#disconnect()` Method

```javascript
async #disconnect () {
    if (this.#state === Channel.STATE_CLOSED || this.#state === Channel.STATE_DISCONNECTED) {
        return this.#closingPromise?.promise; // Return already-settled promise
    }

    // Transition to disconnected state immediately
    this.#state = Channel.STATE_DISCONNECTED;

    // Reject pending message-type registrations
    for (const [_type, entry] of this.#_.messageTypes) {
        entry.reject?.('Disconnected');
    }

    // Reject pending reads
    if (this.#allReader?.reject) this.#allReader.reject('Disconnected');
    for (const [_type, entry] of this.#filteredReaders) {
        if (entry.reject) entry.reject('Disconnected');
    }

    // Reject pending close() promise
    this.#closingPromise?.reject?.('Disconnected');

    // Clear message type registrations
    this.#_.messageTypes.clear();

    // Stop flow control (rejects pending writable() waiters)
    this.#_.flowControl.stop();

    // Dispatch 'closed' event (channel IS closed, just abruptly)
    await this.dispatchEvent('closed');
    // Note: No transport.nullChannel() call — transport handles its own cleanup
}
```

**Write rejection**: The `#_.flowControl.stop()` call rejects pending `writable()` waiters (which are the write-budget waiters). The `write()` method checks `this.#state !== Channel.STATE_OPEN` at entry, so new writes after disconnect will throw `StateError`. In-progress writes (waiting on `flowControl.writable()`) will be rejected when `flowControl.stop()` is called.

**Close promise rejection**: The `#closingPromise` object currently only has a `resolve` function (see [`channel.esm.js:188`](../src/channel.esm.js:188)). This needs to be updated to also store a `reject` function so `#disconnect()` can reject it.

---

## `ChannelFlowControl` Changes

The `stop()` method on `ChannelFlowControl` needs to reject pending `writable()` waiters with `'Disconnected'`. Looking at [`channel-flow-control.esm.js`](../src/channel-flow-control.esm.js), the `stop()` method currently resolves the `allWritesAcked()` waiter. It should also reject any pending `writable()` waiters with `'Disconnected'`.

**Required change**: `ChannelFlowControl.stop()` should reject pending `writable()` waiters (not just resolve `allWritesAcked()`).

---

## `ByteTransport` Changes

### `onDisconnect()` Override

`ByteTransport` overrides `onDisconnect()` to wake/reject its I/O waiters before calling the base implementation:

```javascript
static __protected = Object.freeze(Object.setPrototypeOf({
    // ...existing methods...
    async onDisconnect () {
        const [thys, _thys] = [this.__this, this];
        if (_thys !== thys.#_) throw new Error('Unauthorized');
        // Wake the read waiter (if any) so the reader loop can exit
        if (_thys.readWaiter) {
            const reject = _thys.readWaiter.reject;
            _thys.readWaiter = null;
            reject?.('Disconnected');
        }
        // Wake the reserve waiter (if any)
        if (_thys.reserveWaiter) {
            const reject = _thys.reserveWaiter.reject;
            _thys.reserveWaiter = null;
            reject?.('Disconnected');
        }
        // Call base implementation
        await super.onDisconnect();
    }
}, super.__protected));
```

**Note**: The `#byteReader()` loop currently checks `_thys.state !== Transport.STATE_STOPPED`. After disconnect, the state transitions to `STATE_DISCONNECTED`, so the loop condition must also check for `STATE_DISCONNECTED`:

```javascript
// Updated loop condition in #byteReader():
while (_thys.state !== Transport.STATE_STOPPED && _thys.state !== Transport.STATE_DISCONNECTED) {
```

### `stop()` Override (Protected)

The existing `ByteTransport.__protected.stop()` drains the output buffer and clears the write timer. During a disconnected stop, we should NOT wait for the output buffer to drain (there's no connection to drain to). The base `#disconnectedStop()` will call `_thys.stop()` — so `ByteTransport.__protected.stop()` needs to be aware of the disconnected state:

```javascript
async stop () {
    const [thys, _thys] = [this.__this, this];
    if (_thys !== thys.#_) throw new Error('Unauthorized');
    // Skip drain if disconnected (no connection to drain to)
    if (_thys.state !== Transport.STATE_DISCONNECTED) {
        const { outputBuffer } = _thys;
        if (outputBuffer.committed) _thys.scheduleWrite(true);
        await _thys.reservable(outputBuffer.size);
    }
    if (thys.#writeBatchTimer) {
        clearTimeout(thys.#writeBatchTimer);
        thys.#writeBatchTimer = null;
    }
}
```

---

## PTOC Transport Changes

PTOC (PolyTransport-over-channel) is a transport that runs over a channel of another transport. It has two special behaviors:

### 1. User-initiated `stop({ disconnected: true })` → Graceful Stop

When a user calls `ptocTransport.stop({ disconnected: true })`, PTOC treats it as a graceful stop:

```javascript
// In PTOC's stop() override:
async stop (options = {}) {
    if (options.disconnected) {
        // User-initiated disconnect on PTOC: treat as graceful stop
        return super.stop({ ...options, disconnected: false });
    }
    return super.stop(options);
}
```

**Rationale**: PTOC runs over a channel. If the user wants to stop the PTOC, they should do so gracefully (the underlying channel is still alive). A "disconnected" stop on PTOC only makes sense when the *parent* transport is disconnected.

### 2. Parent Transport `disconnected` Event → PTOC Disconnected Stop

When the parent transport emits `disconnected`, PTOC calls `super.stop({ disconnected: true })` to propagate the disconnection:

```javascript
// In PTOC constructor or start():
parentTransport.addEventListener('disconnected', () => {
    super.stop({ disconnected: true });
});
```

**Rationale**: If the parent transport is disconnected, the underlying channel is gone. PTOC cannot communicate with its remote endpoint, so it must also disconnect.

---

## New `disconnected` Event

A new event type `'disconnected'` is emitted by the transport during the disconnected shutdown sequence.

**Event detail**: `{}` (empty, same as `stopped`)

**Sequence**: `disconnected` fires before `stopped`.

**Listeners**:
```javascript
transport.addEventListener('disconnected', (event) => {
    // Transport was disconnected (connection lost or explicit disconnect)
    // No further I/O is possible
    // All channels are already in STATE_DISCONNECTED at this point
});
```

---

## `stop()` Method Changes

The existing `stop()` method in `Transport` needs to be updated to handle the `disconnected: true` option:

```javascript
async stop (options = {}) {
    const _thys = this.#_;
    const { disconnected = false } = options;

    // Disconnected path: immediate, non-negotiated shutdown
    if (disconnected) {
        return this.#disconnectedStop();
    }

    // Existing graceful stop logic...
    switch (_thys.state) {
    case Transport.STATE_STOPPING:
    case Transport.STATE_LOCAL_STOPPING:
    case Transport.STATE_REMOTE_STOPPING:
    case Transport.STATE_STOPPED:
        return _thys.stopped.promise;
    case Transport.STATE_DISCONNECTED:
        return _thys.stopped.promise; // Already in terminal state
    }
    // ...rest of existing graceful stop...
}
```

### `requestChannel()` Changes

`requestChannel()` must distinguish between `STATE_CLOSED` (reopenable) and `STATE_DISCONNECTED` (not reopenable):

```javascript
async requestChannel (name, options = {}) {
    // ...existing state check...

    // Check if channel already exists
    const existing = channels.get(name);
    if (existing) {
        if (existing.state === Channel.STATE_OPEN) return existing; // Already open
        if (existing.state === Channel.STATE_DISCONNECTED) {
            throw new StateError(`Channel "${name}" was disconnected and cannot be reopened`);
        }
        // STATE_CLOSED: fall through to create new request (reopening)
    }
    // ...rest of existing logic...
}
```

---

## `#disconnectedStop()` — Detailed Implementation

```javascript
async #disconnectedStop () {
    const _thys = this.#_;

    // Already in a terminal state: no-op
    if (_thys.state === Transport.STATE_STOPPED || _thys.state === Transport.STATE_DISCONNECTED) {
        return _thys.stopped?.promise;
    }

    // Capture prior stopped promise (to reject it)
    const priorStopped = _thys.stopped;

    // Transition to disconnected state
    _thys.state = Transport.STATE_DISCONNECTED;

    // Create new stopped promise
    const stopped = _thys.stopped = { promise: null };
    stopped.promise = new Promise((res) => stopped.resolve = res);

    // Reject all pending channel requests
    for (const [_name, request] of _thys.pendingChannelRequests) {
        if (request.reject) request.reject('Disconnected');
    }
    _thys.pendingChannelRequests.clear();

    // Disconnect all channels via close({ disconnect: token })
    const { channels, channelTokens } = _thys;
    for (const [channel, token] of channelTokens) {
        if (!(channel instanceof Channel)) continue;
        if (channel.id === CHANNEL_TCC || channel.id === CHANNEL_C2C) continue;
        channel.close({ disconnect: token });
    }

    // Disconnect TCC and C2C
    for (const channelId of [CHANNEL_TCC, CHANNEL_C2C]) {
        const channel = channels.get(channelId);
        if (channel && typeof channel.close === 'function') {
            const token = channelTokens.get(channel);
            if (token) channel.close({ disconnect: token });
        }
    }

    // Subclass cleanup (wake I/O waiters, clear timers — no I/O)
    await _thys.stop();

    _thys.bufferPool?.stop();

    // Reject prior stopped promise (if graceful stop was in progress)
    priorStopped?.reject?.('Disconnected');

    // Resolve new stopped promise
    stopped.resolve();

    // Emit events
    await this.dispatchEvent('disconnected', {});
    await this.dispatchEvent('stopped', {});
}
```

---

## `Channel.#closingPromise` Change

Currently, `#closingPromise` only stores a `resolve` function:

```javascript
// Current (channel.esm.js:188):
closingPromise.promise = new Promise((...r) => [closingPromise.resolve] = r);
```

This needs to be updated to also store `reject`:

```javascript
// Updated:
closingPromise.promise = new Promise((...r) => [closingPromise.resolve, closingPromise.reject] = r);
```

---

## `ChannelFlowControl.stop()` Change

The `stop()` method needs to reject pending `writable()` waiters. Looking at the current implementation, `writable()` uses a waiter pattern similar to `allWritesAcked()`. The `stop()` method should reject both.

**Required change**: Add rejection of `writable()` waiters in `stop()`.

---

## `receiveMessage()` Change in Transport

The transport's `receiveMessage()` protected method currently checks `channel.state === Channel.STATE_CLOSED`. This must be updated to also handle `STATE_DISCONNECTED`:

```javascript
// Current:
if (channel.state === Channel.STATE_CLOSED) { ... }

// Updated:
if (channel.state === Channel.STATE_CLOSED || channel.state === Channel.STATE_DISCONNECTED) { ... }
```

---

## Summary of Changes by File

### `src/transport/base.esm.js`

1. Add `STATE_DISCONNECTED = 7` static getter
2. Update `stateString` to include `'disconnected'`
3. Add `onDisconnect()` stub to `__protected` (calls `stop({ disconnected: true })`)
4. Update `stop()` to check `disconnected` option and call `#disconnectedStop()`
5. Add `STATE_DISCONNECTED` to `stop()` early-return cases
6. Add `#disconnectedStop()` private method
7. Update `requestChannel()` to throw `StateError` for `STATE_DISCONNECTED` channels
8. Update `receiveMessage()` to handle `STATE_DISCONNECTED` channels

### `src/channel.esm.js`

1. Add `STATE_DISCONNECTED = 'disconnected'` static getter
2. Update `close()` to detect `disconnect` option and delegate to `#disconnect()`
3. Add `#disconnect()` private method
4. Update `#closingPromise` creation to store both `resolve` and `reject`

### `src/channel-flow-control.esm.js`

1. Update `stop()` to reject pending `writable()` waiters with `'Disconnected'`

### `src/transport/byte.esm.js`

1. Override `onDisconnect()` in `__protected` to wake/reject read and reserve waiters before calling `super.onDisconnect()`
2. Update `stop()` in `__protected` to skip output buffer drain when in `STATE_DISCONNECTED`
3. Update `#byteReader()` loop conditions to also check `STATE_DISCONNECTED`

### `src/transport/nested.esm.js` (future PTOC implementation)

1. Override `stop()` to redirect `disconnected: true` to `disconnected: false`
2. Listen for parent transport `disconnected` event and call `super.stop({ disconnected: true })`

---

## Testing Considerations

### Unit Tests

1. **`transport.stop({ disconnected: true })` from STATE_ACTIVE**: Verify immediate transition to STATE_DISCONNECTED, no TCC messages sent, `disconnected` + `stopped` events emitted
2. **`transport.stop({ disconnected: true })` from STATE_STOPPING**: Verify graceful stop is aborted, prior `stop()` promise rejects with `'Disconnected'`
3. **`transport.stop({ disconnected: true })` from STATE_STOPPED**: Verify no-op
4. **`transport.stop({ disconnected: true })` from STATE_DISCONNECTED**: Verify no-op
5. **Channel disconnect**: Verify pending reads reject with `'Disconnected'`
6. **Channel disconnect**: Verify pending writes reject with `'Disconnected'`
7. **Channel disconnect**: Verify pending `close()` promise rejects with `'Disconnected'`
8. **Channel disconnect**: Verify channel ends in `STATE_DISCONNECTED` (not `STATE_CLOSED`)
9. **Channel disconnect**: Verify `requestChannel()` throws `StateError` for `STATE_DISCONNECTED` channel
10. **Pending `requestChannel()` rejects**: Verify pending channel requests reject with `'Disconnected'`
11. **`onDisconnect()` protected method**: Verify default implementation calls `stop({ disconnected: true })`
12. **ByteTransport `onDisconnect()`**: Verify read waiter and reserve waiter are rejected

### Integration Tests

1. **PostMessage transport disconnect**: Verify all channels in STATE_DISCONNECTED, events emitted in correct order
2. **ByteTransport disconnect**: Verify byte reader exits cleanly, all channels disconnected
3. **Disconnect during data transfer**: Verify in-flight writes reject with `'Disconnected'`
4. **Disconnect during channel close**: Verify close promise rejects with `'Disconnected'`
5. **`disconnected` event listener**: Verify event fires before `stopped`
6. **Disconnected channel not reopenable**: Verify `requestChannel()` throws for disconnected channel

---

## Open Questions

1. Should `ByteTransport` also reject the `outputBuffer.sendable()` waiter during disconnect? (Recommendation: yes, via `outputBuffer.stop()` which already exists)
   - `outputBuffer.stop()` now accepts a `{ disconnected: true }` option (default is false)
2. Should there be a `DisconnectedError` class (subclass of `Error`) instead of the string `'Disconnected'`? (Recommendation: use a `DisconnectedError` class for consistency with `StateError`, `TimeoutError`, etc.)
   - Disconnection (and timeouts, for that matter), are *states* or *conditions*, not *errors* (i.e. there is no benefit to incurring stack-trace overhead)
   - Requesting an operation inappropriate to the current state may, at least on occasion, benefit from a stack trace, and can reasonably be considered an Error

---

## Approval Required

This architecture document requires approval before implementation because:
1. It adds a new transport state (`STATE_DISCONNECTED`)
2. It adds a new channel terminal state (`STATE_DISCONNECTED`) with distinct semantics from `STATE_CLOSED`
3. It changes the channel disconnection mechanism to use `close({ disconnect: token })` secret handshake
4. It changes the `#closingPromise` structure in `Channel`
5. It changes `ChannelFlowControl.stop()` behavior
6. It defines PTOC behavior that affects future PTOC implementation

**Next Steps**: Review this document and provide feedback or approval to proceed with implementation.
