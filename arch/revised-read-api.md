# Revised `channel.read()` API: Return `null` for All Non-Data Outcomes

**Status**: Approved (2026-04-16)

## Decision

`channel.read()` returns `null` for all non-data outcomes:

| Condition | Previous behavior | New behavior |
|---|---|---|
| Graceful close | rejects `'Closed'` | returns `null` |
| Abrupt disconnect | rejects `'Disconnected'` | returns `null` |
| Timeout | rejects `'Reader timeout'` | returns `null` |

Real errors (programming errors, protocol violations) still throw/reject as before.

## Rationale

### Normal conditions should not use exceptions

Graceful channel closure, abrupt disconnect, and read timeout are all **expected, normal conditions** — not errors. Using exceptions for normal control flow is a well-known anti-pattern that forces callers to write awkward try/catch blocks even when nothing went wrong.

### `channel.state` provides the "why"

The caller can always inspect `channel.state` after a `null` return to determine why:

- `'open'` → timeout (channel is still open, nothing arrived in time)
- `'closing'` / `'localClosing'` / `'remoteClosing'` / `'closed'` → graceful close
- `'disconnected'` → abrupt disconnect

This makes the distinction available without requiring exception message string-matching.

### Consistency with `readSync()`

`channel.readSync()` already returns `null` for "nothing available." Having `channel.read()` also return `null` for "nothing to give you" creates a coherent semantic: **`null` always means "no message."**

### Consistency with async iteration conventions

`ReadableStream` reader returns `{ done: true }`, `AsyncIterator` returns `{ done: true }`, Node.js streams return `null` — all signal "done" without throwing. PolyTransport's `null` return aligns with this established convention.

## Usage Patterns

### Simple reader loop (most common)

```javascript
while (true) {
    const msg = await channel.read();
    if (!msg) break; // Channel closed or disconnected
    await msg.process(async (m) => {
        // handle message
    });
}
```

### Reader loop with timeout

```javascript
while (true) {
    const msg = await channel.read({ timeout: 5000 });
    if (!msg) {
        if (channel.state === Channel.STATE_OPEN) {
            // Timeout — channel still open, nothing arrived
            continue; // or handle idle condition
        }
        break; // Closed or disconnected
    }
    await msg.process(async (m) => {
        // handle message
    });
}
```

### Distinguishing close from disconnect

```javascript
while (true) {
    const msg = await channel.read();
    if (!msg) {
        if (channel.state === Channel.STATE_DISCONNECTED) {
            // Abrupt disconnect — may want to reconnect
        }
        // else: graceful close
        break;
    }
    await msg.process(async (m) => { /* handle */ });
}
```

## What Still Throws (Real Errors)

- **`'Conflicting readers'`** — programming error: two concurrent readers on the same message type
- **`StateError`** from `write()` / `addMessageTypes()` — programming error: writing to a closing/closed channel
- **Protocol violations** — unexpected/malformed data from remote (emitted as `protocolViolation` events)

## Implementation Changes

### `src/channel.esm.js`

**`#finalizeClosure()`** (line ~293):
```javascript
// Before:
if (this.#allReader?.reject) this.#allReader.reject('Closed');
for (const [_type, entry] of this.#filteredReaders) {
    if (entry.reject) entry.reject('Closed');
}

// After:
if (this.#allReader?.resolve) this.#allReader.resolve(null);
for (const [_type, entry] of this.#filteredReaders) {
    if (entry.resolve) entry.resolve(null);
}
```

**`#onDisconnect()`** (line ~447):
```javascript
// Before:
if (this.#allReader?.reject) this.#allReader.reject('Disconnected');
for (const [_type, entry] of this.#filteredReaders) {
    if (entry.reject) entry.reject('Disconnected');
}

// After:
if (this.#allReader?.resolve) this.#allReader.resolve(null);
for (const [_type, entry] of this.#filteredReaders) {
    if (entry.resolve) entry.resolve(null);
}
```

**`read()` timeout** (line ~653):
```javascript
// Before:
reader.timer = setTimeout(() => reader.reject('Reader timeout'), timeout);

// After:
reader.timer = setTimeout(() => reader.resolve(null), timeout);
```

**`read()` after promise resolves** (line ~669):
```javascript
// Before:
messageType = await promise;
// ...
return this.#readSync(new IdSet([messageType]), { dechunk, decode });

// After:
messageType = await promise;
// ...
if (messageType === null) return null; // Closed, disconnected, or timeout
return this.#readSync(new IdSet([messageType]), { dechunk, decode });
```

## Test Changes

Tests that previously used `assertRejects()` for close/disconnect/timeout conditions on `read()` must be updated to assert a `null` return value instead.

Affected tests:
- `test/unit/channel.test.js`: `'Channel - pending read is rejected when channel closes'`
- `test/unit/channel.test.js`: `'Channel - disconnect rejects pending read'`
- `test/integration/suites/channel-close.suite.js`: `'pending read is rejected when channel closes'`

## README Changes

The `read()` API reference must be updated:
- Remove: "Returns a message object (or rejects with `'Closed'` or `'Disconnected'`)"
- Add: "Returns a message object, or `null` if the channel was closed, disconnected, or the timeout expired"
- Remove: "`catch` blocks should distinguish between conditions (strings) and errors (`instanceof Error`)"
- Add: "Check `channel.state` after a `null` return to determine why (timeout: `'open'`; graceful close: `'closed'`; disconnect: `'disconnected'`)"
