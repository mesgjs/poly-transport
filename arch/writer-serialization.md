# Writer Serialization Architecture

**Date**: 2026-01-14
**Status**: Architectural Decision

## Problem Statement

Multi-writer scenarios with shrinkable reservations create race conditions and potential deadlocks:

1. **Budget theft**: Writer A waits for budget, budget becomes available, Writer B steals it before Writer A can reserve
2. **Shrinkable reservations**: Writer A reserves 3000 bytes (worst-case for string), encodes only 1500 bytes, shrinks reservation - Writer B must see the freed 1500 bytes
3. **Three-level resource coordination**: Channel budget, transport budget, ring buffer space must all be reserved atomically

**Root cause**: Waiting for resources without atomic reservation allows interleaving that breaks correctness.

## Solution: Chunk-Level Serialization

**Key insight**: Writers must serialize at the **chunk level** (not write-operation level) because:
1. **Fairness within channel**: Large multi-chunk messages shouldn't block small single-chunk messages
2. **Dynamic string chunking**: Cannot pre-plan string chunks (UTF-8 is variable-length)
3. **Reservations are provisional**: Budget held until chunk completes and shrinks (if needed)

### Architecture Overview

```
User calls channel.write()
    ↓
Loop for each chunk:
    ↓
    Channel TaskQueue (per-channel, per-chunk serialization)
        ↓
    Reserve channel budget (provisional)
        ↓
    Transport TaskQueue (cross-channel FIFO)
        ↓
    Reserve transport budget (provisional)
        ↓
    Ring TaskQueue (per-ring serialization)
        ↓
    Reserve ring space (provisional)
        ↓
    Encode chunk (may shrink)
        ↓
    Release unused budget (if shrunk)
        ↓
    Commit to ring
        ↓
    Next chunk (or next writer's chunk)
```

## Implementation Details

### 1. Channel Write with Chunk-Level Serialization

**File**: [`src/channel.esm.js`](../src/channel.esm.js)

```javascript
class Channel {
    #writeQueue = new TaskQueue();
    
    async write(data, options) {
        // For binary data: Can calculate chunks upfront
        if (data instanceof Uint8Array) {
            return this.#writeBinaryChunks(data, options);
        }
        
        // For string data: Must encode dynamically
        return this.#writeStringChunks(data, options);
    }
    
    async #writeBinaryChunks(data, options) {
        const maxDataBytes = this.maxChunkBytes - 18;
        let offset = 0;
        
        while (offset < data.length) {
            const chunkDataBytes = Math.min(data.length - offset, maxDataBytes);
            const chunkBytes = 18 + chunkDataBytes;
            const isLast = (offset + chunkDataBytes >= data.length);
            
            // Serialize THIS chunk
            await this.#writeQueue.task(async () => {
                // Reserve resources for THIS chunk
                await this.#flowControl.reserveBudget(chunkBytes);
                await this.#transport._reserveBudget(chunkBytes);
                const reservation = await this.#ring.reserveAsync(chunkBytes);
                
                // Encode THIS chunk
                const seq = this.#flowControl.assignSequence(chunkBytes);
                this.#encodeHeader(reservation, seq, chunkDataBytes, isLast && options.eom);
                reservation.set(data.subarray(offset, offset + chunkDataBytes), 18);
                
                // Commit THIS chunk
                this.#ring.commit(reservation);
            });
            
            offset += chunkDataBytes;
        }
    }
    
    async #writeStringChunks(str, options) {
        const maxDataBytes = this.maxChunkBytes - 18;
        let strOffset = 0;
        
        // Loop until entire string encoded (dynamic chunking)
        while (strOffset < str.length) {
            // Reserve worst-case for remaining string
            const remaining = str.length - strOffset;
            const worstCase = Math.min(remaining * 3, maxDataBytes);
            const chunkBytes = 18 + worstCase;
            
            // Encode THIS chunk (may not use all reserved space)
            const { strRead } = await this.#writeQueue.task(async () => {
                // Reserve resources (worst-case)
                await this.#flowControl.reserveBudget(chunkBytes);
                await this.#transport._reserveBudget(chunkBytes);
                const reservation = await this.#ring.reserveAsync(chunkBytes);
                
                // Encode chunk (returns actual bytes used)
                const seq = this.#flowControl.assignSequence(chunkBytes);
                const result = reservation.encodeFrom(str, 18, 'utf-8', strOffset);
                const actualDataBytes = result.written;
                const actualBytes = 18 + actualDataBytes;
                
                // Determine if last chunk (only know after encoding)
                const isLast = (strOffset + result.read >= str.length);
                
                // Encode header (now we know actual size and isLast)
                this.#encodeHeader(reservation, seq, actualDataBytes, isLast && options.eom);
                
                // Shrink if over-allocated
                if (actualBytes < chunkBytes) {
                    const freed = chunkBytes - actualBytes;
                    this.#flowControl.releaseBudget(freed);
                    this.#transport._releaseBudget(freed);
                    this.#ring.shrinkReservation(reservation, actualBytes);
                }
                
                // Commit THIS chunk
                this.#ring.commit(reservation);
                
                return { strRead: result.read };
            });
            
            // Advance string offset for next chunk
            strOffset += strRead;
            
            // Loop continues if more string to encode
            // (like setTimeout scheduling another setTimeout)
        }
    }
}
```

**Key points**:
- **Per-chunk TaskQueue**: Each chunk serialized independently
- **Binary vs string**: Binary chunks pre-planned, string chunks dynamic
- **Dynamic string chunking**: Only know if done after encoding
- **Provisional reservations**: Budget reserved but may be released after shrinking
- **Fairness**: Chunks from different messages can interleave

### 2. Channel Budget Management

**File**: [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js)

```javascript
class ChannelFlowControl {
    #inFlightBytes = 0;
    #waiters = [];  // Array of { bytes, resolve }
    
    // Reserve budget (provisional until chunk completes)
    async reserveBudget(chunkBytes) {
        if (this.canSend(chunkBytes)) {
            this.#inFlightBytes += chunkBytes;
            return;
        }
        
        return new Promise((resolve) => {
            this.#waiters.push({ bytes: chunkBytes, resolve });
        });
    }
    
    // Release unused budget (after shrinking)
    releaseBudget(bytes) {
        this.#inFlightBytes -= bytes;
        this.#processWaiters();  // Wake up waiters with freed budget
    }
    
    // Assign sequence number (after budget reserved)
    assignSequence(chunkBytes) {
        const seq = this.#nextSendSeq++;
        this.#inFlightChunks.set(seq, chunkBytes);
        return seq;
    }
    
    // Process waiters (reserves atomically before resolving)
    #processWaiters() {
        let budget = this.sendingBudget;
        
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters[0];
            
            if (budget === Infinity || budget >= waiter.bytes) {
                this.#waiters.shift();
                
                // RESERVE ATOMICALLY BEFORE RESOLVING
                this.#inFlightBytes += waiter.bytes;
                
                waiter.resolve();
                
                if (budget !== Infinity) {
                    budget -= waiter.bytes;
                }
            } else {
                break;
            }
        }
    }
}
```

**Key points**:
- **Atomic reservation**: Budget reserved when waiter is awakened (before promise resolves)
- **Release mechanism**: `releaseBudget()` frees unused budget and wakes waiters
- **FIFO ordering**: Waiters processed in order, prevents starvation

### 3. Transport Budget Management

**File**: [`src/transport/base.esm.js`](../src/transport/base.esm.js)

```javascript
class Transport {
    #budgetQueue = new TaskQueue();  // Shared across ALL channels
    #transportBudget;  // TransportFlowControl instance
    
    // Protected method for channels to call
    async _reserveBudget(bytes) {
        // Serialize budget reservation across ALL channels (FIFO round-robin)
        return this.#budgetQueue.task(async () => {
            // Wait for budget (if needed)
            await this.#transportBudget.reserveBudget(bytes);
            // Budget now reserved, return to channel
        });
    }
    
    _releaseBudget(bytes) {
        this.#transportBudget.releaseBudget(bytes);
    }
}

class TransportFlowControl {
    #inFlightBytes = 0;
    #waiters = [];
    
    async reserveBudget(bytes) {
        if (this.available >= bytes) {
            this.#inFlightBytes += bytes;
            return;
        }
        
        return new Promise((resolve) => {
            this.#waiters.push({ bytes, resolve });
        });
    }
    
    releaseBudget(bytes) {
        this.#inFlightBytes -= bytes;
        this.#processWaiters();
    }
    
    #processWaiters() {
        let budget = this.available;
        
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters[0];
            
            if (budget === Infinity || budget >= waiter.bytes) {
                this.#waiters.shift();
                
                // RESERVE ATOMICALLY BEFORE RESOLVING
                this.#inFlightBytes += waiter.bytes;
                
                waiter.resolve();
                
                if (budget !== Infinity) {
                    budget -= waiter.bytes;
                }
            } else {
                break;
            }
        }
    }
}
```

**Key points**:
- **Shared TaskQueue**: All channels serialize through single transport budget queue
- **FIFO round-robin**: Channels get budget in order, prevents channel starvation
- **Same atomic reservation pattern**: Budget reserved before promise resolves

### 4. Ring Buffer Space Management

**File**: [`src/output-ring-buffer.esm.js`](../src/output-ring-buffer.esm.js)

```javascript
class OutputRingBuffer {
    #reserveQueue = new TaskQueue();
    #spaceWaiter = null;  // Single waiter: { bytes, resolve }
    
    async reserveAsync(length) {
        return this.#reserveQueue.task(async () => {
            // Wait for space (if needed)
            if (this.space < length) {
                await new Promise((resolve) => {
                    this.#spaceWaiter = { bytes: length, resolve };
                });
            }
            
            // Space available, reserve it
            return this.reserve(length);  // Synchronous reserve
        });
    }
    
    consume(length) {
        // Zero consumed space
        const start = this.#readHead;
        const end = (start + length) % this.#size;
        
        if (end > start) {
            this.#buffer.fill(0, start, end);
        } else {
            this.#buffer.fill(0, start);
            this.#buffer.fill(0, 0, end);
        }
        
        // Update state
        this.#readHead = end;
        this.#count -= length;
        
        // Wake up THE waiter (if any and if satisfied)
        if (this.#spaceWaiter && this.space >= this.#spaceWaiter.bytes) {
            const waiter = this.#spaceWaiter;
            this.#spaceWaiter = null;
            waiter.resolve();
        }
    }
}
```

**Key points**:
- **Single waiter model**: TaskQueue ensures only one writer waiting at a time
- **Wake on consume**: When space freed, wake waiter if requirement met
- **No waiter queue**: Serialization via TaskQueue eliminates need for queue

## Why This Architecture Works

### 1. No Deadlocks

**Complete serialization** at each level:
- Only one chunk active per channel
- Only one budget reservation active across all channels
- Only one ring reservation active per ring

**No circular waits**: Resources acquired in fixed order (channel → transport → ring)

### 2. No Race Conditions

**Atomic reservations**:
- Budget reserved when waiter awakened (before promise resolves)
- No window for budget theft

**Provisional reservations**:
- Budget held until chunk completes
- Shrinking releases unused budget
- Next chunk sees accurate available budget

### 3. Fairness

**Chunk-level serialization**:
- Large multi-chunk messages don't block small single-chunk messages
- Chunks from different messages interleave naturally

**FIFO ordering** at each level:
- Channel chunks: FIFO per channel
- Transport budget: FIFO across all channels (round-robin)
- Ring space: FIFO per ring (single waiter)

**No starvation**: Large writes don't block small writes indefinitely

### 4. Dynamic String Chunking

**Cannot pre-plan**: UTF-8 encoding is variable-length (1-4 bytes per code point)

**Must encode to know**: Only after `encodeFrom()` do you know:
- How many UTF-16 code units consumed (`result.read`)
- How many bytes written (`result.written`)
- Whether you're done (`strOffset + result.read >= str.length`)

**Loop pattern**: Like `setTimeout` scheduling another `setTimeout`:
```javascript
while (strOffset < str.length) {
    await this.#writeQueue.task(async () => {
        // Encode chunk
        const result = reservation.encodeFrom(str, 18, 'utf-8', strOffset);
        strOffset += result.read;
        // Loop continues if more to encode
    });
}
```

## Key Architectural Principles

1. **Serialize at chunk level** (not write-operation level)
2. **Dynamic string chunking** (cannot pre-plan)
3. **Provisional reservations** until chunk completes
4. **Atomic reservation** when waiter is awakened
5. **Release unused budget** after shrinking
6. **FIFO ordering** at each level
7. **Single waiter** for ring buffer space (TaskQueue ensures serialization)
8. **Fixed resource acquisition order** (channel → transport → ring)

## Fairness Example

**Scenario**: Channel has 3 pending writes:
- Message A: 5MB (50 chunks)
- Message B: 100 bytes (1 chunk)
- Message C: 200 bytes (1 chunk)

**Write-operation-level** (unfair):
```
A1 A2 A3 ... A50 B1 C1
```
Messages B and C wait for entire 5MB message A

**Chunk-level** (fair):
```
A1 B1 A2 C1 A3 A4 A5 ... A50
```
Messages B and C interleave with message A

## API Changes Required

### ChannelFlowControl

**New methods**:
- `releaseBudget(bytes)` - Release unused budget after shrinking
- `assignSequence(chunkBytes)` - Assign sequence number (separate from budget reservation)

**Modified methods**:
- `reserveBudget(chunkBytes)` - Now reserves atomically (was `waitForBudget()`)
- `#processWaiters()` - Now reserves atomically before resolving

**Removed methods**:
- `recordSent(chunkBytes)` - Split into `reserveBudget()` + `assignSequence()`

### Transport

**New protected methods**:
- `async _reserveBudget(bytes)` - Reserve transport budget (channels call this)
- `_releaseBudget(bytes)` - Release unused transport budget

**New internal**:
- `#budgetQueue` - TaskQueue for serializing budget reservations across channels
- `#transportBudget` - TransportFlowControl instance

### OutputRingBuffer

**New methods**:
- `async reserveAsync(length)` - Async reserve with waiting (serialized via TaskQueue)

**Modified methods**:
- `consume(length)` - Now wakes single waiter if space requirement met

**New internal**:
- `#reserveQueue` - TaskQueue for serializing reservations
- `#spaceWaiter` - Single waiter object (not array)

## Testing Considerations

### Unit Tests

1. **ChannelFlowControl**:
   - Test `reserveBudget()` with immediate availability
   - Test `reserveBudget()` with waiting
   - Test `releaseBudget()` wakes waiters
   - Test atomic reservation (no budget theft)
   - Test FIFO ordering

2. **TransportFlowControl**:
   - Same tests as ChannelFlowControl
   - Test cross-channel FIFO ordering

3. **OutputRingBuffer**:
   - Test `reserveAsync()` with immediate space
   - Test `reserveAsync()` with waiting
   - Test `consume()` wakes waiter
   - Test single waiter model

### Integration Tests

1. **Multi-writer scenarios**:
   - Multiple channels writing simultaneously
   - Verify FIFO ordering
   - Verify no budget theft
   - Verify no deadlocks

2. **Shrinkable reservation scenarios**:
   - String encoding with shrinking
   - Verify freed budget available to next chunk
   - Verify correct final budget accounting

3. **Resource exhaustion scenarios**:
   - Exhaust channel budget
   - Exhaust transport budget
   - Exhaust ring buffer space
   - Verify correct blocking and wake-up

4. **Chunk interleaving scenarios**:
   - Large multi-chunk message + small single-chunk message
   - Verify chunks interleave fairly
   - Verify small message doesn't wait for large message

## Performance Considerations

### Overhead

**TaskQueue overhead**:
- Minimal: Single microtask per chunk
- Amortized across chunk encoding/I/O
- Negligible compared to encoding/I/O

**Waiter processing**:
- O(n) where n = number of waiting chunks
- Typically small (most chunks don't wait)
- Only processed when budget freed

### Optimization Opportunities

**Fast path** (no waiting):
- If all resources immediately available, minimal TaskQueue overhead
- Direct reservation and encoding
- Minimal latency

**Batch processing**:
- Multiple waiters can be awakened in single `#processWaiters()` call
- Efficient use of freed budget

## Migration Path

### Phase 1: Update ChannelFlowControl

1. Add `releaseBudget()` method
2. Add `assignSequence()` method
3. Update `#processWaiters()` to reserve atomically
4. Rename `waitForBudget()` → `reserveBudget()`
5. Update tests

### Phase 2: Implement TransportFlowControl

1. Create `TransportFlowControl` class
2. Add to Transport base class
3. Add `_reserveBudget()` and `_releaseBudget()` protected methods
4. Add `#budgetQueue` TaskQueue
5. Update tests

### Phase 3: Update OutputRingBuffer

1. Add `reserveAsync()` method
2. Add `#reserveQueue` TaskQueue
3. Change `#spaceWaiters` array → `#spaceWaiter` single object
4. Update `consume()` to wake single waiter
5. Update tests

### Phase 4: Update Channel

1. Add `#writeQueue` TaskQueue
2. Implement `#writeBinaryChunks()` with chunk-level serialization
3. Implement `#writeStringChunks()` with dynamic chunking
4. Update to use `reserveBudget()` + `assignSequence()` pattern
5. Add shrinking logic with `releaseBudget()`
6. Update tests

### Phase 5: Update Scenarios

1. Update [`arch/scenarios/simple-write.md`](scenarios/simple-write.md)
2. Update [`arch/scenarios/multi-chunk-write.md`](scenarios/multi-chunk-write.md)
3. Document chunk-level serialization
4. Document dynamic string chunking
5. Document provisional reservation + shrink pattern

## Related Documents

- [`arch/requirements.md`](requirements.md) - Update 2026-01-14-A (to be added)
- [`arch/flow-control-budget-model.md`](flow-control-budget-model.md) - Budget interaction model
- [`arch/scenarios/simple-write.md`](scenarios/simple-write.md) - Single-chunk write flow
- [`arch/scenarios/multi-chunk-write.md`](scenarios/multi-chunk-write.md) - Multi-chunk write flow
- [`src/channel-flow-control.esm.js`](../src/channel-flow-control.esm.js) - Current implementation
- [`resources/task-queue/src/task-queue.esm.js`](../resources/task-queue/src/task-queue.esm.js) - TaskQueue implementation

## References

- TaskQueue: [`resources/task-queue/src/task-queue.esm.js`](../resources/task-queue/src/task-queue.esm.js)
- Requirements: [`arch/requirements.md`](requirements.md) lines 599-601, 610-612, 643-648
- Flow Control Model: [`arch/flow-control-budget-model.md`](flow-control-budget-model.md)
