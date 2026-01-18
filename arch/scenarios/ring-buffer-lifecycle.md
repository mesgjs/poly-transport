# Ring Buffer Lifecycle Scenario

**Status**: Draft  
**Date**: 2026-01-16  
**Related**: [`output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js), [`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md), [`simple-write.md`](simple-write.md)

## Overview

This scenario documents the complete lifecycle of output ring buffers in PolyTransport, covering both byte-stream transports (single reusable ring) and Worker transports (virtual ring from pool buffers).

## Background

### Two Ring Buffer Strategies

**Byte-Stream Transports** (HTTP, WebSocket, IPC pipes, nested):
- Use single reusable ring buffer ([`OutputRingBuffer`](../../src/output-ring-buffer.esm.js))
- Zero-copy: encode → send views → consume (zero and reuse)
- `getBuffers()` returns 1-2 Uint8Array views (may wrap around ring boundary)
- Efficient for streaming I/O with system calls

**Worker Transport** (postMessage):
- Cannot transfer partial ring segments (must transfer complete ArrayBuffers)
- Need contiguous buffers from BufferPool
- Virtual ring semantics: reserve → commit → transfer → release
- Buffers returned to pool after transfer (not reused in ring)

### Key Insight

The Worker transport requires a **VirtualRingBuffer** class that:
- Provides ring-compatible API (reserve/commit/getBuffers/consume)
- Assembles from BufferPool buffers (not single ring)
- Returns complete, transferable buffers
- Maintains FIFO ordering like a ring
- Releases buffers back to pool after transfer

## Architecture Decision

**Two Ring Buffer Classes**:

1. **OutputRingBuffer** (existing) - For byte-stream transports
   - Single reusable Uint8Array ring buffer
   - Zero-after-write security
   - Wrap-around support
   - Efficient for streaming I/O

2. **VirtualRingBuffer** (new) - For Worker transport
   - Assembles from local BufferPool buffers
   - Ring-compatible API
   - Returns complete, transferable buffers
   - Releases buffers to remote pool after transfer

**Common Interface** (both classes):
```javascript
// Properties
get available()                 // Bytes committed but not yet consumed
get space()                     // Bytes available to reserve
get size()                      // Total ring capacity

// Lifecycle
reserve(length)                 // Returns VirtualRWBuffer or null
commit(reservation)             // Mark reservation as ready
getBuffers(length)              // Get Uint8Array[] for writing/transfer
consume(length)                 // Consume sent data
shrinkReservation(res, newLen)  // Shrink pending reservation

// Statistics
getStats()                      // Get ring statistics
```

**Key Differences**:

| Feature | OutputRingBuffer | VirtualRingBuffer |
|---------|------------------|-------------------|
| Storage | Single Uint8Array | BufferPool buffers |
| Reuse | Zero and reuse | Release to pool |
| getBuffers() | 1-2 views (may wrap) | N complete buffers |
| Transfer | Cannot transfer | Transferable |
| Security | Zero-after-write | Pool zeros on release |

## Scenario 1: OutputRingBuffer Lifecycle (Byte-Stream)

### Initial State
```javascript
const ring = new OutputRingBuffer(256 * 1024);
// ring.size = 262144
// ring.available = 0
// ring.space = 262144
// ring.#writeHead = 0
// ring.#readHead = 0
// ring.#count = 0
// ring.#reserved = 0
```

### Step 1: Reserve Space
```javascript
const reservation = ring.reserve(1024);
// Returns VirtualRWBuffer with 1 segment (no wrap)
// ring.#reserved = 1024
// ring.#pendingReservation = reservation
// ring.space = 261120 (262144 - 1024)
```

**Reservation Metadata**:
```javascript
reservation._ringReservation = {
  startPos: 0,
  length: 1024,
  epoch: 0,
  ring: ring
};
```

### Step 2: Encode Data
```javascript
// Encode protocol header
reservation.setUint8(0, 2);  // Channel data type
reservation.setUint8(1, 8);  // Remaining size
// ... encode rest of header ...

// Encode string data
const { read, written } = reservation.encodeFrom(str, 18);
// written = 500 (actual bytes encoded)
```

### Step 3: Shrink Reservation
```javascript
reservation.shrink(518);  // 18 header + 500 data
// Calls ring.shrinkReservation(reservation, 518)
// ring.#reserved = 518 (freed 506 bytes)
// ring.space = 261626 (262144 - 518)
```

### Step 4: Commit Reservation
```javascript
ring.commit(reservation);
// ring.#writeHead = 518
// ring.#reserved = 0
// ring.#count = 518
// ring.#pendingReservation = null
// ring.available = 518
```

### Step 5: Get Buffers for Writing
```javascript
const buffers = ring.getBuffers(518);
// Returns [Uint8Array(518)] - single view, no wrap
// buffers[0] is view into ring.#buffer at offset 0
```

### Step 6: Write to Transport
```javascript
await transport.write(buffers[0]);
// Or for multiple buffers:
// for (const buf of buffers) await transport.write(buf);
```

### Step 7: Consume Sent Data
```javascript
ring.consume(518);
// Zeros bytes 0-517 (security)
// ring.#readHead = 518
// ring.#count = 0
// ring.available = 0
```

### Wrap-Around Scenario

**State**: `ring.#writeHead = 262000` (near end)

```javascript
const reservation = ring.reserve(1000);
// Splits around wrap: 144 bytes at end + 856 bytes at start
// Returns VirtualRWBuffer with 2 segments
// ring.#epoch++ (wrap-around counter)
```

**Reservation Segments**:
```javascript
[
  { buffer: ring.#buffer.buffer, offset: 262000, length: 144 },
  { buffer: ring.#buffer.buffer, offset: 0, length: 856 }
]
```

**After Commit**:
```javascript
ring.commit(reservation);
// ring.#writeHead = 856 (wrapped around)
```

**Get Buffers**:
```javascript
const buffers = ring.getBuffers(1000);
// Returns [Uint8Array(144), Uint8Array(856)]
// Two views for wrapped data
```

**Consume**:
```javascript
ring.consume(1000);
// Zeros bytes 262000-262143 and 0-855
// ring.#readHead = 856
```

## Scenario 2: VirtualRingBuffer Lifecycle (Worker Transport)

**Context**: Main thread (sender) → Worker thread (receiver)
- **Shared pool architecture**: Main and worker have separate pools, but coordinate via buffer transfer
- **Sender allocates** from sender's pool (main thread pool)
- **Sender transfers** buffer to worker via `postMessage`
- **Receiver processes** and releases to receiver's pool (worker pool)
- **Worker pool maintenance**: Requests buffers from main when low, returns buffers to main when high

### Initial State (Sender/Main Thread)
```javascript
const senderPool = new BufferPool({
  isWorker: false,  // Main thread
  lowWaterMark: 3,
  highWaterMark: 10
});

const ring = new VirtualRingBuffer(256 * 1024, { pool: senderPool });
// ring.size = 262144 (budget/space abstraction - limits allocated-but-not-transferred)
// ring.available = 0 (bytes committed, ready to transfer)
// ring.space = 262144 (bytes available to reserve)
// ring.#buffers = []  // Queue of { buffer, offset, length, committed }
// ring.#reserved = 0 (bytes reserved but not committed)
// ring.#committed = 0 (bytes committed but not transferred)
// ring.#pendingReservation = null (only one at a time - might shrink)
```

### Step 1: Reserve Space (Sender)
```javascript
const reservation = ring.reserve(1024);
// Acquires buffer from sender's pool (size class 4KB)
// Returns VirtualRWBuffer with 1 segment
// ring.#reserved = 1024
// ring.#pendingReservation = reservation
// ring.#buffers = [{ buffer: buf, offset: 0, length: 1024, committed: false }]
// ring.space = 261120 (262144 - 1024 reserved)
```

**Buffer Acquisition from Sender's Pool**:
```javascript
// VirtualRingBuffer internally:
const buffer = senderPool.acquire(1024);  // Gets 4KB buffer (4096 bytes)
// Entire 4KB buffer allocated from pool
// Only 1024 bytes reserved in this reservation
// Remaining 3072 bytes unused (buffer will be transferred as-is)
```

**Critical**: Only one reservation pending at a time (might shrink before commit).

### Step 2: Encode Data (Sender)
```javascript
// Encode protocol header
reservation.setUint8(0, 2);  // Channel data type
reservation.setUint8(1, 8);  // Remaining size
// ... encode rest of header ...

// Encode string data
const { read, written } = reservation.encodeFrom(str, 18);
// written = 500 (actual bytes encoded)
```

### Step 3: Shrink Reservation (Sender)
```javascript
reservation.shrink(518);  // 18 header + 500 data
// Calls ring.shrinkReservation(reservation, 518)
// ring.#reserved = 518 (freed 506 bytes of virtual ring space)
// ring.#buffers[0].length = 518
// ring.space = 261626 (262144 - 518)
```

**Buffer State After Shrink**:
```javascript
// Buffer still 4KB (4096 bytes) - physical buffer unchanged
// Only 518 bytes used (reservation length)
// Remaining 3578 bytes unused (will be transferred but ignored)
// Virtual ring space freed: 506 bytes (budget abstraction)
```

### Step 4: Commit Reservation (Sender)
```javascript
ring.commit(reservation);
// ring.#reserved = 0
// ring.#committed = 518
// ring.#pendingReservation = null
// ring.#buffers[0].committed = true
// ring.available = 518 (ready to transfer)
```

### Step 5: Get Buffers for Transfer (Sender)
```javascript
const buffers = ring.getBuffers(518);
// Returns [Uint8Array(518)] - view into 4KB buffer (first 518 bytes)
// buffers[0] is view into sender's pool buffer
// Buffer is ready for postMessage transfer
```

**Key Difference from OutputRingBuffer**: Buffer is complete and transferable (not partial ring segment).

### Step 6: Transfer to Worker (Sender → Receiver)
```javascript
worker.postMessage(
  { type: 'data', buffers },
  buffers.map(b => b.buffer)  // Transfer ArrayBuffers (entire 4KB buffer)
);
// Entire 4KB buffer transferred to worker (ownership transferred)
// Sender no longer has access to this buffer
```

**Critical**: Entire ArrayBuffer transferred (4096 bytes), not just the 518-byte view.

### Step 7: Consume Transferred Data (Sender)
```javascript
ring.consume(518);
// Marks buffer as transferred (frees virtual ring space)
// ring.#committed = 0
// ring.#buffers = []  // Buffer removed from queue
// ring.available = 0
// ring.space = 262144 (full virtual ring space available again)
// NOTE: Buffer NOT returned to sender's pool (transferred to worker)
```

**Critical**: `consume()` frees virtual ring space (budget abstraction), but does NOT return buffer to sender's pool. Buffer is now in worker's context.

### Step 8: Sender Pool Maintenance Scheduled
```javascript
// After consume(), sender's pool may be below low-water mark
// Asynchronously (next event loop):
senderPool.scheduleMaintenance(sizes);
// Allocates new buffers to reach low-water mark
// See buffer-pool-lifecycle.md for details
```

### Step 9: Receive Message (Receiver/Worker)
```javascript
// Worker transport receives message
self.onmessage = (event) => {
  const { type, buffers } = event.data;
  // buffers[0] is Uint8Array(518) view into 4KB buffer
  // Entire 4KB buffer now owned by worker
  
  // Process buffer (decode, handle data, etc.)
  const chunk = processBuffer(buffers[0]);
  // ... application processes chunk ...
};
```

### Step 10: User Marks Chunk as Done (Receiver/Worker)
```javascript
// After processing, mark chunk as done
chunk.done();  // Or chunk.process() depending on API
// This signals that application is finished with the data
// Buffer can now be released to worker's pool
```

**Critical**: Buffer cannot be released until `done()` is called/`process()` returns. This ensures the application has finished with the data before the buffer is zeroed and reused.

### Step 11: Release to Worker Pool (Receiver/Worker)
```javascript
// Inside done(), release buffer to worker's pool
workerPool.release(buffers[0].buffer);  // Release entire 4KB buffer
// Buffer added to worker's dirty pool (not zeroed yet)
// stats.released++
```

### Step 12: Worker Pool Maintenance Scheduled (Receiver/Worker)
```javascript
// After release(), worker's pool may be above high-water mark
// Asynchronously (next event loop):
workerPool.scheduleMaintenance(size);
// 1. Clean dirty buffers to reach high-water mark (if below)
// 2. Return excess buffers to main thread
// See buffer-pool-lifecycle.md for details
```

**Worker Pool Maintenance Actions**:
```javascript
// If worker pool above high-water mark:
// 1. Return excess buffers to main thread via returnCallback
workerPool.#returnCallback(size, excessBuffers);
// Transfers buffers back to main thread

// Main thread transport receives returned buffers:
mainThread.onmessage = (event) => {
  if (event.data.type === 'returnBuffers') {
    const { size, buffers } = event.data;
    // Add to main pool or drop (GC will reclaim)
    senderPool.receiveBuffers(size, buffers);
  }
};
```

**Notes**:
- Main-to-worker buffer transfers (below worker low-water-mark) transfer clean buffers to the worker's clean pool.
- Worker-to-main buffer transfers (over worker high-water-mark) transfer assumed-to-be-dirty buffers to the main dirty pool.
  - (A fairly simple enhancement would be to note which buffer type is being transferred and add them to the correct pool)

**Summary of Buffer Flow**:
1. **Sender allocates** from sender's pool (main thread)
2. **Sender encodes** data into buffer
3. **Sender transfers** buffer to worker (ownership transferred)
4. **Sender consumes** (frees virtual ring space, NOT buffer)
5. **Sender pool maintenance** (allocate new buffers if below low-water)
6. **Receiver processes** data from buffer
7. **Receiver marks done** (signals finished with data)
8. **Receiver releases** buffer to receiver's pool (worker)
9. **Receiver pool maintenance** (return excess buffers to main if above high-water)
10. **Main receives** returned buffers (adds to main pool or drops)

### Multi-Buffer Reservation (Single Large Message)

**Scenario**: Reserve 80KB (exceeds largest single buffer size of 64KB)

```javascript
const res = ring.reserve(80 * 1024);  // 81920 bytes
// Acquires buf1 (64KB buffer from pool) - uses all 65536 bytes
// Acquires buf2 (16KB buffer from pool) - uses 16384 bytes
// Returns VirtualRWBuffer with 2 segments (buf1 + buf2)
// ring.#reserved = 81920
// ring.#pendingReservation = res
// ring.#buffers = [
//   { buffer: buf1, offset: 0, length: 65536, committed: false },
//   { buffer: buf2, offset: 0, length: 16384, committed: false }
// ]
// ring.space = 180224 (262144 - 81920)
```

**Critical**: Reservation spans TWO buffers because 80KB exceeds largest single buffer size (64KB). VirtualRWBuffer provides unified view across both buffers.

**Encode Data**:
```javascript
// Encode across both buffers seamlessly
res.setUint8(0, 2);  // Header in buf1
// ... encode header and data ...
const { read, written } = res.encodeFrom(largeString, 18);
// Data spans buf1 and buf2 automatically
```

**Commit**:
```javascript
ring.commit(res);
// ring.#reserved = 0
// ring.#committed = 81920
// ring.#pendingReservation = null
// ring.#buffers[0].committed = true
// ring.#buffers[1].committed = true
// ring.available = 81920
```

**Get Buffers**:
```javascript
const buffers = ring.getBuffers(81920);
// Returns [Uint8Array(65536), Uint8Array(16384)]
// Two complete buffer views ready for transfer
// buffers[0] = view into buf1 (all 65536 bytes)
// buffers[1] = view into buf2 (all 16384 bytes)
```

**Transfer**:
```javascript
worker.postMessage(
  { type: 'data', buffers },
  buffers.map(b => b.buffer)  // Transfer both ArrayBuffers
);
// buf1 and buf2 both transferred to worker
```

**Consume**:
```javascript
ring.consume(81920);
// Marks both buffers as transferred
// ring.#buffers = []
// ring.available = 0
// ring.space = 262144 (full space available)
// NOTE: Buffers NOT returned to sender's pool (transferred to worker)
```

## Scenario 3: Error Handling

### Insufficient Space
```javascript
const res = ring.reserve(300000);  // > ring.size
// Returns null (insufficient space)
// Transport must wait for consume() to free space
```

### Reservation Already Pending
```javascript
const res1 = ring.reserve(1000);
const res2 = ring.reserve(2000);
// Throws RingBufferReservationError: 'Reservation already pending'
// Both OutputRingBuffer and VirtualRingBuffer allow only one pending reservation
// (Reservation might shrink before commit, so must be serialized)
```

### Invalid Shrink
```javascript
const res = ring.reserve(1000);
res.shrink(1500);  // Grow, not shrink
// Throws RangeError: 'Cannot grow a reservation, only shrink'
```

### Commit Wrong Reservation
```javascript
const res = ring.reserve(1000);
ring.commit(res);
ring.commit(res);  // Already committed
// Throws RingBufferReservationError: 'Reservation not active'
```

## Scenario 4: Statistics Tracking

### OutputRingBuffer Stats
```javascript
const stats = ring.getStats();
// {
//   reservations: 10,
//   commits: 10,
//   bufferGets: 10,
//   consumes: 10,
//   wraps: 2,
//   bytesReserved: 50000,
//   bytesCommitted: 48500,  // After shrinking
//   bytesProvided: 48500,
//   bytesConsumed: 48500,
//   size: 262144,
//   available: 0,
//   space: 262144,
//   writeHead: 1000,
//   readHead: 1000,
//   count: 0,
//   reserved: 0,
//   epoch: 2
// }
```

### VirtualRingBuffer Stats
```javascript
const stats = ring.getStats();
// {
//   reservations: 10,
//   commits: 10,
//   bufferGets: 10,
//   consumes: 10,
//   buffersAcquired: 15,  // May acquire more than reservations
//   buffersReleased: 15,
//   bytesReserved: 50000,
//   bytesCommitted: 48500,
//   bytesProvided: 48500,
//   bytesConsumed: 48500,
//   size: 262144,
//   available: 0,
//   space: 262144,
//   committed: 0,
//   reserved: 0,
//   bufferCount: 0
// }
```

## Implementation Notes

### OutputRingBuffer (Existing)
- Already implemented in [`src/output-ring-buffer.esm.js`](../../src/output-ring-buffer.esm.js)
- 24 tests passing in [`test/unit/output-ring-buffer.test.js`](../../test/unit/output-ring-buffer.test.js)
- No changes needed

### VirtualRingBuffer (New)
- **File**: `src/virtual-ring-buffer.esm.js`
- **Dependencies**: [`BufferPool`](../../src/buffer-pool.esm.js), [`VirtualRWBuffer`](../../src/virtual-buffer.esm.js)
- **Key Features**:
  - Ring-compatible API (same as OutputRingBuffer)
  - BufferPool integration (allocates from pool)
  - Single pending reservation (might shrink)
  - Size class selection (automatic)
  - Multi-buffer support (for large reservations)
  - Complete, transferable buffers (for postMessage)
  - Budget/space abstraction (limits allocated-but-not-transferred)

### Transport Selection
```javascript
// Byte-stream transports
class HttpTransport {
  constructor() {
    this.#ring = new OutputRingBuffer(256 * 1024);
  }
}

// Worker transport
class WorkerTransport {
  constructor(pool) {
    this.#ring = new VirtualRingBuffer(256 * 1024, { pool });
  }
}
```

## Security Considerations

### OutputRingBuffer
- Zero-after-write prevents data leakage
- Consumes zero the space before advancing readHead
- No data from previous iterations visible

### VirtualRingBuffer
- Relies on BufferPool zeroing on release
- Buffers zeroed when returned to pool (not when acquired)
- No data from previous uses visible
- Transferred buffers owned by worker (no leakage)

## Performance Considerations

### OutputRingBuffer
- **Pros**: Single buffer, minimal allocation, efficient for streaming
- **Cons**: Cannot transfer (byte-stream only)

### VirtualRingBuffer
- **Pros**: Transferable buffers, pool reuse, flexible sizing
- **Cons**: More allocations, pool management overhead

### When to Use Each
- **OutputRingBuffer**: HTTP, WebSocket, IPC pipes, nested transport
- **VirtualRingBuffer**: Worker transport (postMessage)

## Related Scenarios
- [`buffer-pool-lifecycle.md`](buffer-pool-lifecycle.md) - Buffer pool management
- [`simple-write.md`](simple-write.md) - Single-chunk write flow
- [`multi-chunk-write.md`](multi-chunk-write.md) - Multi-chunk write flow
- [`send-flow-control.md`](send-flow-control.md) - Send flow control

## Open Questions
1. Should VirtualRingBuffer support async reserve with waiting (like OutputRingBuffer will need)?
  - Yes: same API, same motivation
2. Should there be a common base class or interface for both ring types?
  - There is no requirement for this, so it should be an implementation-driven consideration
  - Based on the current OutputRingBuffer implementation, VirtualRingBuffer seems likely to be more different than similar (so probably unrelated classes)
3. Should VirtualRingBuffer track and report buffer waste (unused bytes in allocated buffers)?
  - No (too little informational value by itself)
