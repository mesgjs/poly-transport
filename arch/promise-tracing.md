# Promise Tracing Architecture

**Status**: [APPROVED]

## Overview

Promise tracing is a diagnostic feature that tracks long-lived (potentially hung) async waits
within a PolyTransport instance. When enabled, every blocking wait registers its promise with a
timestamp and a human-readable description. A background interval timer periodically scans the
registry and logs any wait that has been outstanding longer than the configured threshold.
Promises that settle (resolve or reject) are removed from the registry automatically.

The feature is designed to be zero-overhead when disabled and low-overhead (and "low-noise") when enabled.

**Low-noise behavior**:
- Each overdue wait is auto-reported **exactly once** by the interval scanner, and assigned an
  auto-incrementing **event ID** at that point.
- Subsequent scans skip already-reported entries (no repeated log spam).
- When an auto-reported promise finally settles, a **resolution log** is emitted before the
  entry is removed, confirming the wait is over and referencing the original event ID.
- On-demand `report()` always shows all currently-pending entries regardless of reported status,
  and includes the event ID when one has been assigned.
- `stop()` auto-reports any pending waits (likely a sign of issues), but suppresses the
  "No pending waits" message (clean shutdown is normal and not worth logging).

---

## Motivation

PolyTransport has several places where async operations can block indefinitely:

| Location | Condition |
|---|---|
| [`ChannelFlowControl.writable()`](../src/channel-flow-control.esm.js:492) | Writer waiting for remote ACKs to free budget |
| [`ChannelFlowControl.allWritesAcked()`](../src/channel-flow-control.esm.js:111) | Channel close waiting for all in-flight writes to be ACKed |
| [`Channel.read()`](../src/channel.esm.js:637) | Reader waiting for incoming data |
| [`Transport.requestChannel()`](../src/transport/base.esm.js:704) | Waiting for remote to accept/reject a channel request |
| [`ByteTransport.#readable()`](../src/transport/byte.esm.js:380) | Byte-stream reader waiting for more input bytes |
| [`ByteTransport.reservable()`](../src/transport/byte.esm.js:89) | Writer waiting for ring-buffer space to become available |

When a test or production scenario hangs, it is currently difficult to determine which of these
waits is the culprit. Promise tracing makes this immediately visible.

---

## Configuration

### Transport Option

The `promiseTracer` transport option accepts a pre-configured `PromiseTracer` instance (or nothing to
disable tracing). The application constructs the tracer with its desired settings and passes it
to the transport:

```javascript
import { PromiseTracer } from './src/promise-tracer.esm.js';

const promiseTracer = new PromiseTracer(5000, {
    log: console.warn.bind(console),  // bound logger function
    // intervalMs: 5000,              // defaults to thresholdMs
});

const transport = new PipeTransport({
    promiseTracer,   // pre-configured PromiseTracer instance
    // ...other options
});
```

- **`promiseTracer: <PromiseTracer>`** — Enable tracing with the provided tracer.
- **`promiseTracer` absent / `null` / `undefined`** — Disabled (default). No overhead.

This design gives the application full control over the tracer's threshold, log function, and
interval before passing it to the transport. The transport does not construct the tracer itself.

### Propagation to Channels

When the transport creates a channel (in [`Transport.#createChannel()`](../src/transport/base.esm.js:219)),
it passes the `PromiseTracer` instance (or `null`) to the channel constructor. The channel stores
it and passes it to [`ChannelFlowControl`](../src/channel-flow-control.esm.js) at construction time.

This means:
- All channels on a tracing-enabled transport are automatically traced.
- Channels on a non-tracing transport have zero overhead (no tracer object, no checks).

---

## PromiseTracer Class

A new standalone module: **[`src/promise-tracer.esm.js`](../src/promise-tracer.esm.js)**

### Design Principle: Promise-Keyed Registry

The tracer maintains a `Map<Promise, entry>`. Calling code passes the promise object directly.
The tracer attaches a `.finally()` handler to auto-remove the entry when the promise settles.
**No extra state needs to be stored by the caller.**

### API

```javascript
class PromiseTracer {
    /**
     * @param {number} thresholdMs - Log waits outstanding longer than this many ms
     * @param {Object} options
     * @param {number} options.intervalMs - How often to scan (default: thresholdMs)
     * @param {function} options.log - Bound log function for all output (default: console.warn)
     */
    constructor (thresholdMs, { intervalMs, log } = {})

    /**
     * Register a promise for tracing.
     * The promise is automatically removed from the registry when it settles.
     * Returns the same promise (for chaining convenience).
     *
     * @param {Promise} promise - The promise to track
     * @param {string} description - Human-readable description of what is being waited for
     * @returns {Promise} The same promise (pass-through)
     */
    trace (promise, description)

    /**
     * Explicitly remove a promise from the registry before it settles.
     * No-op if the promise is not registered.
     *
     * @param {Promise} promise
     */
    clear (promise)

    /**
     * Immediately log all currently-tracked promises (regardless of age).
     * Useful at end of test, on SIGUSR1, etc.
     *
     * @param {Object} options
     * @param {boolean} options.overdueOnly - Only report waits past threshold (default: false)
     * @param {boolean} options.quiet - Suppress "No pending waits" message (default: false)
     */
    report ({ overdueOnly, quiet } = {})

    /**
     * Stop the interval timer and auto-report any pending waits (quiet mode).
     * Pending waits at stop time are likely a sign of issues, so they are always reported.
     * The "No pending waits" message is suppressed since clean shutdown is normal.
     */
    stop ()
}
```

### Internal State

```javascript
#registry = new Map();   // Map<Promise, { trace: Error, timestamp: number, eventId: number|null }>
#nextEventId = 1;        // Auto-incrementing event ID (assigned at first auto-report)
#timer = null;
#thresholdMs;
#intervalMs;
#log;                    // Bound log function
```

### Entry Structure

```javascript
{
    trace: Error,          // Error object created at trace() call site; .message = description,
                           // .stack captured immediately but formatted lazily on first access
    timestamp: number,     // Date.now() at registration
    eventId: number|null,  // Assigned when first auto-reported; null until then
}
```

`description` is not stored separately — it is available as `entry.trace.message`.

### Lazy Stack Trace Capture

At `trace()` time, `new Error(description)` is created. This captures the current call stack
immediately and cheaply — the V8 engine records the stack frames as internal data structures.
The `.stack` getter, which formats those frames into a human-readable string, is **not called**
at this point.

When the wait goes overdue and is auto-reported, `entry.trace.stack` is accessed for the
first time, materializing the stack trace string only when it is actually needed. This is the
"posthumous" generation: the call-site information is captured eagerly, but the formatting cost
is deferred until it is useful.

The resulting stack trace shows the PolyTransport call site (e.g., inside `writable()`) plus
the application frames that triggered it — exactly the information needed to identify the source
of a hang. Using `new Error(description)` means the `.stack` string includes the description as
the error message, making the output self-contained.

### `trace(promise, description)` Implementation

```javascript
trace (promise, description) {
    const timestamp = Date.now();
    const trace = new Error(description); // Captures stack now; .stack formatted lazily
    this.#registry.set(promise, { trace, timestamp, eventId: null });
    promise.finally(() => {
        const entry = this.#registry.get(promise);
        if (entry?.eventId !== null) {
            // This wait was auto-reported; log its resolution
            const age = Date.now() - entry.timestamp;
            this.#log(`[TRACE #${entry.eventId}] Resolved after ${age}ms: ${entry.trace.message}`);
        }
        this.#registry.delete(promise);
    });
    return promise;
}
```

Key properties:
- The `.finally()` handler is attached once and fires regardless of resolve/reject.
- The `Map` key is the promise object itself (identity, not value).
- Returns the promise for optional chaining: `await tracer.trace(somePromise, 'desc')`.
- If `trace()` is called with the same promise twice, the second call overwrites the first
  entry (same key), and the first `.finally()` will still fire and delete it — harmless.

### `clear(promise)` Implementation

```javascript
clear (promise) {
    this.#registry.delete(promise);
}
```

Explicit removal is provided for cases where the caller wants to remove a promise before it
settles (e.g. when a waiter is cancelled by a disconnect and the promise is replaced). In
practice, the auto-`.finally()` makes this rarely necessary, but it is available.

### Interval Scan

```javascript
#scan () {
    const now = Date.now(), threshold = this.#thresholdMs;
    for (const [_promise, entry] of this.#registry) {
        if (entry.eventId !== null) continue; // Already reported; skip
        const age = now - entry.timestamp;
        if (age >= threshold) {
            entry.eventId = this.#nextEventId++;
            this.#log(
                `[TRACE #${entry.eventId}] ${new Date(entry.timestamp).toISOString()} (${age}ms)\n${entry.trace.stack}`
            );
        }
    }
}
```

Each overdue entry is reported exactly once. The assigned `eventId` prevents re-reporting on
subsequent scans and links the initial report to the eventual resolution log. The full
`entry.trace.stack` is logged (which includes the description as the error message plus the
call-site stack frames).

### `report()` Implementation

```javascript
report ({ overdueOnly = false, quiet = false } = {}) {
    const now = Date.now(), threshold = this.#thresholdMs;
    const entries = [...this.#registry.values()].sort((a, b) => a.timestamp - b.timestamp);
    if (!entries.length) {
        if (!quiet) this.#log('[TRACE] No pending waits.');
        return;
    }
    for (const entry of entries) {
        const age = now - entry.timestamp;
        if (!overdueOnly || age >= threshold) {
            const idPart = entry.eventId !== null ? ` #${entry.eventId}` : '';
            this.#log(
                `[TRACE${idPart}] ${new Date(entry.timestamp).toISOString()} (${age}ms)\n${entry.trace.stack}`
            );
        }
    }
}
```

### `stop()` Implementation

```javascript
stop () {
    if (this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
    }
    this.report({ quiet: true }); // Report pending waits; suppress "No pending waits"
}
```

---

## Integration Points

The calling pattern at every wait site is uniform and minimal:

```javascript
tracer?.trace(promise, 'description of what we are waiting for');
```

The promise is already being created and awaited; `trace()` is a single additional line that
requires no extra variables, no `finally` blocks, and no cleanup code in the caller.

### 1. Transport Base — `Transport` constructor

The tracer is stored as a plain private field `#promiseTracer` on `Transport` (not in the protected
state object). Since there is a public `get promiseTracer()` getter, subclasses and protected methods
can access it via `this.__this.promiseTracer` without needing it in the protected state.

```javascript
#promiseTracer;  // Private field on Transport

constructor (options = {}) {
    // ...
    this.#promiseTracer = options.promiseTracer ?? null;
}

get promiseTracer () { return this.#promiseTracer; }
```

The tracer is stopped in [`Transport.#finalizeStop()`](../src/transport/base.esm.js:270) and
[`Transport.#onDisconnect()`](../src/transport/base.esm.js:604):

```javascript
this.#promiseTracer?.stop();
```

### 2. Transport Base — `Transport.requestChannel()`

```javascript
// After creating request.promise:
this.#promiseTracer?.trace(request.promise, `Transport ${_thys.id} requesting channel "${name}"`);
// (auto-removed when promise resolves or rejects)
return request.promise;
```

### 3. Channel — `Channel.read()`

```javascript
// After creating the reader promise:
const promise = new Promise((...r) => [reader.resolve, reader.reject] = r);
this.#_.promiseTracer?.trace(promise,
    `Channel "${this.#name}" read waiting for ${only ? JSON.stringify(only) : 'any'} message`
);
// ... existing await promise ...
```

### 4. ChannelFlowControl — `writable()`

```javascript
async writable (bytes) {
    if (this.writeBudget > bytes) return;

    const promise = new Promise((resolve, reject) => {
        this.#writer = { bytes, resolve, reject };
    });
    this.#promiseTracer?.trace(promise,
        `Channel "${this.#channel?.name}" write blocked: need ${bytes} bytes, budget ${this.writeBudget} / limit ${this.#writeLimit}`
    );
    return promise;
}
```

No changes needed to the wakeup path — the `.finally()` on the promise handles cleanup.

### 5. ChannelFlowControl — `allWritesAcked()`

```javascript
allWritesAcked () {
    if (!this.#writeAckInfo.size) return Promise.resolve();

    const existing = this.#allWritesAcked;
    if (existing) return existing.promise;

    const promise = this.#allWritesAcked = {};
    promise.promise = new Promise((...r) => [promise.resolve, promise.reject] = r);
    this.#promiseTracer?.trace(promise.promise,
        `Channel "${this.#channel?.name}" close waiting for ${this.#writeAckInfo.size} in-flight write(s) to be ACKed`
    );
    return promise.promise;
}
```

### 6. ByteTransport — `reservable()`

`ByteTransport`'s protected methods access the tracer via `thys.promiseTracer` (the public getter on
the `Transport` base class, where `thys = this.__this`).

```javascript
reservable (size) {
    // ...
    const waiter = _thys.reserveWaiter = { size };
    const promise = waiter.promise = new Promise((...r) => [waiter.resolve, waiter.reject] = r);
    thys.promiseTracer?.trace(promise,
        `Transport ${thys.id} ring-buffer reservation blocked: need ${size} bytes, available ${outputBuffer.available} / size ${outputBuffer.size}`
    );
    return promise;
},
```

### 7. ByteTransport — `#readable()`

`#readable()` is a private method on `ByteTransport` and has direct access to `this` (the
`ByteTransport` instance), which inherits the public `get promiseTracer()` getter from `Transport`.

```javascript
#readable (count) {
    const _thys = this.#_;
    const { inputBuffer } = _thys;
    if (inputBuffer.length >= count) return;

    const waiter = { count };
    const promise = new Promise((...r) => [waiter.resolve, waiter.reject] = r);
    this.promiseTracer?.trace(promise,
        `Transport ${this.id} byte-stream reader waiting for ${count} bytes (have ${inputBuffer.length})`
    );
    _thys.readWaiter = waiter;
    return promise;
}
```

---

## Manual Report Trigger

The application is responsible for all manual trigger mechanisms. The transport exposes
`transport.promiseTracer` for this purpose.

### End of Test

```javascript
transport.promiseTracer?.report();
await transport.stop();
```

### SIGUSR1 Handler (Deno / Node.js)

```javascript
Deno.addSignalListener('SIGUSR1', () => {
    transport.promiseTracer?.report();
});
```

### Programmatic Snapshot (overdue only)

```javascript
transport.promiseTracer?.report({ overdueOnly: true });
```

---

## Log Format

All trace messages use the prefix `[TRACE]` to make them easy to grep. A single bound `log`
function is used for all output; the application controls the log level by choosing which
function to bind (e.g. `console.warn`, `console.error`, a custom logger method).

**Interval scan — first auto-report of an overdue wait** (assigns event ID, includes stack):
```
[TRACE #1] 2026-04-17T02:30:00.000Z (6234ms)
Error: Channel "data" write blocked: need 16384 bytes, budget 0 / limit 65536
    at ChannelFlowControl.writable (channel-flow-control.esm.js:492:5)
    at Channel.#write (channel.esm.js:1152:3)
    at Channel.write (channel.esm.js:1039:10)
    at MyApp.sendData (app.js:42:18)
    ...
```

**Resolution of an auto-reported wait** (references event ID, no stack):
```
[TRACE #1] Resolved after 8102ms: Channel "data" write blocked: need 16384 bytes, budget 0 / limit 65536
```

**Manual report — mix of reported and unreported entries** (includes stack for all):
```
[TRACE] 2026-04-17T02:30:00.000Z (1200ms)
Error: Transport abc123 requesting channel "control"
    at Transport.requestChannel (base.esm.js:739:5)
    ...
[TRACE #1] 2026-04-17T02:30:00.000Z (6234ms)
Error: Channel "data" write blocked: need 16384 bytes, budget 0 / limit 65536
    at ChannelFlowControl.writable (channel-flow-control.esm.js:492:5)
    ...
```

**`stop()` with no pending waits** — silent (quiet mode).

**`stop()` with pending waits** — same format as manual report.

---

## Description Templates

| Wait site | Description template |
|---|---|
| `Transport.requestChannel()` | `Transport <id> requesting channel "<name>"` |
| `Channel.read()` | `Channel "<name>" read waiting for <only \| 'any'> message` |
| `ChannelFlowControl.writable()` | `Channel "<name>" write blocked: need <bytes> bytes, budget <budget> / limit <limit>` |
| `ChannelFlowControl.allWritesAcked()` | `Channel "<name>" close waiting for <N> in-flight write(s) to be ACKed` |
| `ByteTransport.reservable()` | `Transport <id> ring-buffer reservation blocked: need <size> bytes, available <avail> / size <total>` |
| `ByteTransport.#readable()` | `Transport <id> byte-stream reader waiting for <count> bytes (have <have>)` |

---

## Accessing the Tracer in Subclasses

The tracer is stored as a private field `#promiseTracer` on `Transport` and exposed via the public
`get promiseTracer()` getter. Subclasses access it as follows:

- **Private methods** (e.g. `ByteTransport.#readable()`): `this.promiseTracer` — direct access via
  inherited public getter.
- **Protected methods** (e.g. `ByteTransport.__protected.reservable()`): `thys.promiseTracer` where
  `thys = this.__this` — access via the public getter on the `Transport` instance.
- **`Channel` and `ChannelFlowControl`**: receive the tracer as a constructor option
  (`options.promiseTracer`) and store it as their own private field.

---

## Lifecycle

```
Application creates PromiseTracer with desired settings
  → new PromiseTracer(5000, { log: console.warn.bind(console) })
  → Interval timer started

Transport constructed with promiseTracer option
  → new PipeTransport({ promiseTracer, ... })
  → Tracer stored as private field #promiseTracer on Transport

Transport.start() called
  → Channels created, tracer reference passed to each channel and flow control

[waits tracked; overdue waits auto-reported once with event ID and stack trace]
[resolved auto-reported waits log their resolution with matching event ID]

transport.promiseTracer.report()  ← optional manual snapshot at any time (app-controlled)

Transport.stop() / disconnect
  → PromiseTracer.stop() called
  → report({ quiet: true }) — logs pending waits if any, silent if none
  → Interval timer cleared
```

---

## Non-Goals

- **PostMessage transport**: The `PostMessageTransport` does not use `ByteTransport` and has no
  ring buffer or byte-stream reader. It does not need `reservable()` or `#readable()` tracing.
  The channel-level waits (`read()`, `writable()`, `allWritesAcked()`) still apply.
- **TCC/C2C channels**: These are internal channels. They receive the tracer like any other
  channel, so their waits are also tracked. No special treatment needed.
- **Nested transport**: `NestedTransport` extends `ByteTransport`. It inherits all byte-level
  tracing automatically. The parent channel's waits are tracked by the parent transport's tracer.
- **Per-channel enable/disable**: Not supported. Tracing is transport-wide.
- **Persistence**: Trace logs are written via the `log` function only; no file or structured output.
- **SIGUSR1 / signal handling**: The application is responsible for all manual trigger mechanisms.
- **Tracer construction**: The transport does not construct the tracer; the application does.

---

## Files to Create / Modify

| File | Change |
|---|---|
| [`src/promise-tracer.esm.js`](../src/promise-tracer.esm.js) | **New** — `PromiseTracer` class |
| [`src/transport/base.esm.js`](../src/transport/base.esm.js) | Add `promiseTracer` option (pre-configured `PromiseTracer` or null), store as private field `#promiseTracer`, add `promiseTracer` public getter, pass tracer to channels, call `promiseTracer.stop()` on shutdown |
| [`src/channel.esm.js`](../src/channel.esm.js) | Accept `promiseTracer` option, pass to `ChannelFlowControl`, add `promiseTracer?.trace()` to `read()` |
| [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js) | Accept `promiseTracer` option, add `promiseTracer?.trace()` to `writable()` and `allWritesAcked()` |
| [`src/transport/byte.esm.js`](../src/transport/byte.esm.js) | Add `promiseTracer?.trace()` to `reservable()` and `#readable()` |
| [`test/unit/promise-tracer.test.js`](../test/unit/promise-tracer.test.js) | **New** — Unit tests for `PromiseTracer` |
