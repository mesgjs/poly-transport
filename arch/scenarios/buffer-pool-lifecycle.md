# Buffer Pool Lifecycle Scenario

## Overview

This scenario documents the complete lifecycle of buffer management using the BufferPool class. BufferPool manages reusable ArrayBuffers organized by size classes (1KB, 4KB, 16KB, 64KB) to minimize allocation overhead and system calls. It supports both main thread and worker contexts with automatic water mark management.

**Key Principle**: Buffers are zeroed when **released** (not when allocated) per requirements.md:850. This provides better timing (buffer ready when needed) and potentially detects premature-release issues earlier.

## Preconditions

- BufferPool instance created with configuration
- Size classes defined (default: 1KB, 4KB, 16KB, 64KB)
- Water marks configured (low/high per size class)
- Worker context flag set if running in worker

## Actors

- **BufferPool**: Manages buffer pools, water marks, allocation, release
- **Application**: Acquires and releases buffers for I/O operations
- **Main Thread** (worker mode): Provides buffers to workers on request
- **Worker Thread** (worker mode): Requests buffers from main thread

## Step-by-Step Sequence

### Scenario 1: Pool Initialization

#### Step 1: Create BufferPool instance

**Actor**: Application

**Action**: Instantiate BufferPool with configuration

**Details**:
```javascript
const pool = new BufferPool({
  sizeClasses: [1024, 4096, 16384, 65536],  // Default
  lowWaterMark: 2,                           // Default
  highWaterMark: 10,                         // Default
  waterMarks: {
    1024: { low: 5, high: 20 },              // Override for 1KB
    65536: { low: 1, high: 5 }               // Override for 64KB
  },
  isWorker: false,                           // Main thread
  requestCallback: null,                     // Worker only
  returnCallback: null                       // Worker only
});
```

**State Changes**:
- `#sizeClasses` sorted array: `[1024, 4096, 16384, 65536]`
- `#pools` Map initialized: `{ 1024: [], 4096: [], 16384: [], 65536: [] }`
- `#waterMarks` Map initialized with defaults and overrides
- `#stats` Map initialized: `{ acquired: 0, released: 0, allocated: 0, transferred: 0 }`

#### Step 2: Pre-allocate to low water mark

**Actor**: BufferPool (constructor)

**Action**: Allocate buffers to reach low water mark for each size class

**Details**:
- For each size class:
  - Calculate needed: `lowWaterMark - currentPoolSize`
  - If needed > 0:
    - Main thread: Allocate directly (`new ArrayBuffer(size)`)
    - Worker: Call `requestCallback(size, needed)` to request from main thread
  - Push buffers to pool array
  - Increment `stats.allocated` counter

**Example** (1KB with low=5):
```javascript
// Allocate 5 buffers of 1024 bytes each
for (let i = 0; i < 5; i++) {
  const buffer = new ArrayBuffer(1024);
  pool.push(buffer);
  stats.allocated++;
}
```

**State After**:
- Each pool has `lowWaterMark` buffers (or request sent in worker mode)
- `stats.allocated` = total buffers allocated across all size classes

### Scenario 2: Buffer Acquisition

#### Step 1: Application requests buffer

**Actor**: Application

**Action**: Call [`pool.acquire(requestedSize)`](../../src/buffer-pool.esm.js:178)

**Details**:
```javascript
const buffer = pool.acquire(3000);  // Request 3000 bytes
```

**Parameters**:
- `requestedSize`: Number of bytes needed

#### Step 2: Select size class

**Actor**: BufferPool

**Action**: Find smallest size class that fits request

**Details**:
```javascript
#getSizeClass(requestedSize) {
  for (const size of this.#sizeClasses) {
    if (size >= requestedSize) {
      return size;  // Return first size that fits
    }
  }
  return null;  // Too large for any size class
}
```

**Example**:
- Request 3000 bytes → Select 4096 (4KB)
- Request 500 bytes → Select 1024 (1KB)
- Request 50000 bytes → Select 65536 (64KB)
- Request 100000 bytes → Return `null` (too large)

#### Step 3: Get buffer from pool or allocate

**Actor**: BufferPool

**Action**: Pop buffer from pool or allocate new if pool empty

**Details**:
```javascript
const pool = this.#pools.get(size);
let buffer;

if (pool.length > 0) {
  // Reuse from pool
  buffer = pool.pop();
} else {
  // Allocate new buffer
  buffer = new ArrayBuffer(size);
  stats.allocated++;
}

stats.acquired++;
```

**State Changes**:
- Pool size decreases by 1 (if buffer was available)
- `stats.acquired` increments
- `stats.allocated` increments (if new allocation)

#### Step 4: Maintain low water mark

**Actor**: BufferPool

**Action**: Refill pool to low water mark after acquisition

**Details**:
```javascript
#ensureMinimum(size) {
  const pool = this.#pools.get(size);
  const marks = this.#waterMarks.get(size);
  const needed = marks.low - pool.length;
  
  if (needed > 0) {
    if (this.#isWorker && this.#requestCallback) {
      // Request from main thread
      this.#requestCallback(size, needed);
    } else {
      // Allocate directly
      for (let i = 0; i < needed; i++) {
        pool.push(new ArrayBuffer(size));
        stats.allocated++;
      }
    }
  }
}
```

**Example** (low=3, pool had 3 buffers):
- After acquisition: pool has 2 buffers
- Refill: allocate 1 buffer
- After refill: pool has 3 buffers (back to low water mark)

**State After**:
- Pool refilled to low water mark
- Buffer returned to application (not zeroed - zeroing happens on release)

### Scenario 3: Buffer Release

#### Step 1: Application releases buffer

**Actor**: Application

**Action**: Call [`pool.release(buffer)`](../../src/buffer-pool.esm.js:212)

**Details**:
```javascript
const released = pool.release(buffer);
// Returns true if released, false if invalid size
```

**Parameters**:
- `buffer`: ArrayBuffer to release

#### Step 2: Validate size class

**Actor**: BufferPool

**Action**: Check if buffer size matches a recognized size class

**Details**:
```javascript
const size = buffer.byteLength;
const pool = this.#pools.get(size);

if (!pool) {
  return false;  // Not a recognized size class
}
```

**Example**:
- Buffer size 1024 → Valid (1KB size class)
- Buffer size 512 → Invalid (not a recognized size class)

#### Step 3: Zero buffer contents

**Actor**: BufferPool

**Action**: Zero all bytes in buffer before returning to pool

**Details**:
```javascript
#zeroBuffer(buffer) {
  const view = new Uint8Array(buffer);
  view.fill(0);
}
```

**Rationale** (requirements.md:850):
- Buffers zeroed on **release** (not allocation)
- Better timing: buffer ready when needed
- Potentially detect premature-release issues earlier
- Security: prevent data leakage between uses

**State Changes**:
- All bytes in buffer set to 0

#### Step 4: Return buffer to pool

**Actor**: BufferPool

**Action**: Push zeroed buffer to pool array

**Details**:
```javascript
pool.push(buffer);
stats.released++;
```

**State Changes**:
- Pool size increases by 1
- `stats.released` increments

#### Step 5: Enforce high water mark

**Actor**: BufferPool

**Action**: Release excess buffers if pool exceeds high water mark

**Details**:
```javascript
#releaseExcess(size) {
  const pool = this.#pools.get(size);
  const marks = this.#waterMarks.get(size);
  const excess = pool.length - marks.high;
  
  if (excess > 0) {
    const toRelease = pool.splice(marks.high, excess);
    
    if (this.#isWorker && this.#returnCallback) {
      // Return to main thread
      this.#returnCallback(size, toRelease);
      stats.transferred += toRelease.length;
    }
    // In main thread, buffers simply dropped (GC'd)
  }
}
```

**Example** (high=5, pool has 7 buffers):
- Excess: 7 - 5 = 2 buffers
- Remove 2 buffers from pool
- Worker: Return to main thread via `returnCallback`
- Main thread: Drop buffers (GC will reclaim)

**State After**:
- Pool capped at high water mark
- Excess buffers released or returned to main thread

### Scenario 4: Worker Mode - Request Buffers

#### Step 1: Worker pool drops below low water mark

**Actor**: BufferPool (worker context)

**Action**: Detect pool below low water mark during acquisition

**Details**:
- Worker acquires buffer, pool drops below low water mark
- `#ensureMinimum()` called automatically

#### Step 2: Request buffers from main thread

**Actor**: BufferPool (worker context)

**Action**: Call `requestCallback` to request buffers

**Details**:
```javascript
if (this.#isWorker && this.#requestCallback) {
  this.#requestCallback(size, needed);
}
```

**Example**:
```javascript
// Worker pool configuration
const pool = new BufferPool({
  isWorker: true,
  lowWaterMark: 3,
  requestCallback: (size, count) => {
    // Send message to main thread
    self.postMessage({
      type: 'requestBuffers',
      size: size,
      count: count
    });
  }
});

// Triggers request when pool drops below 3
pool.acquire(1024);
```

**State Changes**:
- Request sent to main thread
- Worker continues operating (async request)

#### Step 3: Main thread allocates buffers

**Actor**: Main thread

**Action**: Receive request, allocate buffers, transfer to worker

**Details**:
```javascript
// Main thread message handler
worker.addEventListener('message', (event) => {
  if (event.data.type === 'requestBuffers') {
    const { size, count } = event.data;
    const buffers = [];
    
    for (let i = 0; i < count; i++) {
      buffers.push(new ArrayBuffer(size));
    }
    
    // Transfer buffers to worker
    worker.postMessage({
      type: 'receiveBuffers',
      size: size,
      buffers: buffers
    }, buffers);  // Transfer ownership
  }
});
```

**State Changes**:
- Buffers allocated in main thread
- Ownership transferred to worker

#### Step 4: Worker receives buffers

**Actor**: BufferPool (worker context)

**Action**: Call [`pool.receiveBuffers(size, buffers)`](../../src/buffer-pool.esm.js:238)

**Details**:
```javascript
// Worker message handler
self.addEventListener('message', (event) => {
  if (event.data.type === 'receiveBuffers') {
    const { size, buffers } = event.data;
    pool.receiveBuffers(size, buffers);
  }
});

// BufferPool.receiveBuffers()
receiveBuffers(size, buffers) {
  if (!this.#isWorker) {
    throw new Error('receiveBuffers can only be called in worker context');
  }
  
  const pool = this.#pools.get(size);
  if (!pool) {
    throw new Error(`Invalid size class: ${size}`);
  }
  
  pool.push(...buffers);
  this.#stats.get(size).transferred += buffers.length;
}
```

**State Changes**:
- Buffers added to worker pool
- `stats.transferred` increments
- Pool refilled to low water mark

### Scenario 5: Worker Mode - Return Excess Buffers

#### Step 1: Worker pool exceeds high water mark

**Actor**: BufferPool (worker context)

**Action**: Detect pool above high water mark during release

**Details**:
- Worker releases buffer, pool exceeds high water mark
- `#releaseExcess()` called automatically

#### Step 2: Return buffers to main thread

**Actor**: BufferPool (worker context)

**Action**: Call `returnCallback` to return excess buffers

**Details**:
```javascript
if (this.#isWorker && this.#returnCallback) {
  this.#returnCallback(size, toRelease);
  stats.transferred += toRelease.length;
}
```

**Example**:
```javascript
// Worker pool configuration
const pool = new BufferPool({
  isWorker: true,
  highWaterMark: 5,
  returnCallback: (size, buffers) => {
    // Send buffers back to main thread
    self.postMessage({
      type: 'returnBuffers',
      size: size,
      buffers: buffers
    }, buffers);  // Transfer ownership
  }
});

// Triggers return when pool exceeds 5
pool.release(buffer);
```

**State Changes**:
- Excess buffers removed from worker pool
- Ownership transferred back to main thread
- `stats.transferred` increments

#### Step 3: Main thread receives buffers

**Actor**: Main thread

**Action**: Receive returned buffers, add to main pool or release

**Details**:
```javascript
// Main thread message handler
worker.addEventListener('message', (event) => {
  if (event.data.type === 'returnBuffers') {
    const { size, buffers } = event.data;
    
    // Option 1: Add to main thread pool
    mainPool.receiveBuffers(size, buffers);
    
    // Option 2: Simply drop (GC will reclaim)
    // (no action needed)
  }
});
```

**State Changes**:
- Buffers returned to main thread
- Main thread decides whether to keep or release

### Scenario 6: Statistics and Monitoring

#### Step 1: Application requests statistics

**Actor**: Application

**Action**: Call [`pool.getStats()`](../../src/buffer-pool.esm.js:257)

**Details**:
```javascript
const stats = pool.getStats();
```

**Returns**:
```javascript
{
  sizeClasses: [1024, 4096, 16384, 65536],
  isWorker: false,
  pools: {
    1024: {
      lowWaterMark: 5,
      highWaterMark: 20,
      available: 6,        // Current pool size
      acquired: 42,        // Total acquired
      released: 37,        // Total released
      allocated: 10,       // Total allocated
      transferred: 0       // Total transferred (worker only)
    },
    4096: { ... },
    16384: { ... },
    65536: { ... }
  }
}
```

**Use Cases**:
- Monitor buffer usage patterns
- Detect memory leaks (acquired > released)
- Tune water marks based on actual usage
- Debug allocation issues

#### Step 2: Application requests pool sizes

**Actor**: Application

**Action**: Call [`pool.getPoolSizes()`](../../src/buffer-pool.esm.js:286)

**Details**:
```javascript
const sizes = pool.getPoolSizes();
// Returns: { 1024: 6, 4096: 3, 16384: 2, 65536: 1 }
```

**Use Cases**:
- Quick check of current pool state
- Verify water mark enforcement
- Monitor pool health

#### Step 3: Application requests water marks

**Actor**: Application

**Action**: Call [`pool.getWaterMarks(size)`](../../src/buffer-pool.esm.js:300)

**Details**:
```javascript
const marks = pool.getWaterMarks(1024);
// Returns: { low: 5, high: 20 }

const invalid = pool.getWaterMarks(512);
// Returns: null (invalid size class)
```

**Use Cases**:
- Verify configuration
- Debug water mark issues
- Document pool settings

## Postconditions

### After Initialization
- All pools pre-allocated to low water mark
- Statistics initialized to zero
- Worker callbacks registered (if worker mode)

### After Acquisition
- Buffer returned to application (not zeroed)
- Pool refilled to low water mark
- Statistics updated (acquired, allocated)

### After Release
- Buffer zeroed and returned to pool
- Pool capped at high water mark
- Statistics updated (released, transferred)

### After Worker Transfer
- Buffers transferred between threads
- Pool sizes maintained within water marks
- Statistics track transfers

## Error Conditions

### Invalid Size Request

**Condition**: Requested size exceeds largest size class

**Handling**:
```javascript
const buffer = pool.acquire(100000);  // > 64KB
// Returns: null
```

**Application Response**:
- Allocate buffer directly (outside pool)
- Or split request into smaller chunks

### Invalid Size Release

**Condition**: Buffer size doesn't match any size class

**Handling**:
```javascript
const buffer = new ArrayBuffer(512);  // Not a size class
const released = pool.release(buffer);
// Returns: false
```

**Application Response**:
- Buffer not managed by pool
- Application must handle directly

### Worker Context Violation

**Condition**: `receiveBuffers()` called in non-worker context

**Handling**:
```javascript
pool.receiveBuffers(1024, [buffer]);
// Throws: Error('receiveBuffers can only be called in worker context')
```

**Application Response**:
- Check `pool.isWorker` before calling
- Only call from worker message handlers

### Invalid Size Class

**Condition**: `receiveBuffers()` called with invalid size

**Handling**:
```javascript
pool.receiveBuffers(512, [buffer]);
// Throws: Error('Invalid size class: 512')
```

**Application Response**:
- Validate size before calling
- Only use configured size classes

## Related Scenarios

- **[`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md)** - Output ring buffer management (uses BufferPool for migrations)
- **[`virtual-buffer-operations.md`](virtual-buffer-operations.md)** - Virtual buffer views (may reference pool-allocated buffers)
- **[`simple-write.md`](simple-write.md)** - Writing data (uses BufferPool for input buffers)
- **[`simple-read.md`](simple-read.md)** - Reading data (uses BufferPool for input buffers)

## Implementation Notes

### 1. Size Class Selection

**Critical**: Always select smallest size class that fits request.

**Rationale**:
- Minimizes memory waste
- Maximizes pool reuse
- Predictable allocation patterns

**Implementation**:
```javascript
#getSizeClass(requestedSize) {
  for (const size of this.#sizeClasses) {
    if (size >= requestedSize) {
      return size;
    }
  }
  return null;
}
```

### 2. Zero-On-Release Strategy

**Critical**: Buffers zeroed when released, not when allocated (requirements.md:850).

**Rationale**:
- Better timing: buffer ready when needed
- Less time pressure when releasing
- Potentially detect premature-release issues earlier
- Security: prevent data leakage

**Implementation**:
```javascript
release(buffer) {
  // Zero before returning to pool
  this.#zeroBuffer(buffer);
  pool.push(buffer);
}
```

### 3. Water Mark Management

**Critical**: Maintain low water mark after acquisition, high water mark after release.

**Rationale**:
- Low water mark: ensure buffers available for next acquisition
- High water mark: prevent unbounded memory growth
- Automatic management: no manual intervention needed

**Implementation**:
```javascript
acquire(size) {
  const buffer = pool.pop() || new ArrayBuffer(size);
  this.#ensureMinimum(size);  // Refill after acquisition
  return buffer;
}

release(buffer) {
  this.#zeroBuffer(buffer);
  pool.push(buffer);
  this.#releaseExcess(size);  // Cap after release
}
```

### 4. Worker Buffer Transfer

**Critical**: Use `postMessage` with transfer list for zero-copy transfer.

**Rationale**:
- Transfer ownership (not copy)
- Zero-copy between threads
- Prevents concurrent access issues

**Implementation**:
```javascript
// Transfer buffers to worker
worker.postMessage({
  type: 'receiveBuffers',
  buffers: buffers
}, buffers);  // Transfer list

// Transfer buffers back to main
self.postMessage({
  type: 'returnBuffers',
  buffers: buffers
}, buffers);  // Transfer list
```

### 5. Statistics Tracking

**Critical**: Track all buffer operations for monitoring and debugging.

**Rationale**:
- Detect memory leaks (acquired > released)
- Tune water marks based on usage
- Debug allocation issues
- Monitor worker transfers

**Tracked Metrics**:
- `acquired`: Total buffers acquired
- `released`: Total buffers released
- `allocated`: Total buffers allocated (new ArrayBuffer)
- `transferred`: Total buffers transferred (worker only)

### 6. Configuration Flexibility

**Critical**: All sizes and water marks should be configurable.

**Rationale**:
- Different use cases have different needs
- Allow tuning based on actual usage
- Support both small and large buffer scenarios

**Configurable Parameters**:
- `sizeClasses`: Array of buffer sizes
- `lowWaterMark`: Default low water mark
- `highWaterMark`: Default high water mark
- `waterMarks`: Per-size-class overrides

### 7. Testing Strategy

**Critical**: Test all lifecycle stages and error conditions.

**Test Cases**:
1. Initialization with defaults
2. Initialization with custom configuration
3. Acquisition from pool
4. Acquisition with allocation
5. Acquisition with size class selection
6. Acquisition with invalid size
7. Release to pool
8. Release with zeroing
9. Release with high water mark enforcement
10. Release with invalid size
11. Worker mode: request buffers
12. Worker mode: receive buffers
13. Worker mode: return buffers
14. Worker mode: context violations
15. Statistics tracking
16. Pool size queries
17. Water mark queries
18. Multiple acquire/release cycles

## API Reference

### BufferPool

```javascript
class BufferPool {
  constructor(options = {})
  
  // Acquisition
  acquire(requestedSize)           // Returns ArrayBuffer or null
  
  // Release
  release(buffer)                  // Returns boolean (success)
  
  // Worker mode
  receiveBuffers(size, buffers)    // Worker only
  
  // Statistics
  getStats()                       // Returns stats object
  getPoolSizes()                   // Returns { size: count }
  getWaterMarks(size)              // Returns { low, high } or null
  
  // Properties
  get sizeClasses()                // Returns size class array
  get isWorker()                   // Returns boolean
  
  // Testing/cleanup
  clear()                          // Clear all pools
}
```

### Configuration Options

```javascript
{
  sizeClasses: [1024, 4096, 16384, 65536],  // Buffer sizes
  lowWaterMark: 2,                           // Default low water mark
  highWaterMark: 10,                         // Default high water mark
  waterMarks: {                              // Per-size overrides
    1024: { low: 5, high: 20 },
    65536: { low: 1, high: 5 }
  },
  isWorker: false,                           // Worker context flag
  requestCallback: (size, count) => {},      // Request buffers (worker)
  returnCallback: (size, buffers) => {}      // Return buffers (worker)
}
```

## Performance Considerations

### Memory Efficiency

- **Size classes**: Minimize waste by selecting smallest size that fits
- **Water marks**: Balance between allocation overhead and memory usage
- **Worker transfers**: Zero-copy transfer via `postMessage` transfer list

### Allocation Overhead

- **Pre-allocation**: Buffers ready when needed (low water mark)
- **Reuse**: Minimize `new ArrayBuffer()` calls
- **Batch allocation**: Refill to low water mark in single operation

### Zeroing Overhead

- **Zero-on-release**: Spread cost over time (not concentrated at allocation)
- **Security**: Prevent data leakage between uses
- **Detection**: Potentially detect premature-release issues earlier

### Worker Coordination

- **Async requests**: Worker continues operating while waiting for buffers
- **Batch transfers**: Transfer multiple buffers in single message
- **Automatic management**: No manual intervention needed
