# PolyTransport

A versatile, bidirectional, multi-transport, content-streaming library with sliding-window flow control for JavaScript.

PolyTransport provides a unified API for communication over multiple transport mechanisms — WebSockets, IPC pipes, Web Workers (via `postMessage`), and nested transports — with automatic backpressure, multi-channel multiplexing, and structured message types.

## Features

- **Unified API** across all transport types
- **Multiple transports**: WebSocket, IPC pipes, Web Workers (`postMessage`), and nested (PolyTransport-over-Channel)
- **Multi-channel multiplexing**: Many logical channels over a single transport connection
- **Sliding-window flow control**: Automatic backpressure prevents buffer overflow
- **Bidirectional streaming**: Both sides can send and receive on every channel
- **Structured message types**: Register named message types for organized communication
- **Async/await friendly**: All I/O operations return Promises
- **Zero-copy output**: Ring-buffer-based encoding for byte-stream transports
- **Security-conscious**: Per-channel budget isolation prevents misbehaving channels from affecting others

## Installation
PolyTransport is a pure ES module library. It depends on three small companion libraries (loaded via CDN in the Deno configuration):

- [`@eventable`](https://github.com/mesgjs/eventable) — async event handling
- [`@task-queue`](https://github.com/mesgjs/task-queue) — serialized async task execution
- [`@updatable-event`](https://github.com/mesgjs/updatable-event) — mutable event objects

Import the transport class you need directly:


```javascript
// Web Worker / postMessage transport
import { PostMessageTransport } from './src/transport/post-message.esm.js';

// IPC pipe transport (Deno)
import { PipeTransport } from './src/transport/pipe.esm.js';

// WebSocket transport
import { WebSocketTransport } from './src/transport/websocket.esm.js';

// Nested (PolyTransport-over-Channel) transport
import { NestedTransport } from './src/transport/nested.esm.js';
```

## Quick Start

### Web Worker (postMessage)

**Main thread:**
```javascript
import { PostMessageTransport } from './src/transport/post-message.esm.js';

const worker = new Worker('./worker.js', { type: 'module' });
const transport = new PostMessageTransport({ gateway: worker });

transport.addEventListener('newChannel', (event) => {
    const { channelName } = event.detail;
    if (channelName === 'my-channel') {
        event.accept();
    } else {
        event.reject();
    }
});

await transport.start();

const channel = await transport.requestChannel('my-channel');
await channel.write(0, 'Hello from main thread!', { eom: true });

const reply = await channel.read();
console.log(reply.text); // "Hello from worker!"

await channel.close();
await transport.stop();
```

**Worker (`worker.js`):**
```javascript
import { PostMessageTransport } from './src/transport/post-message.esm.js';

const transport = new PostMessageTransport({ gateway: self });

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

const channel = await transport.requestChannel('my-channel');
const msg = await channel.read();
console.log(msg.text); // "Hello from main thread!"

await channel.write(0, 'Hello from worker!', { eom: true });
await channel.close();
await transport.stop();
```

### IPC Pipes (Deno)

**Parent process:**
```javascript
import { PipeTransport } from './src/transport/pipe.esm.js';

const cmd = new Deno.Command('deno', {
    args: ['run', '--allow-read', 'child.js'],
    stdin: 'piped',
    stdout: 'piped',
});
const child = cmd.spawn();

const transport = new PipeTransport({
    readable: child.stdout,
    writable: child.stdin,
});

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

const channel = await transport.requestChannel('data');
await channel.write(0, JSON.stringify({ hello: 'world' }), { eom: true });

const response = await channel.read({ decode: true });
console.log(response.text);

await channel.close();
await transport.stop();
```

**Child process (`child.js`):**
```javascript
import { PipeTransport } from './src/transport/pipe.esm.js';

const transport = new PipeTransport({
    readable: Deno.stdin.readable,
    writable: Deno.stdout.writable,
});

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

const channel = await transport.requestChannel('data');
const msg = await channel.read({ decode: true });
const data = JSON.parse(msg.text);
console.error('Received:', data); // stderr (not captured)

await channel.write(0, JSON.stringify({ received: true }), { eom: true });
await channel.close();
await transport.stop();
```

### WebSocket

**Server (Deno):**
```javascript
import { WebSocketTransport } from './src/transport/websocket.esm.js';

Deno.serve((req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const transport = new WebSocketTransport({ ws: socket });

    transport.addEventListener('newChannel', (event) => {
        event.accept();
    });

    transport.start().then(async () => {
        const channel = await transport.requestChannel('chat');
        const msg = await channel.read({ decode: true });
        console.log('Client says:', msg.text);

        await channel.write(0, 'Hello from server!', { eom: true });
        await channel.close();
        await transport.stop();
    });

    return response;
});
```

**Client (browser or Deno):**
```javascript
import { WebSocketTransport } from './src/transport/websocket.esm.js';

const ws = new WebSocket('ws://localhost:8000');
const transport = new WebSocketTransport({ ws });

transport.addEventListener('newChannel', (event) => {
    event.accept();
});

await transport.start();

const channel = await transport.requestChannel('chat');
await channel.write(0, 'Hello from client!', { eom: true });

const reply = await channel.read({ decode: true });
console.log('Server says:', reply.text);

await channel.close();
await transport.stop();
```

### Nested Transport (PolyTransport-over-Channel)

A `NestedTransport` runs a full PolyTransport session over a dedicated message type on an existing channel. This enables complex routing scenarios.

```javascript
import { NestedTransport } from './src/transport/nested.esm.js';

// Assume parentChannelA and parentChannelB are already open and connected

// Register a dedicated message type for PTOC traffic
await parentChannelA.addMessageTypes(['ptoc']);
// (parentChannelB receives the registration automatically)

const nestedA = new NestedTransport({ channel: parentChannelA, messageType: 'ptoc' });
const nestedB = new NestedTransport({ channel: parentChannelB, messageType: 'ptoc' });

nestedB.addEventListener('newChannel', (event) => {
    event.accept();
});

await Promise.all([nestedA.start(), nestedB.start()]);

const channel = await nestedA.requestChannel('inner');
await channel.write(0, 'Nested message!', { eom: true });

const msg = await (await nestedB.requestChannel('inner')).read({ decode: true });
console.log(msg.text); // "Nested message!"
```

## Core Concepts

### Transports

A **transport** is a communication pathway between two endpoints. Each transport:

- Manages multiple bidirectional channels
- Implements flow control
- Has a lifecycle: `start()` → active → `stop()`

### Channels

A **channel** is a logical bidirectional communication stream over a transport. Channels:

- Are identified by a string name
- Support independent flow control per direction
- Can be opened and closed independently of the transport
- Support message-type registration for structured communication

### Messages and Chunks

A **message** is an application-defined unit of content. Large messages are automatically split into **chunks** for transmission. The `eom: true` flag marks the last chunk of a message. By default, `channel.read()` reassembles chunks into complete messages automatically.

### Flow Control

PolyTransport uses per-channel sliding-window flow control. Each channel has an independent budget — a misbehaving channel can only block itself, not other channels. Backpressure is automatic: `channel.write()` awaits budget availability transparently.

## API Reference

### Transport

#### Constructor Options (all transports)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bufferPool` | `BufferPool` | — | Shared buffer pool instance |
| `logger` | object | `console` | Logger (`{ error, warn, info, debug }`) |
| `maxChunkBytes` | number | 16384 | Maximum chunk size in bytes |
| `lowBufferBytes` | number | 16384 | ACK low-water mark in bytes |
| `c2cSymbol` | Symbol | — | Symbol for accessing the Console Content Channel |

#### Transport-Specific Constructor Options

**`PostMessageTransport`**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `gateway` | object | ✓ | Object with `postMessage()` and `addEventListener('message', ...)` (e.g. `Worker`, `self`, `MessagePort`) |

**`PipeTransport`**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `readable` | `ReadableStream<Uint8Array>` | ✓ | Input byte stream |
| `writable` | `WritableStream<Uint8Array>` | ✓ | Output byte stream |

**`WebSocketTransport`**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `ws` | `WebSocket` | ✓ | WebSocket instance (open or opening) |

**`NestedTransport`**

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `channel` | `Channel` | ✓ | Pre-opened parent channel |
| `messageType` | `string\|number` | ✓ | Dedicated message type for PTOC traffic (string must be pre-registered) |

#### Lifecycle Methods

```javascript
await transport.start()
```
Starts the transport. For byte-stream transports, performs the protocol handshake. Resolves when the transport is active and ready for channel operations.

```javascript
await transport.stop({ discard = false, timeout } = {})
```
Gracefully stops the transport. Closes all channels, exchanges stop handshake with remote, then resolves. Pass `discard: true` to skip waiting for in-flight data.

#### Channel Methods

```javascript
const channel = await transport.requestChannel(name, options = {})
```
Requests a new channel. The remote's `newChannel` event handler must call `accept()`. Returns a `Channel` instance.

| Option | Type | Description |
|--------|------|-------------|
| `maxBufferBytes` | number | Maximum receive buffer size |
| `maxChunkBytes` | number | Maximum chunk size |
| `lowBufferBytes` | number | ACK low-water mark |
| `timeout` | number | Timeout in milliseconds |

```javascript
const channel = transport.getChannel(name)
```
Returns an existing channel by name, or `undefined`.

#### Transport Events

```javascript
transport.addEventListener('newChannel', (event) => {
    const { channelName, remoteLimits } = event.detail;
    const channelPromise = event.accept(options); // Returns Promise<Channel>
});
```
Fired when the remote requests a new channel. Call `event.accept(options)` to accept the request. `accept()` returns a `Promise<Channel>` that resolves to the accepted channel once it is created, allowing the event handler to dispatch message processors directly without a separate `getChannel()` call. Options from multiple `accept()` calls across handlers are merged. If no handler calls `accept()`, the request is rejected.

> **Note**: `event.reject()` is deprecated and has no effect. The channel is created if any handler calls `accept()`.

```javascript
transport.addEventListener('beforeStopping', (event) => { /* ... */ });
transport.addEventListener('stopped', (event) => { /* ... */ });
```
Transport lifecycle events.

#### Transport State

```javascript
transport.state        // Numeric state constant
transport.stateString  // 'created' | 'starting' | 'active' | 'stopping' | 'localStopping' | 'remoteStopping' | 'stopped' | 'disconnected'
transport.id           // Transport UUID
```

---

### Channel

#### Message Type Methods

```javascript
const results = await channel.addMessageTypes(['type-a', 'type-b'])
```
Registers named message types with the remote. Returns `Promise.allSettled(...)`. Throws `StateError` if the channel is closing or closed.

```javascript
const info = channel.getMessageType('type-a')
// Returns: { ids: number[], type: string }
```

#### Write

```javascript
await channel.write(messageType, source, options = {})
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `messageType` | `string\|number` | Registered name or numeric ID |
| `source` | `string\|Uint8Array\|VirtualBuffer\|function\|null` | Data to send |
| `options.eom` | boolean | End-of-message flag (default: `true`) |
| `options.together` | boolean | Send all chunks in one task (default: `true`) |

Resolves when all chunks are queued (not necessarily sent). Throws `StateError` if the channel is closing or closed.

#### Read

```javascript
const message = await channel.read(options = {})
```

| Option | Type | Description |
|--------|------|-------------|
| `only` | `string\|number\|Array\|Set` | Filter by message type |
| `timeout` | number | Timeout in milliseconds |
| `dechunk` | boolean | Reassemble chunks into complete message (default: `true`) |
| `decode` | boolean | Auto-decode binary data to text (default: `false`) |
| `withHeaders` | boolean | Include chunk headers in result (default: `false`) |

Returns a **message object**, or `null` if the channel was closed, disconnected, or the timeout expired. Check `channel.state` after a `null` return to determine why: `Channel.STATE_OPEN` means timeout (channel still open); `Channel.STATE_CLOSED` means graceful close; `Channel.STATE_DISCONNECTED` means abrupt disconnect.

```javascript
{
    messageType,    // Registered name (string) or numeric ID
    messageTypeId,  // Numeric ID
    text,           // Decoded text (if decode: true or string data)
    data,           // VirtualBuffer (binary data)
    dataSize,       // Total bytes
    eom,            // End-of-message flag
    done(),         // Mark all sequences as processed (triggers ACK)
    process(cb),    // Calls cb, then done() in a finally block
    headers,        // Array of chunk headers (if withHeaders: true)
}
```

> **Important**: Call `message.done()` (or use `message.process(cb)`) after processing each message to release flow control budget and allow the remote to send more data.

Typical reader loop:

```javascript
while (true) {
    const msg = await channel.read();
    if (!msg) break; // Channel closed or disconnected
    await msg.process(async (m) => {
        // handle message
    });
}
```

```javascript
const message = channel.readSync(options = {})
```
Synchronous read — returns immediately with a message or `null` if none is available.

#### Lifecycle

```javascript
await channel.close({ discard = false } = {})
```
Closes the channel. Waits for all in-flight writes to be acknowledged, then exchanges close handshake with remote. Pass `discard: true` to immediately discard buffered input.

#### Channel Events

```javascript
channel.addEventListener('beforeClose', (event) => { /* ... */ });
channel.addEventListener('closed', (event) => { /* ... */ });
```

```javascript
channel.addEventListener('newMessageType', (event) => {
    const { type } = event.detail;
    // Call event.preventDefault() to reject the registration
});
```

```javascript
transport.addEventListener('protocolViolation', (event) => {
    const { type, description } = event.detail;
    // Default action: stop transport
    // Call event.preventDefault() to suppress default
});
```

#### Channel State

```javascript
channel.state  // 'open' | 'closing' | 'localClosing' | 'remoteClosing' | 'closed' | 'disconnected'
channel.name   // Channel name
channel.id     // Active channel ID (lowest)
channel.ids    // All channel IDs (array)
```

---

## Error Classes

| Class | Description |
|-------|-------------|
| `StateError` | Operation invalid for current state (e.g. write on a closing channel) |

## Testing

PolyTransport uses [Deno](https://deno.land/)'s built-in test runner.

```bash
# Run all tests
deno test test

# Run unit tests only
deno test test/unit

# Run integration tests only
deno test test/integration
```

## Architecture

PolyTransport is organized into layers:

```
Application
    │
    ▼
Channel (channel.esm.js)
    │  Message types, flow control, chunking, de-chunking
    ▼
Transport Base (transport/base.esm.js)
    │  Channel lifecycle, TCC protocol, handshake
    ▼
ByteTransport / PostMessageTransport
    │  Byte-stream encoding or postMessage dispatch
    ▼
PipeTransport / WebSocketTransport / NestedTransport
    │  Concrete I/O
    ▼
OS / Browser / Parent Channel
```

**Key components:**

| File | Description |
|------|-------------|
| [`src/transport/base.esm.js`](src/transport/base.esm.js) | Abstract transport base class |
| [`src/transport/byte.esm.js`](src/transport/byte.esm.js) | Byte-stream transport base (ring buffer, handshake) |
| [`src/transport/post-message.esm.js`](src/transport/post-message.esm.js) | Web Worker / `postMessage` transport |
| [`src/transport/pipe.esm.js`](src/transport/pipe.esm.js) | IPC pipe transport |
| [`src/transport/websocket.esm.js`](src/transport/websocket.esm.js) | WebSocket transport |
| [`src/transport/nested.esm.js`](src/transport/nested.esm.js) | Nested (PTOC) transport |
| [`src/channel.esm.js`](src/channel.esm.js) | Channel implementation |
| [`src/channel-flow-control.esm.js`](src/channel-flow-control.esm.js) | Per-channel flow control |
| [`src/protocol.esm.js`](src/protocol.esm.js) | Binary protocol encoding/decoding |
| [`src/output-ring-buffer.esm.js`](src/output-ring-buffer.esm.js) | Zero-copy output ring buffer |
| [`src/virtual-buffer.esm.js`](src/virtual-buffer.esm.js) | Multi-segment virtual buffer views |
| [`src/buffer-pool.esm.js`](src/buffer-pool.esm.js) | Reusable buffer pool |

## License

MIT — see [LICENSE](LICENSE).

Copyright 2025–2026 Kappa Computer Solutions, LLC and Brian Katzung.
