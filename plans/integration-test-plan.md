# Integration Test Plan

**Status**: [DRAFT]  
**Date**: 2026-04-05  
**Context**: Following completion of channel-close integration tests, this document plans the remaining integration test coverage per [`TODO.md`](../TODO.md).

---

## Overview

The remaining integration tests cover the full lifecycle of a PolyTransport connection, from transport startup through channel request/accept/reject, message type registration, data exchange, and transport shutdown. Tests must be written for **both** the `PostMessageTransport` and `ByteTransport` (via a connected pair adapter).

The existing [`test/integration/channel-close.test.js`](../test/integration/channel-close.test.js) already covers channel close scenarios using `PostMessageTransport`. The new tests will be organized into separate files by concern.

---

## Test Infrastructure

### Shared Helper Module

All shared test infrastructure lives in:

```
test/integration/helpers.js
```

This module exports everything needed to set up transport pairs and connected channels.

### PostMessageTransport Pair

The existing `PairedGateway` / `makeConnectedTransports()` / `makeConnectedChannel()` helpers from [`channel-close.test.js`](../test/integration/channel-close.test.js) are extracted here and renamed for clarity:

```javascript
export class PairedGateway {
  // All properties public for easy test inspection
  listeners = new Map();
  peer = null;
  sentMessages = [];  // Capture outgoing messages for assertions

  setPeer (peer) { ... }
  addEventListener (type, handler) { ... }
  removeEventListener (type, handler) { ... }
  postMessage (data, transfer) { ... }
  simulateMessage (data) { ... }  // Inject a message as if received from peer
}

export function makePairedGateways () { ... }

/**
 * Create two connected PostMessageTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeMessageTransportPair (optionsA = {}, optionsB = {}) { ... }

/**
 * Request a channel from A and accept it on B.
 * Returns [channelA, channelB].
 */
export async function makeConnectedChannel (transportA, transportB, name = 'test-channel') { ... }
```

### ByteTransport Pair

`ByteTransport` is abstract — it requires a concrete subclass that implements `writeBytes()`. For integration testing, a **connected pair** is needed: two `ConnectedByteTransport` instances where bytes written by one are fed as input to the other.

**Key design decision**: `writeBytes()` delivers bytes to the peer via `queueMicrotask` (not synchronously). This simulates the asynchronous nature of actual communications and is crucial for realistic integration testing.

```javascript
export class ConnectedByteTransport extends ByteTransport {
  static __protected = Object.freeze(Object.setPrototypeOf({
    async writeBytes () {
      const [thys, _thys] = [this.__this, this];
      if (_thys !== thys.#_) throw new Error('Unauthorized');
      const { outputBuffer } = _thys;
      const committed = outputBuffer.committed;
      if (committed === 0) return;

      const buffers = outputBuffer.getBuffers(committed);
      const snapshots = buffers.map((buf) => new Uint8Array(buf));
      outputBuffer.release(committed);
      _thys.afterWrite();

      // Deliver to peer asynchronously (simulates real async I/O)
      queueMicrotask(() => {
        for (const snapshot of snapshots) {
          thys.writtenBytes.push(snapshot);  // Capture for assertions
          if (thys.peer) thys.peer.#_.receiveBytes(snapshot);
        }
      });
    }
  }, super.__protected));

  // All public for easy test inspection and setup
  peer = null;
  writtenBytes = [];  // Capture outgoing bytes for assertions

  setPeer (peer) { this.peer = peer; }
  clearWrittenBytes () { this.writtenBytes = []; }

  // ...
}

/**
 * Create two connected ConnectedByteTransport instances and start them.
 * Returns [transportA, transportB] both in STATE_ACTIVE.
 */
export async function makeByteTransportPair (optionsA = {}, optionsB = {}) { ... }
```

**Notes on `ConnectedByteTransport`**:
- All instance properties (`peer`, `writtenBytes`) are public — no getters/setters needed, easy to inspect in tests
- The `#_` protected state access follows the same pattern as `MockByteTransport` in [`test/unit/transport-byte.test.js`](../test/unit/transport-byte.test.js)
- `writtenBytes` captures snapshots of bytes sent (after `release()`) for post-hoc assertions

---

## Test File Organization

### Structure

```
test/integration/
  helpers.js                              # Shared helpers (PairedGateway, makeMessageTransportPair, makeByteTransportPair, etc.)
  suites/
    channel-close.suite.js                # Shared test suite: channel close scenarios (extracted from existing channel-close.test.js)
    transport-lifecycle.suite.js          # Shared test suite: transport start/stop, channel request/accept/reject
    message-types.suite.js                # Shared test suite: message type registration (accept/reject)
    data-exchange.suite.js                # Shared test suite: chunk/message send/receive with various types
  post-message/
    channel-close.test.js                 # PostMessage channel close tests (replaces top-level channel-close.test.js)
    transport-lifecycle.test.js           # PostMessage transport lifecycle tests
    message-types.test.js                 # PostMessage message type tests
    data-exchange.test.js                 # PostMessage data exchange tests
  byte-transport/
    channel-close.test.js                 # ByteTransport channel close tests (NEW)
    transport-lifecycle.test.js           # ByteTransport lifecycle tests
    message-types.test.js                 # ByteTransport message type tests
    data-exchange.test.js                 # ByteTransport data exchange tests
```

### How It Works

**Suite files** (in `suites/`) contain the actual test logic as exported functions that accept a `makeTransportPair` factory:

```javascript
// test/integration/suites/transport-lifecycle.suite.js
export function registerTransportLifecycleTests (makeTransportPair) {
  Deno.test('create and start transports', async () => {
    const [tA, tB] = await makeTransportPair();
    assertEquals(tA.state, Transport.STATE_ACTIVE);
    assertEquals(tB.state, Transport.STATE_ACTIVE);
    await Promise.all([tA.stop(), tB.stop()]);
  });
  // ... more tests ...
}
```

**Transport-specific test files** import the suite and invoke it with their factory:

```javascript
// test/integration/post-message/transport-lifecycle.test.js
import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerTransportLifecycleTests(makeMessageTransportPair);
```

```javascript
// test/integration/byte-transport/transport-lifecycle.test.js
import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerTransportLifecycleTests(makeByteTransportPair);
```

### Running Tests

```bash
# Run all integration tests
deno test test/integration/

# Run only PostMessage integration tests
deno test test/integration/post-message/

# Run only ByteTransport integration tests
deno test test/integration/byte-transport/

# Run only transport lifecycle tests (both transports)
deno test --filter 'create and start transports' test/integration/

# Run a specific test for a specific transport
deno test test/integration/post-message/transport-lifecycle.test.js
```

Test names are **identical** across transports (no label prefix needed) — the file path provides the transport context. This makes it easy to compare failures between transports.

---

## Test Scenarios by Suite

### `test/integration/suites/transport-lifecycle.suite.js`

Covers transport startup, channel request/accept/reject, and transport stop.

#### Transport Lifecycle

| # | Test Name | Description |
|---|-----------|-------------|
| 1 | `create and start transports` | Two transport instances start and reach `STATE_ACTIVE` |
| 2 | `stop transports` | Both transports stop and reach `STATE_STOPPED` |

#### Channel Request — Unidirectional Accept

| # | Test Name | Description |
|---|-----------|-------------|
| 3 | `unidirectional channel request accepted` | A requests channel, B accepts via `newChannel` event; both sides get `STATE_OPEN` channel |
| 4 | `channel is accessible by name after acceptance` | `transportA.getChannel('name')` and `transportB.getChannel('name')` both return the channel |

#### Channel Request — Unidirectional Reject

| # | Test Name | Description |
|---|-----------|-------------|
| 5 | `unidirectional channel request rejected` | A requests channel, B rejects via `newChannel` event (calls `event.reject()`); A's `requestChannel()` promise rejects |
| 6 | `no channel registered after rejection` | `transportA.getChannel('name')` returns `undefined` after rejection |

#### Channel Request — Simultaneous Bidirectional (Mutual Accept)

| # | Test Name | Description |
|---|-----------|-------------|
| 7 | `bidirectional simultaneous channel request, mutual accept` | A and B both call `requestChannel('same-name')` simultaneously; both promises resolve to a channel |
| 8 | `bidirectional channel has two IDs` | The channel returned by both sides has `channel.ids.length === 2` |

**Notes on bidirectional test**:
- Both sides call `requestChannel()` before either receives the other's request
- The "first accept or last reject" rule means both promises should resolve
- The channel should have two IDs (one from each side's role)
- This validates the control-channel refactoring from [`arch/control-channel-refactoring.md`](../arch/control-channel-refactoring.md)

---

### `test/integration/suites/message-types.suite.js`

Covers `channel.addMessageTypes()` — requesting named message types from the remote side.

#### Message Type Registration

| # | Test Name | Description |
|---|-----------|-------------|
| 1 | `request message type - accepted` | A calls `addMessageTypes(['myType'])` on a channel; B's `newMessageType` event fires and does NOT call `preventDefault()`; A's promise resolves |
| 2 | `accepted type has a numeric ID` | After acceptance, `channel.getMessageType('myType').ids[0]` is a number |
| 3 | `request message type - rejected` | A calls `addMessageTypes(['myType'])` on a channel; B's `newMessageType` event fires and calls `event.preventDefault()`; A's promise rejects |
| 4 | `request multiple types - one accepted, one rejected` | A calls `addMessageTypes(['typeA', 'typeB'])`; B accepts `typeA` and rejects `typeB`; `allSettled` result reflects partial acceptance |
| 5 | `accepted type can be used in write` | After acceptance, A can call `channel.write('myType', data)` without error |
| 6 | `rejected type cannot be used in write` | After rejection, A calling `channel.write('myType', data)` throws `RangeError` |

**Notes**:
- `addMessageTypes()` returns `Promise.allSettled(promises)` — check individual results
- The `newMessageType` event is dispatched on the **receiving** channel (B's side)
- Accepted types get a numeric ID assigned; rejected types have their promise rejected

---

### `test/integration/suites/data-exchange.suite.js`

Covers sending and receiving data with various message types and chunk/message modes.

#### Data Exchange — Numeric Message Type 0

| # | Test Name | Description |
|---|-----------|-------------|
| 1 | `send/receive chunk (eom=false) with message type 0` | A writes a chunk with `eom: false` and type `0`; B reads it with `dechunk: false`; chunk arrives with `eom === false` |
| 2 | `send/receive complete message (eom=true) with message type 0` | A writes a message with `eom: true` and type `0`; B reads it with `dechunk: true`; message arrives with `eom === true` |
| 3 | `multiple messages in sequence` | A writes 3 messages; B reads them in order |
| 4 | `bidirectional data exchange` | A writes to B and B writes to A simultaneously; both receive correctly |

#### Data Exchange — Registered String Message Type

| # | Test Name | Description |
|---|-----------|-------------|
| 5 | `send/receive message with accepted registered string type` | A registers `'myType'` on a channel (B accepts); A writes with `'myType'`; B reads and gets `messageType === 'myType'` |
| 6 | `read filtered by registered string type` | B calls `read({ only: 'myType' })`; only messages of that type are returned |

#### Data Exchange — Multi-Chunk Messages

| # | Test Name | Description |
|---|-----------|-------------|
| 7 | `multi-chunk message reassembled correctly` | A writes a large string that spans multiple chunks (set `maxChunkBytes` small); B reads with `dechunk: true` and gets the full text |

#### Data Exchange — Binary Data

| # | Test Name | Description |
|---|-----------|-------------|
| 8 | `send/receive binary data (Uint8Array)` | A writes a `Uint8Array`; B reads and gets matching binary data |

---

## Key API Notes

### `channel.write(messageType, source, { eom })`
- `messageType`: numeric (e.g. `0`, `2`) or registered string name
- `source`: `string`, `Uint8Array`, `VirtualBuffer`, or `null`
- `eom`: defaults to `true`; set `false` for chunk-mode writes

### `channel.read({ dechunk, decode, only, timeout })`
- `dechunk: true` (default): waits for complete message (EOM chunk)
- `dechunk: false`: returns next available chunk regardless of EOM
- `decode: true`: auto-decodes binary data to text
- Returns `{ messageType, messageTypeId, text, data, eom, done() }`

### `channel.addMessageTypes(rawTypes)`
- `rawTypes`: array of string type names
- Returns `Promise.allSettled(promises)` — one promise per type
- Remote side receives `newMessageType` event per type; call `event.preventDefault()` to reject

### `transport.requestChannel(name, options)`
- Returns `Promise<Channel>` that resolves when channel is open
- Rejects if remote rejects the request
- For bidirectional simultaneous requests, both promises resolve (first-accept rule)

### `newChannel` event
- Fired on the **receiving** transport when a channel request arrives
- `event.accept()` — accept the channel
- `event.reject()` — reject the channel (default if no handler calls `accept()`)
- `event.detail.channelName` — the requested channel name

---

## Implementation Order

1. **Create `test/integration/helpers.js`** — extract `PairedGateway`, `makeMessageTransportPair`, `makeConnectedChannel` from `channel-close.test.js`; add `ConnectedByteTransport` and `makeByteTransportPair`
2. **Update `channel-close.test.js`** — import helpers from `helpers.js` (remove duplication); move to `test/integration/post-message/channel-close.test.js`
3. **Create `test/integration/suites/transport-lifecycle.suite.js`** — shared transport lifecycle test suite
4. **Create `test/integration/post-message/transport-lifecycle.test.js`** and `test/integration/byte-transport/transport-lifecycle.test.js`
5. **Create `test/integration/suites/message-types.suite.js`** — shared message type test suite
6. **Create `test/integration/post-message/message-types.test.js`** and `test/integration/byte-transport/message-types.test.js`
7. **Create `test/integration/suites/data-exchange.suite.js`** — shared data exchange test suite
8. **Create `test/integration/post-message/data-exchange.test.js`** and `test/integration/byte-transport/data-exchange.test.js`
9. **Create `test/integration/byte-transport/channel-close.test.js`** — ByteTransport channel close tests (reuses the existing channel-close suite, now extracted from `channel-close.test.js`)

---

## Coverage Summary

| Area | PostMessage | ByteTransport |
|------|-------------|---------------|
| Transport start/stop | ✅ | ✅ |
| Channel request — unidirectional accept | ✅ | ✅ |
| Channel request — unidirectional reject | ✅ | ✅ |
| Channel request — bidirectional mutual accept | ✅ | ✅ |
| Message type registration — accept | ✅ | ✅ |
| Message type registration — reject | ✅ | ✅ |
| Message type registration — partial | ✅ | ✅ |
| Send/receive chunk (eom=false, type 0) | ✅ | ✅ |
| Send/receive message (eom=true, type 0) | ✅ | ✅ |
| Send/receive with registered string type | ✅ | ✅ |
| Multi-chunk message reassembly | ✅ | ✅ |
| Binary data (Uint8Array) | ✅ | ✅ |
| Channel close (all scenarios) | ✅ (existing → moved to `post-message/`) | ✅ (step 9) |

---

## Decisions

1. **`channel-close.test.js` refactoring**: The existing file will be updated to import from `helpers.js` — avoids drift and is a small change.

2. **`channel-close.test.js` transport coverage**: A `byte-transport/channel-close.test.js` will be added as part of this work (step 9), since the `makeByteTransportPair` infrastructure will be in place.
