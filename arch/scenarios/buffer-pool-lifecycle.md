# Buffer Pool Lifecycle Scenario

## Overview

This scenario documents the complete lifecycle of buffer management using the BufferPool class. BufferPool manages reusable ArrayBuffers organized by size classes (1KB, 4KB, 16KB, 64KB) to minimize allocation overhead and system calls. It supports both main thread and worker contexts with automatic water mark management.

**Key Principles**:
- **Dual-pool architecture**: Clean pool (ready-to-use, zeroed) and dirty pool (released, awaiting zeroing)
- **Asynchronous pool management**: Water mark enforcement happens asynchronously in next event loop
- **Deferred zeroing**: Buffers zeroed on-demand during acquisition or async management (not immediately on release)
- **Batched operations**: Multiple pool management operations batched together for efficiency

## Preconditions

- BufferPool instance created with configuration
- Size classes defined (default: 1KB, 4KB, 16KB, 64KB)
- Water marks configured (low/high per size class)
- Worker context flag set if running in worker

## Actors

- **BufferPool**: Manages buffer pools, water marks, allocation, release
- **Application**: Acquires and releases buffers for I/O operations
- **Event Loop**: Schedules async pool management operations
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
- `#groups` Map initialized with dual pools for each size class:
  - `cleanPool`: [] (ready-to-use, zeroed buffers)
  - `dirtyPool`: [] (released buffers awaiting zeroing)
  - `marks`: { low, high } (water marks)
  - `stats`: { acquired: 0, released: 0, allocated: 0, transferred: 0 }
- `#manageSizes` Set initialized (empty, tracks sizes needing async management)
- `#timer` null (no scheduled management yet)
- `#stopped` false (pool management active)

#### Step 2: Pre-allocate to low water mark

**Actor**: BufferPool (constructor)

**Action**: Allocate buffers to reach low water mark for each size class

**Details**:
- For each size class:
  - Calculate needed: `lowWaterMark - cleanPool.length`
  - If needed > 0:
    - Main thread: Allocate directly (`new ArrayBuffer(size)`)
    - Worker: Call `requestCallback(size, needed)` to request from main thread
  - Push buffers to clean pool
  - Increment `stats.allocated` counter

**Example** (1KB with low=5):
```javascript
// Allocate 5 buffers of 1024 bytes each
for (let i = 0; i < 5; i++) {
  const buffer = new ArrayBuffer(1024);
  cleanPool.push(buffer);
  stats.allocated++;
}
```

**State After**:
- Each clean pool has `lowWaterMark` buffers (or request sent in worker mode)
- Each dirty pool is empty
- `stats.allocated` = total buffers allocated across all size classes

### Scenario 2: Buffer Acquisition

#### Step 1: Application requests buffer

**Actor**: Application

**Action**: Call [`pool.acquire(requestedSize)`](../../src/buffer-pool.esm.js:252)

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

**Action**: Get buffer from clean pool, or clean a dirty buffer, or allocate new

**Details**:
```javascript
const group = this.#groups.get(size);
const { cleanPool, dirtyPool, stats } = group;
let buffer;

if (cleanPool.length > 0) {
  // Reuse a ready buffer from the clean pool
  buffer = cleanPool.pop();
} else if (dirtyPool.length > 0) {
  // Clean a buffer from the dirty pool and reuse it
  buffer = dirtyPool.pop();
  this.#zeroBuffer(buffer);
} else {
  // Allocate new buffer
  buffer = new ArrayBuffer(size);
  ++stats.allocated;
}

++stats.acquired;
```

**State Changes**:
- Clean pool size decreases by 1 (if buffer was available)
- Or dirty pool size decreases by 1 and buffer is zeroed (if clean pool empty)
- Or new buffer allocated (if both pools empty)
- `stats.acquired` increments
- `stats.allocated` increments (if new allocation)

#### Step 4: Schedule low water mark maintenance

**Actor**: BufferPool

**Action**: Schedule async refill to low water mark

**Details**:
```javascript
// After acquisition, schedule async management
this.#ensureMinimum(size);  // sync=false (default)

#ensureMinimum(size, sync = false) {
  if (!sync) {
    // Async pool management - schedule for later
    this.#manageSizes.add(size);
    this.#manageLevels();
    return;
  }
  // ... sync implementation ...
}

#manageLevels(handler = false) {
  if (!handler) {
    // Schedule management in the next event loop if not yet running
    if (!this.#timer && !this.#stopped) {
      this.#timer = setTimeout(() => this.#manageLevels(true), 0);
    }
    return;
  }
  // ... handler implementation ...
}
```

**State Changes**:
- Size added to `#manageSizes` Set
- Timer scheduled if not already running
- Actual refill happens asynchronously in next event loop

**State After**:
- Buffer returned to application (may or may not be zeroed depending on source)
- Pool refill scheduled (not yet executed)

### Scenario 3: Buffer Release

#### Step 1: Application releases buffer

**Actor**: Application

**Action**: Call [`pool.release(buffer)`](../../src/buffer-pool.esm.js:290)

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
const group = this.#groups.get(size);

if (!group) {
  return false;  // Not a recognized size class
}
```

**Example**:
- Buffer size 1024 → Valid (1KB size class)
- Buffer size 512 → Invalid (not a recognized size class)

#### Step 3: Add buffer to dirty pool

**Actor**: BufferPool

**Action**: Push buffer to dirty pool (NOT zeroed yet)

**Details**:
```javascript
const { dirtyPool, stats } = group;
dirtyPool.push(buffer);  // Note: Added to *dirty* pool (to be cleaned later)
++stats.released;
```

**Rationale**:
- Deferred zeroing: Spread cost over time
- Zeroing happens on-demand during acquisition or async management
- Reduces immediate overhead of release operation
- Security: buffer still zeroed before reuse

**State Changes**:
- Dirty pool size increases by 1
- Buffer NOT zeroed yet (deferred)
- `stats.released` increments

#### Step 4: Schedule high water mark enforcement

**Actor**: BufferPool

**Action**: Schedule async excess release

**Details**:
```javascript
// After release, schedule async management
this.#releaseExcess(size);  // sync=false (default)

#releaseExcess(size, sync = false) {
  if (!sync) {
    this.#manageSizes.add(size);
    this.#manageLevels();
    return;
  }
  // ... sync implementation ...
}
```

**State Changes**:
- Size added to `#manageSizes` Set
- Timer scheduled if not already running
- Actual excess release happens asynchronously in next event loop

**State After**:
- Buffer added to dirty pool (not zeroed)
- Excess release scheduled (not yet executed)

### Scenario 4: Worker Mode - Request Buffers

#### Step 1: Worker pool drops below low water mark

**Actor**: BufferPool (worker context)

**Action**: Detect pool below low water mark during async management

**Details**:
- Worker acquires buffer, schedules async management
- Async management detects clean pool below low water mark
- `#ensureMinimum(size, true)` called with `sync=true`

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

**Action**: Call [`pool.receiveBuffers(size, buffers)`](../../src/buffer-pool.esm.js:314)

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
  
  const group = this.#groups.get(size);
  if (!group) {
    throw new Error(`Invalid size class: ${size}`);
  }
  
  group.cleanPool.push(...buffers);
  group.stats.transferred += buffers.length;
}
```

**State Changes**:
- Buffers added to worker clean pool
- `stats.transferred` increments
- Pool refilled to low water mark

### Scenario 5: Worker Mode - Return Excess Buffers

#### Step 1: Worker pool exceeds high water mark

**Actor**: BufferPool (worker context)

**Action**: Detect pool above high water mark during async management

**Details**:
- Worker releases buffer, schedules async management
- Async management detects total pool size exceeds high water mark
- `#releaseExcess(size, true)` called with `sync=true`

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
- Excess buffers removed from worker pools (dirty first, then clean)
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

**Action**: Call [`pool.getStats()`](../../src/buffer-pool.esm.js:332)

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
      available: 6,        // Total pool size (clean + dirty)
      clean: 4,            // Ready-to-use buffers
      dirty: 2,            // Buffers awaiting zeroing
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
- Monitor clean vs dirty buffer ratios

#### Step 2: Application requests pool sizes

**Actor**: Application

**Action**: Call [`pool.getPoolSizes()`](../../src/buffer-pool.esm.js:363)

**Details**:
```javascript
const sizes = pool.getPoolSizes();
// Returns: { 1024: 6, 4096: 3, 16384: 2, 65536: 1 }
// (Total = clean + dirty for each size)
```

**Use Cases**:
- Quick check of current pool state
- Verify water mark enforcement
- Monitor pool health

#### Step 3: Application requests water marks

**Actor**: Application

**Action**: Call [`pool.getWaterMarks(size)`](../../src/buffer-pool.esm.js:378)

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

### Scenario 7: Asynchronous Pool Management

This scenario documents the async pool management system that maintains water marks without blocking the application.

#### Step 1: Operations schedule management

**Actor**: BufferPool

**Action**: Acquire/release operations add sizes to management queue

**Details**:
```javascript
// After acquire
this.#ensureMinimum(size);  // Adds size to #manageSizes, schedules timer

// After release
this.#releaseExcess(size);  // Adds size to #manageSizes, schedules timer
```

**State Changes**:
- Size added to `#manageSizes` Set (deduplicated)
- Timer scheduled if not already running

#### Step 2: Timer fires in next event loop

**Actor**: Event Loop

**Action**: Execute scheduled `#manageLevels(true)` handler

**Details**:
```javascript
async #manageLevels(handler = false) {
  if (!handler) {
    // Schedule management in the next event loop if not yet running
    if (!this.#timer && !this.#stopped) {
      this.#timer = setTimeout(() => this.#manageLevels(true), 0);
    }
    return;
  }

  // Handler execution
  let runAgain = false;
  for (const size of this.#manageSizes) {
    this.#manageSizes.delete(size);
    if (runAgain) {
      // Yield to the event queue between sizes
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      runAgain = true;
    }

    // Make sure pool has the minimum
    this.#ensureMinimum(size, true);

    // Scrub dirty buffers to top off and then release excess
    this.#releaseExcess(size, true);
  }

  if (runAgain && !this.#stopped) {
    this.#timer = setTimeout(() => this.#manageLevels(true), 0);
  } else {
    this.#timer = null;
  }
}
```

**State Changes**:
- Processes each size in `#manageSizes` Set
- Yields to event loop between sizes (allows other operations to run)
- Clears `#manageSizes` as sizes are processed
- Reschedules if new sizes added during processing

#### Step 3: Ensure minimum (sync mode)

**Actor**: BufferPool

**Action**: Refill clean pool to low water mark

**Details**:
```javascript
#ensureMinimum(size, sync = true) {
  const group = this.#groups.get(size);
  const { cleanPool, dirtyPool, marks, stats } = group;
  const needed = marks.low - cleanPool.length;

  if (needed > 0) {
    if (this.#isWorker && this.#requestCallback) {
      // Request buffers from main thread
      this.#requestCallback(size, needed);
    } else {
      for (let i = 0; i < needed; i++) {
        if (dirtyPool.length > 0) {
          // Clean a dirty buffer and reuse it
          const buffer = dirtyPool.pop();
          this.#zeroBuffer(buffer);
          cleanPool.push(buffer);
        } else {
          // Allocate directly
          cleanPool.push(new ArrayBuffer(size));
          ++stats.allocated;
        }
      }
    }
  }
}
```

**State Changes**:
- Dirty buffers cleaned and moved to clean pool (if available)
- New buffers allocated if needed
- Clean pool reaches low water mark

#### Step 4: Release excess (sync mode)

**Actor**: BufferPool

**Action**: Top off clean pool, then release excess buffers

**Details**:
```javascript
#releaseExcess(size, sync = true) {
  const group = this.#groups.get(size);
  const { cleanPool, dirtyPool, marks, stats } = group;

  // Top-off the clean pool up to the high-water mark by scrubbing dirty buffers
  while (cleanPool.length < marks.high && dirtyPool.length > 0) {
    const buffer = dirtyPool.pop();
    this.#zeroBuffer(buffer);
    cleanPool.push(buffer);
  }

  // Everything over is excess to be released
  // (The main thread assumes we're sending dirty buffers, so send those first)
  if (dirtyPool.length > 0) {
    const toRelease = dirtyPool.splice(0, dirtyPool.length);
    if (this.#isWorker && this.#returnCallback) {
      this.#returnCallback(size, toRelease);
      stats.transferred += toRelease.length;
    }
  }
  
  const excess = cleanPool.length - marks.high;
  if (excess > 0) {
    const toRelease = cleanPool.splice(marks.high, excess);
    if (this.#isWorker && this.#returnCallback) {
      this.#returnCallback(size, toRelease);
      stats.transferred += toRelease.length;
    }
  }
}
```

**State Changes**:
- Dirty buffers cleaned and moved to clean pool (up to high water mark)
- Excess dirty buffers released/returned
- Excess clean buffers released/returned
- Total pool size capped at high water mark

#### Step 5: Stop pool management

**Actor**: Application (during transport shutdown)

**Action**: Call [`pool.stop()`](../../src/buffer-pool.esm.js:152)

**Details**:
```javascript
pool.stop();

stop() {
  this.#stopped = true;
  if (this.#timer) {
    clearTimeout(this.#timer);
  }
}
```

**State Changes**:
- `#stopped` flag set to true
- Timer cleared (no more async management)
- Pool operations still work, but no automatic maintenance

**Use Cases**:
- Transport shutdown
- Graceful cleanup
- Prevent timer leaks

## Postconditions

### After Initialization
- All clean pools pre-allocated to low water mark
- All dirty pools empty
- Statistics initialized to zero
- Worker callbacks registered (if worker mode)
- Async management ready

### After Acquisition
- Buffer returned to application (may or may not be zeroed)
- Async management scheduled to refill clean pool
- Statistics updated (acquired, allocated)

### After Release
- Buffer added to dirty pool (not zeroed yet)
- Async management scheduled to enforce high water mark
- Statistics updated (released)

### After Async Management
- Clean pools maintained at or above low water mark
- Total pools capped at high water mark
- Dirty buffers cleaned as needed
- Excess buffers released or returned to main thread

### After Worker Transfer
- Buffers transferred between threads
- Pool sizes maintained within water marks
- Statistics track transfers

### After Stop
- Async management disabled
- Timer cleared
- Pool operations still functional

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

### 1. Dual-Pool Architecture

**Critical**: Separate clean and dirty pools for deferred zeroing.

**Rationale**:
- Spread zeroing cost over time (not concentrated at release)
- Clean pool always has ready-to-use buffers
- Dirty pool acts as buffer for async management
- Reduces immediate overhead of release operation

**Implementation**:
```javascript
// Each size class has two pools
{
  cleanPool: [],  // Ready-to-use, zeroed buffers
  dirtyPool: [],  // Released buffers awaiting zeroing
  marks: { low, high },
  stats: { ... }
}

// Acquisition priority: clean → dirty (zero it) → allocate
// Release: add to dirty pool (zero later)
```

### 2. Asynchronous Pool Management

**Critical**: Water mark enforcement happens asynchronously to avoid blocking.

**Rationale**:
- Acquire/release operations don't block on zeroing or allocation
- Multiple operations batched together for efficiency
- Yields to event loop between size classes
- Allows application to continue while pools are maintained

**Implementation**:
```javascript
// Operations schedule management
acquire(size) {
  // ... get buffer ...
  this.#ensureMinimum(size);  // sync=false (schedule)
}

release(buffer) {
  // ... add to dirty pool ...
  this.#releaseExcess(size);  // sync=false (schedule)
}

// Management happens in next event loop
#manageLevels(handler = false) {
  if (!handler) {
    // Schedule for next event loop
    this.#timer = setTimeout(() => this.#manageLevels(true), 0);
    return;
  }
  // ... process all sizes in #manageSizes ...
}
```

### 3. Deferred Zeroing Strategy

**Critical**: Buffers zeroed on-demand, not immediately on release.

**Rationale**:
- Spread cost over time (not concentrated at release)
- Zeroing happens during:
  - Acquisition (if clean pool empty, zero a dirty buffer)
  - Async management (clean dirty buffers to reach low/high water marks)
- Security still maintained (buffer zeroed before reuse)
- Better performance characteristics

**Implementation**:
```javascript
// Release: add to dirty pool (NOT zeroed)
release(buffer) {
  dirtyPool.push(buffer);  // No zeroing here
  this.#releaseExcess(size);  // Schedule async management
}

// Acquisition: zero if needed
acquire(size) {
  if (cleanPool.length > 0) {
    return cleanPool.pop();  // Already zeroed
  } else if (dirtyPool.length > 0) {
    const buffer = dirtyPool.pop();
    this.#zeroBuffer(buffer);  // Zero on-demand
    return buffer;
  } else {
    return new ArrayBuffer(size);  // Fresh allocation
  }
}

// Async management: clean dirty buffers as needed
#ensureMinimum(size, sync = true) {
  while (cleanPool.length < marks.low && dirtyPool.length > 0) {
    const buffer = dirtyPool.pop();
    this.#zeroBuffer(buffer);
    cleanPool.push(buffer);
  }
}
```

### 4. Size Class Selection

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

### 5. Water Mark Management

**Critical**: Maintain low water mark after acquisition, high water mark after release.

**Rationale**:
- Low water mark: ensure buffers available for next acquisition
- High water mark: prevent unbounded memory growth
- Automatic management: no manual intervention needed
- Async: doesn't block application operations

**Implementation**:
```javascript
acquire(size) {
  const buffer = /* get from pool or allocate */;
  this.#ensureMinimum(size);  // Schedule async refill
  return buffer;
}

release(buffer) {
  dirtyPool.push(buffer);
  this.#releaseExcess(size);  // Schedule async cap
}
```

### 6. Worker Buffer Transfer

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

**Notes**:
- The main thread is expected to supply clean buffers.
- The main thread assumes returned buffers are dirty.

### 7. Statistics Tracking

**Critical**: Track all buffer operations for monitoring and debugging.

**Rationale**:
- Detect memory leaks (acquired > released)
- Tune water marks based on usage
- Debug allocation issues
- Monitor worker transfers
- Monitor clean vs dirty ratios

**Tracked Metrics**:
- `acquired`: Total buffers acquired
- `released`: Total buffers released
- `allocated`: Total buffers allocated (new ArrayBuffer)
- `transferred`: Total buffers transferred (worker only)
- `clean`: Current clean pool size
- `dirty`: Current dirty pool size
- `available`: Total pool size (clean + dirty)

### 8. Configuration Flexibility

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

### 9. Graceful Shutdown

**Critical**: Support stopping async management during transport shutdown.

**Rationale**:
- Prevent timer leaks
- Allow graceful cleanup
- Pool operations still work after stop

**Implementation**:
```javascript
stop() {
  this.#stopped = true;
  if (this.#timer) {
    clearTimeout(this.#timer);
  }
}

// Check #stopped before scheduling
#manageLevels(handler = false) {
  if (!handler && !this.#stopped) {
    this.#timer = setTimeout(() => this.#manageLevels(true), 0);
  }
}
```

### 10. Testing Strategy

**Critical**: Test all lifecycle stages and error conditions.

**Test Cases**:
1. Initialization with defaults
2. Initialization with custom configuration
3. Acquisition from clean pool
4. Acquisition from dirty pool (with zeroing)
5. Acquisition with allocation
6. Acquisition with size class selection
7. Acquisition with invalid size
8. Release to dirty pool
9. Release without immediate zeroing
10. Async management: ensure minimum
11. Async management: release excess
12. Async management: clean dirty buffers
13. Async management: batching multiple sizes
14. Async management: yielding to event loop
15. Release with high water mark enforcement
16. Release with invalid size
17. Worker mode: request buffers
18. Worker mode: receive buffers
19. Worker mode: return buffers
20. Worker mode: context violations
21. Statistics tracking (including clean/dirty)
22. Pool size queries
23. Water mark queries
24. Multiple acquire/release cycles
25. Stop pool management
26. Operations after stop

## API Reference

### BufferPool

```javascript
class BufferPool {
  constructor(options = {})
  
  // Acquisition
  acquire(requestedSize)           // Returns ArrayBuffer or null
  
  // Release
  release(buffer)                  // Returns boolean (success)
  
  // Lifecycle
  stop()                           // Stop async management
  
  // Worker mode
  receiveBuffers(size, buffers)    // Worker only
  
  // Statistics
  getStats()                       // Returns stats object (includes clean/dirty)
  getPoolSizes()                   // Returns { size: count } (clean + dirty)
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

### Statistics Object

```javascript
{
  sizeClasses: [1024, 4096, 16384, 65536],
  isWorker: false,
  pools: {
    1024: {
      lowWaterMark: 5,
      highWaterMark: 20,
      available: 6,        // Total pool size (clean + dirty)
      clean: 4,            // Ready-to-use buffers
      dirty: 2,            // Buffers awaiting zeroing
      acquired: 42,        // Total acquired
      released: 37,        // Total released
      allocated: 10,       // Total allocated
      transferred: 0       // Total transferred (worker only)
    },
    // ... other size classes ...
  }
}
```

## Performance Considerations

### Memory Efficiency

- **Size classes**: Minimize waste by selecting smallest size that fits
- **Water marks**: Balance between allocation overhead and memory usage
- **Worker transfers**: Zero-copy transfer via `postMessage` transfer list
- **Dual pools**: Separate clean/dirty reduces immediate overhead

### Allocation Overhead

- **Pre-allocation**: Buffers ready when needed (low water mark)
- **Reuse**: Minimize `new ArrayBuffer()` calls
- **Batch allocation**: Refill to low water mark in single operation
- **Async management**: Doesn't block application operations

### Zeroing Overhead

- **Deferred zeroing**: Spread cost over time (not concentrated at release)
- **On-demand**: Zero only when needed (acquisition or management)
- **Async**: Zeroing happens in background (next event loop)
- **Security**: Still prevents data leakage (buffer zeroed before reuse)

### Worker Coordination

- **Async requests**: Worker continues operating while waiting for buffers
- **Batch transfers**: Transfer multiple buffers in single message
- **Automatic management**: No manual intervention needed
- **Dirty buffer return**: Main thread assumes dirty (no zeroing needed)

### Event Loop Integration

- **Non-blocking**: Acquire/release operations don't block on management
- **Batching**: Multiple operations batched together
- **Yielding**: Yields to event loop between size classes
- **Responsive**: Application remains responsive during pool maintenance
