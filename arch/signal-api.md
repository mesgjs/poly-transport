# Signal API

## Description

The purpose of this API is to provide a mechanism for simple signaling of events (such as pending channel closure or transport shutdown, for example) in a way that may be either consumed or safely ignored (i.e. without leaving unread, unprocessed messages).

Signal event handlers receive all signal events for the resource to which they are attached. Signal-handler authors should code in such a way as to filter out signals not intended for their handlers, although how that is accomplished is an application-specific concern.

PolyTransport operations generate dedicated events (e.g. `beforeStopping`, `stopped`, `beforeClosing`, `closed`), not signals.

## Sending

- `transport.signal(text)` sends text as body of a "signal" TCC data message
  - Example: `transport.signal(JSON.stringify({ event: 'beforeStopping', timeout: 30 }))`
- `channel.signal(text)` sends text as body of a "signal" channel control message
  - Example: `channel.signal(JSON.stringify({ event: 'beforeClosing' }))`
- `text` value presented as `event.detail`
- Like any other message, signals cannot be sent on closed channels

## Receiving

- `transport.addEventListener('signal', async handler)`
  - Message processed and event emitted by `Transport.#tccReader`
- `channel.addEventListener('signal', async handler)`
  - Message processed and event emitted by `Channel.#receiveControlMessage`
- Event dispatch is awaited before the message is marked processed (flow control)
- Signal messages are always delivered as text (auto-decoding as necessary for the transport)
- `handler(event: { detail: string|undefined, target: channel|transport, type: 'signal' })`
- The detail may be undefined or any string value (including, but not limited to, JSON or SLID format)

## Message Type/Protocol

- `export const TCC_CADM_SIGNAL = [9, 'signal'];`
- Both a control message (for channel-level signals) and a data message (for transport-level signals via TCC)

## Implementation

### Protocol Constant

Add to [`src/protocol.esm.js`](../src/protocol.esm.js):

```javascript
export const TCC_CADM_SIGNAL = [9, 'signal'];
```

This constant serves dual purpose:
- As a **TCC data message type** for transport-level signals (sent via `tcc.write(TCC_CADM_SIGNAL[0], text)`)
- As a **channel control message type** for channel-level signals (sent via `channel.#write(TCC_CADM_SIGNAL[0], text, { type: HDR_TYPE_CHAN_CONTROL })`)

### `transport.signal(text)` — [`src/transport/base.esm.js`](../src/transport/base.esm.js)

Add a public `signal(text)` method to the `Transport` class:

```javascript
/**
 * Send a transport-level signal to the remote peer.
 * @param {string|undefined} text - Signal payload (any string, or undefined)
 * @returns {Promise<void>}
 */
async signal (text) {
    const _thys = this.#_;
    if (_thys.state !== Transport.STATE_ACTIVE) {
        throw new StateError(`Cannot signal: transport is not active (${this.stateString})`);
    }
    const tcc = _thys.channels.get(CHANNEL_TCC);
    await tcc.write(TCC_CADM_SIGNAL[0], text ?? null);
}
```

**Notes**:
- Import `TCC_CADM_SIGNAL` from `protocol.esm.js` alongside the existing TCC message type imports.
- `text` may be `undefined` or any string; pass `null` to `tcc.write` when `text` is `undefined` (empty body).
- Throws `StateError` if the transport is not active (consistent with `requestChannel`).

### `channel.signal(text)` — [`src/channel.esm.js`](../src/channel.esm.js)

Add a public `signal(text)` method to the `Channel` class:

```javascript
/**
 * Send a channel-level signal to the remote peer.
 * @param {string|undefined} text - Signal payload (any string, or undefined)
 * @returns {Promise<void>}
 */
/* async */ signal (text) {
    return this.#write(TCC_CADM_SIGNAL[0], text ?? null, { type: HDR_TYPE_CHAN_CONTROL });
}
```

**Notes**:
- Import `TCC_CADM_SIGNAL` from `protocol.esm.js` alongside the existing imports.
- Uses the existing `#write` path with `type: HDR_TYPE_CHAN_CONTROL` (same as `addMessageTypes`).
- `#write` already enforces the open-channel check and throws `StateError` if the channel is closing or closed.
- `text` may be `undefined`; pass `null` to `#write` for an empty body.

### Transport-Level Signal Reception — [`src/transport/base.esm.js`](../src/transport/base.esm.js)

In `#tccReader()`, add a `case` for `TCC_CADM_SIGNAL[0]` in the `switch (messageTypeId)` block:

```javascript
case TCC_CADM_SIGNAL[0]:
    await this.dispatchEvent('signal', text ?? undefined);
    break;
```

**Notes**:
- `text` is already available in `#tccReader` from `const { messageTypeId, text } = message;`.
- The event detail is the raw text string (or `undefined` if the body was empty).
- `message.done()` is called in the `finally` block as normal (no `skipAck`).

### Channel-Level Signal Reception — [`src/channel.esm.js`](../src/channel.esm.js)

In `#receiveControlMessage()`, add a `case` for `TCC_CADM_SIGNAL[0]` in the first `switch (messageType)` block (the one that validates known types before accumulating chunks):

```javascript
case TCC_CADM_SIGNAL[0]: // Signal
    break;
```

Then add a corresponding `case` in the second `switch (messageType)` block (the one that processes the fully-assembled message after EOM):

```javascript
case TCC_CADM_SIGNAL[0]: // Signal
{
    const text = this.#parseChunkedText(controlChunks);
    await this.dispatchEvent('signal', text ?? undefined);
    break;
}
```

Because signal bodies are plain text (not JSON), a small helper is needed to extract the raw text from the accumulated chunks without JSON-parsing it. `#parseChunkedJSON` should be refactored to become a thin wrapper around `#parseChunkedText`:

```javascript
/**
 * Extract raw text from an array of control-message chunks (no JSON parsing)
 * @param {{header, data:(string|VirtualBuffer)}[]} chunks
 * @returns {string|undefined}
 */
#parseChunkedText (chunks) {
    const text = chunks.reduce((acc, chunk) => {
        if (typeof chunk.data === 'string') {
            acc ||= [];
            acc.push(chunk.data);
        } else if (chunk.data instanceof VirtualBuffer) {
            acc ||= [];
            acc.push(chunk.data.decode());
        }
        return acc;
    }, null)?.join('');
    return text ?? undefined;
}

/**
 * Parse JSON from an array of message chunks (wrapper around #parseChunkedText)
 * @param {{header, data:(string|VirtualBuffer)}[]} chunks
 * @returns {Object}
 */
#parseChunkedJSON (chunks) {
    const jsonText = this.#parseChunkedText(chunks);
    return (jsonText && JSON.parse(jsonText)) || {};
}
```

Use `#parseChunkedText` in the signal case. The existing `#parseChunkedJSON` callers (`mesgTypeReq`/`mesgTypeResp`) continue to work unchanged via the wrapper.

**Notes**:
- Event dispatch is `await`ed inside the `try` block, before `markProcessed` is called in `finally`.
- The `controlChunks` array is cleared in `finally` as normal.
- The event detail is the raw text string (or `undefined` if the body was empty/null).

### Event Dispatch Format

Both transport and channel signal events follow the same shape as other PolyTransport events:

```javascript
// Dispatched as:
await this.dispatchEvent('signal', text ?? undefined);

// Received as:
transport.addEventListener('signal', (event) => {
    // event.type   === 'signal'
    // event.detail === text string or undefined
    // event.target === transport or channel
});
```

The `dispatchEvent(type, detail)` overload in both `Transport` and `Channel` wraps the call as `{ type, detail }` for `Eventable`.

---

## Testing

### Unit Tests — Transport (`test/unit/transport-base.test.js`)

Add the following tests to [`test/unit/transport-base.test.js`](../test/unit/transport-base.test.js). Use the existing `startMockTransport()` helper and `simulateChannelRequest()` pattern.

**Helper**: Simulate an incoming TCC signal message (analogous to `simulateChannelRequest`):

```javascript
function simulateTransportSignal (transport, text) {
    const _thys = transport.getProtectedState();
    const tcc = _thys.channels.get(CHANNEL_TCC);
    const data = text ?? '';
    _thys.receiveMessage({
        type: HDR_TYPE_CHAN_DATA,
        headerSize: DATA_HEADER_BYTES,
        dataSize: data.length * 2,
        flags: FLAG_EOM,
        channelId: CHANNEL_TCC,
        sequence: tcc.nextReadSeq,
        messageType: TCC_CADM_SIGNAL[0],
        eom: true,
    }, data);
}
```

**Tests**:

1. **`transport.signal(text)` throws StateError when not active** — call `signal()` on a `STATE_CREATED` transport; assert `StateError` is thrown.

2. **`transport.signal(text)` sends a TCC message** — start a transport, spy on `sendChunk` to capture the message type; call `transport.signal('hello')`, assert the captured message type is `TCC_CADM_SIGNAL[0]`.

3. **`transport.signal(undefined)` sends a TCC message with empty body** — same as above but with `undefined` text; assert message type is `TCC_CADM_SIGNAL[0]` and body is empty/null.

4. **Transport `signal` event fires with correct detail** — start a transport, add a `signal` listener, call `simulateTransportSignal(transport, 'test payload')`, yield microtasks, assert the event fired with `detail === 'test payload'`.

5. **Transport `signal` event fires with `undefined` detail for empty body** — same as above with empty string body; assert `detail` is `undefined` (or empty string — confirm desired behavior).

6. **Transport `signal` event is awaited before `message.done()`** — verify that an async signal handler completes before the TCC reader proceeds (use a flag set inside an async handler and check it after yielding).

### Unit Tests — Channel (`test/unit/channel.test.js`)

Add the following tests to [`test/unit/channel.test.js`](../test/unit/channel.test.js). Use the existing `makeChannel()` helper and the `receiveMessage` pattern for simulating incoming control messages.

**Helper**: Simulate an incoming channel signal control message:

```javascript
function simulateChannelSignal (channel, token, text, seq) {
    const data = text ?? '';
    channel.receiveMessage(token, {
        type: HDR_TYPE_CHAN_CONTROL,
        headerSize: DATA_HEADER_BYTES,
        dataSize: data.length * 2,
        flags: FLAG_EOM,
        channelId: channel.id,
        sequence: seq,
        messageType: TCC_CADM_SIGNAL[0],
        eom: true,
    }, data);
}
```

**Tests**:

1. **`channel.signal(text)` throws StateError when channel is closing** — put channel in `STATE_CLOSING`, call `channel.signal('x')`, assert `StateError`.

2. **`channel.signal(text)` throws StateError when channel is closed** — put channel in `STATE_CLOSED`, call `channel.signal('x')`, assert `StateError`.

3. **`channel.signal(text)` sends a control message** — spy on the mock transport's `sendChunk`; call `channel.signal('hello')`, assert the captured message type is `TCC_CADM_SIGNAL[0]` and header type is `HDR_TYPE_CHAN_CONTROL`.

4. **`channel.signal(undefined)` sends a control message with empty body** — same as above with `undefined`; assert message type is `TCC_CADM_SIGNAL[0]`.

5. **Channel `signal` event fires with correct detail** — call `simulateChannelSignal(channel, token, 'payload', seq)`, assert the `signal` event fires with `detail === 'payload'`.

6. **Channel `signal` event fires with `undefined` detail for empty body** — same with empty string; assert `detail` is `undefined` (confirm desired behavior).

7. **Channel `signal` event is awaited before `markProcessed`** — verify that an async signal handler completes before flow control marks the chunk as processed.

8. **Multi-chunk signal message is reassembled before dispatch** — send two control chunks with `eom: false` then `eom: true`, both with `messageType: TCC_CADM_SIGNAL[0]`; assert the `signal` event fires once with the concatenated text.

### Integration Tests — Signal Suite (`test/integration/suites/signal.suite.js`)

Create a new shared suite file [`test/integration/suites/signal.suite.js`](../test/integration/suites/signal.suite.js) following the pattern of [`test/integration/suites/data-exchange.suite.js`](../test/integration/suites/data-exchange.suite.js).

**Tests**:

1. **Transport-level signal: A sends, B receives** — start two transports, add a `signal` listener on B's transport, call `transportA.signal('ping')`, assert B's handler fires with `detail === 'ping'`.

2. **Transport-level signal: B sends, A receives** — reverse direction.

3. **Transport-level signal with undefined text** — call `transportA.signal(undefined)`, assert B's handler fires with `detail === undefined`.

4. **Channel-level signal: A sends, B receives** — open a channel pair, add a `signal` listener on B's channel, call `channelA.signal('hello')`, assert B's handler fires with `detail === 'hello'`.

5. **Channel-level signal: B sends, A receives** — reverse direction.

6. **Channel-level signal with undefined text** — call `channelA.signal(undefined)`, assert B's handler fires with `detail === undefined`.

7. **Multiple signals in sequence** — send three transport-level signals from A; assert B receives all three in order.

8. **Signal does not interfere with data messages** — send a signal and a data message concurrently; assert both are received correctly and independently.

9. **Signal on closing channel throws StateError** — begin closing a channel, then attempt `channel.signal('x')`, assert `StateError` is thrown.

10. **No signal event when no listener** — send a signal with no listener registered; assert no error is thrown and the transport/channel continues to function normally.

**Wire up** the suite in transport-specific test files following the existing pattern (e.g., `test/integration/post-message/signal.test.js`, `test/integration/byte-transport/signal.test.js`, etc.).
