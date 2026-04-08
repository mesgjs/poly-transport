# PTOC (PolyTransport-over-Channel) / Nested Transport Architecture

**Date**: 2026-04-08
**Status**: [APPROVED]

## Executive Summary

PTOC (PolyTransport-over-Channel), also called "Nested Transport", is a transport that runs over a **dedicated message type on a parent channel** of another PolyTransport transport. Instead of a TCP socket, WebSocket, or IPC pipe, the underlying "wire" is a stream of binary chunks on a parent channel.

PTOC enables complex routing scenarios in JSMAWS — for example, an applet communicating with a web client through a chain of responder → operator → WebSocket, with each hop relaying raw PTOC byte-stream chunks.

---

## Core Design Principles

### 1. Raw Byte Stream over a Channel Message Type

The parent channel carries PTOC traffic as a **raw byte stream** using a dedicated message type. This is analogous to how a TCP socket carries a byte stream — the channel is just the transport medium.

- **No EOM semantics for PTOC traffic**: PTOC writes chunks with `eom: false`. The parent channel's EOM concept is irrelevant to PTOC; the PTOC binary protocol frames are parsed from the accumulated byte stream by the remote endpoint.
- **Multiple traffic types coexist**: The parent channel can carry both PTOC traffic (stream-based, no EOM) and other message types (message-based, with EOM) simultaneously. They coexist because each has its own message type.
- **Relay uses `dechunk: false`**: Relay nodes forward raw chunks without reassembly. Original chunk and message boundaries are parsed from the byte stream by the remote PTOC endpoint.

### 2. Channel Lifetime is Independent of PTOC Lifetime

The parent channel's lifetime is separate from the PTOC transport's lifetime:

- PTOC does NOT close the parent channel when it stops.
- The parent channel's `beforeClosing` event triggers a graceful PTOC stop.
- The parent channel's `closed` or `disconnected` event triggers a PTOC disconnected stop.
- The PTOC can stop gracefully (via `tranStop`/`tranStopped` in the byte stream) without affecting the parent channel.

### 3. User-Initiated Disconnect → Graceful Stop

When a user calls `ptocTransport.stop({ disconnected: true })`, PTOC treats it as a graceful stop. The underlying channel is still alive, so a graceful stop is appropriate. Only parent channel events trigger actual disconnected stops.

---

## Constructor

```javascript
new NestedTransport({ channel, messageType, ...transportOptions })
```

**Parameters**:
- `channel`: Pre-opened parent channel (caller manages its lifecycle)
- `messageType`: Numeric or string message type dedicated to PTOC traffic on the parent channel. Must be exclusively dedicated to PTOC (the PTOC "owns" this message type on the channel).
- `...transportOptions`: Standard `ByteTransport` options (bufferPool, maxChunkBytes, lowBufferBytes, etc.)

**Note**: If `messageType` is a string, it **must** have already been successfully registered via `.addMessageTypes` on the parent channel.

---

## Architecture: Extends ByteTransport

PTOC extends `ByteTransport` because it IS a byte-stream transport. The three protected methods to implement are:

### `startReader()`

```
1. Call super.startReader() — starts ByteTransport's #byteReader (protocol parser)
2. Launch #channelReader() — reads binary chunks from parent channel
```

**`#channelReader()` loop**:
```
while transport is active:
    message = await channel.read({ only: messageType, dechunk: false })
    if message is null: break (channel closed)
    if message has binary data: receiveBytes(data.toPool(bufferPool))
    message.done()
```

Key points:
- Uses `dechunk: false` to get individual chunks without waiting for EOM
- Each chunk's binary data is copied via `data.toPool(bufferPool)` before being fed into `receiveBytes()`. This is necessary because the `VirtualBuffer` segments are backed by pool buffers that may be released (zeroed) after `message.done()` is called. Using `toPool()` copies the data into pool-managed buffers, which can be reclaimed by the pool when released from the `inputBuffer` (via `inputBuffer.release(count, bufferPool)`).
- `message.done()` marks the chunk as processed (enables flow control ACKs)
- On channel close/disconnect: exits loop, calls `onDisconnect()`

### `stop()` (protected)

```
1. Call super.stop() — drains output buffer, clears write timer
2. Do NOT close the parent channel (caller manages it)
```

### `writeBytes()` (protected)

```
1. Get committed bytes: outputBuffer.getBuffers(committed)
2. For each buffer:
   channel.write(messageType, buffer, { eom: false })
3. outputBuffer.release(committed)
4. afterWrite()
```

Key points:
- Writes with `eom: false` — PTOC traffic is a raw byte stream, not message-delimited
- Each `writeBytes()` call may write multiple buffers (ring buffer wrap-around)
- Write errors call `onDisconnect()`

---

## Lifecycle Event Handling

PTOC listens to parent channel events to manage its own lifecycle:

### `beforeClosing` → Graceful Stop

```javascript
channel.addEventListener('beforeClosing', () => {
    this.stop(); // Graceful stop
});
```

The parent channel is about to close. PTOC initiates a graceful stop (sends `tranStop`/`tranStopped` to remote).

### `closed` → Disconnected Stop

```javascript
channel.addEventListener('closed', () => {
    super.stop({ disconnected: true }); // Disconnected stop
});
```

The parent channel has closed. PTOC can no longer communicate, so it disconnects immediately.

### `disconnected` → Disconnected Stop

```javascript
channel.addEventListener('disconnected', () => {
    super.stop({ disconnected: true }); // Disconnected stop
});
```

The parent channel was abruptly disconnected. PTOC disconnects immediately.

---

## `stop()` Override: Redirect User-Initiated Disconnect

```javascript
async stop (options = {}) {
    if (options.disconnected) {
        // User-initiated disconnect on PTOC: treat as graceful stop
        return super.stop({ ...options, disconnected: false });
    }
    return super.stop(options);
}
```

**Rationale**: When a user calls `ptocTransport.stop({ disconnected: true })`, the underlying channel is still alive. A graceful stop is appropriate. Only parent channel events (which call `super.stop({ disconnected: true })` directly, bypassing this override) trigger actual disconnected stops.

---

## Data Flow

### Inbound (Remote → Local)

```
Remote PTOC writeBytes()
    → parent channel write (eom: false)
    → parent transport (byte-stream or object-stream)
    → parent channel receiveMessage()
    → channel.read({ only: messageType, dechunk: false })
    → PTOC #channelReader()
    → receiveBytes(data)
    → ByteTransport inputBuffer accumulation
    → #byteReader() protocol parser
    → receiveMessage(header, data)
    → PTOC channels
```

### Outbound (Local → Remote)

```
PTOC channel write()
    → ByteTransport sendChunk()
    → outputBuffer.reserve() / commit()
    → scheduleWrite()
    → writeBytes()
    → channel.write(messageType, buffer, { eom: false })
    → parent transport (byte-stream or object-stream)
    → Remote PTOC #channelReader()
    → receiveBytes(data)
```

---

## Relay Scenario

In JSMAWS, PTOC traffic is relayed through intermediate nodes (operator, responder) without reassembly:

```
Applet PTOC
    → applet channel (dechunk: false relay)
    → Responder relay
    → operator channel (dechunk: false relay)
    → Operator relay
    → WebSocket transport
    → Client PTOC
```

Each relay node:
1. Reads raw chunks from the inbound channel (`dechunk: false`)
2. Writes raw chunks to the outbound channel (`eom: false`)
3. Does NOT reassemble PTOC frames — just passes bytes through

This is efficient because:
- No memory allocation for reassembly
- No parsing of PTOC protocol at relay nodes
- Flow control maintained independently at each hop

---

## Test Infrastructure

### `makeNestedTransportPair()`

Creates two PTOC transports connected via an in-memory parent transport:

```
[parentTransportA] ←→ [parentTransportB]
      |                      |
  channelA              channelB
      |                      |
[nestedTransportA] ←→ [nestedTransportB]
```

Steps:
1. Create parent transport pair (PostMessage or ByteTransport)
2. Request a channel on the parent transport (dedicated to PTOC)
3. Register a message type on the channel (or use numeric type 0)
4. Create `NestedTransport` instances with the channel and message type
5. Start both nested transports

### Unit Tests

Unit tests for `NestedTransport` follow the same pattern as `PipeTransport` and `WebSocketTransport`:
- Constructor validation
- `startReader()` / `writeBytes()` / `stop()` protected methods
- Channel event handling (`beforeClosing`, `closed`, `disconnected`)
- `stop({ disconnected: true })` redirect to graceful stop
- Disconnect propagation from parent channel

### Integration Tests

Integration tests use the shared suite files (`channel-close.suite.js`, `transport-lifecycle.suite.js`, etc.) with a `makeNestedTransportPair()` factory function.

---

## Summary of Changes by File

### `src/transport/nested.esm.js` (new)

1. `NestedTransport` class extending `ByteTransport`
2. Constructor: `{ channel, messageType, ...options }`
3. Protected `startReader()`: calls `super.startReader()`, launches `#channelReader()`
4. Protected `stop()`: calls `super.stop()` (no channel close)
5. Protected `writeBytes()`: writes to parent channel with `eom: false`
6. Public `stop()` override: redirects `disconnected: true` to graceful stop
7. `#channelReader()`: reads chunks from parent channel, feeds into `receiveBytes()`
8. Channel event listeners: `beforeClosing` → graceful stop, `closed`/`disconnected` → disconnected stop

### `test/transport-nested-helpers.js` (new)

1. `makeNestedTransportPair()` factory function
2. Creates parent transport pair, channel, and nested transports

### `test/transport-unit/transport-nested.test.js` (new)

Unit tests for `NestedTransport`.

### `test/integration/nested/` (new)

Integration tests using shared suites.

---

## Open Questions / Notes

1. **Message type negotiation**: If `messageType` is a string, the parent channel must negotiate the numeric ID before PTOC can start. The `NestedTransport.start()` should wait for the message type to be registered before proceeding with the handshake. This may require calling `channel.addMessageTypes([messageType])` before `super.start()`.
   - No - string message types must be pre-negotated on the host channel *before* PTOC transport construction (`messageType` must *already* be valid).

2. **Flow control interaction**: PTOC's `writeBytes()` calls `channel.write()` which is subject to the parent channel's flow control. If the parent channel's budget is exhausted, `writeBytes()` will block. This is correct behavior — backpressure propagates from the parent channel to the PTOC output buffer.

3. **`startReader()` timing**: The `#channelReader()` must start before the PTOC handshake is sent, so the remote's handshake response can be received. `super.startReader()` starts `#byteReader()` which waits for input, and `#channelReader()` feeds input to it. The order is: `startReader()` → `#byteReader()` starts waiting → `#channelReader()` starts reading → handshake sent → remote handshake received → `#channelReader()` feeds bytes → `#byteReader()` processes handshake.
