# Requirements Update Analysis - 2026-01-02-A

Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung

## Overview

This document analyzes the requirements updates from 2026-01-02-A (lines 587-600 in [`arch/requirements.md`](../arch/requirements.md:587)) and their impact on implementation and test plans.

## Requirements Changes Summary

### 1. API Simplification: `read()` and `readSync()` Replace `readChunk()` and `readChunkSync()`

**Change**: Lines 589-590
- **Old**: `readChunk()`, `readChunkSync()`, `readMessage()`, `readMessageSync()`
- **New**: `read()`, `readSync()` (no message-level read methods)

**Rationale**: Simplifies the API by removing message-level abstractions. Applications that need message boundaries can track them using the `eom` flag from chunk reads.

**Impact**:
- Channel API must be updated
- All references to `readChunk` → `read`
- All references to `readChunkSync` → `readSync`
- Remove `readMessage()` and `readMessageSync()` entirely
- Remove `_assertReadMessageSupported()` validation
- Update all tests
- Update all documentation

### 2. Automatic Chunking in `write()`

**Change**: Line 591
- **Old**: `write()` expects data to fit within chunk limits
- **New**: `write()` must automatically chunk writes that exceed the chunk limit

**Rationale**: Simplifies caller code by handling chunking transparently. Only the final chunk of a multi-chunk write should have `eom=true` (if the caller asserts that the write is a complete message).

**Impact**:
- `write()` implementation must:
  - Check if data exceeds `remoteMaxChunkSize`
  - Split data into multiple chunks if needed
  - Set `eom=false` for all but the final chunk
  - Set `eom=true` only on the final chunk (or single chunk)
  - Maintain message type consistency across all chunks
- Flow control must handle multiple sequential chunks from a single write
- Tests must verify chunking behavior

### 3. `maxMessageSize` is Informational Only

**Change**: Line 592
- **Old**: `maxMessageSize` was enforced
- **New**: `maxMessageSize` is strictly informational, not enforced

**Rationale**: Enforcement is complex and not necessary if chunking is handled properly. Applications can use this value for guidance but it's not a hard limit.

**Impact**:
- Remove any `maxMessageSize` enforcement logic
- Keep the field for informational purposes
- Update documentation to clarify it's advisory only
- Tests should not expect `maxMessageSize` violations to be rejected

### 4. Filtered Reads Must Not Impact Other Filtered Reads

**Change**: Line 593
- **Old**: Behavior not explicitly specified
- **New**: A filtered (`{ only }`) read must not cancel/reject any other filtered reads

**Rationale**: Typed messages act like "light-weight channels" within channels. Multiple consumers may be reading different message types concurrently, and they should not interfere with each other.

**Impact**:
- Read waiters must be type-aware
- When a chunk arrives, only waiters matching that type should be satisfied
- Non-matching waiters should remain pending
- Tests must verify concurrent filtered reads work independently

### 5. Out-of-Order Chunk Consumption

**Change**: Line 594-595
- **Old**: Behavior not explicitly specified
- **New**: Due to type-based filtering, chunks may be read/released/ACK'd out of sequence

**Rationale**: If multiple message types are in flight, a reader filtering for type A may consume A chunks while B chunks remain buffered. The ACK format already supports include/skip ranges for this scenario.

**Impact**:
- Flow control already supports this (implemented in Phase 1.3)
- Channel implementation must allow out-of-order consumption
- Tests must verify out-of-order ACK generation works correctly

### 6. Individual Chunk Atomicity, Not Large Write Atomicity

**Change**: Line 596-597
- **Old**: Behavior not explicitly specified
- **New**: Individual chunks must be written atomically (with their headers), but "large writes" need not be atomic

**Rationale**: Two concurrent writes (e.g., type A and type B, each 128K) might interleave as A(64K#1), B(64K#1), A(64K#2), B(64K#2). This is acceptable as long as each individual chunk is atomic.

**Impact**:
- Transport output pump must ensure each `[header][payload]` frame is atomic
- Multiple writes may interleave at chunk boundaries
- Tests must verify chunk atomicity but allow write interleaving

### 7. Transport and Channel Budget Hierarchy

**Change**: Line 598-600
- **Old**: Behavior not explicitly specified
- **New**: Transports and channels have corresponding max chunk and max buffer limits. Channel limits may not exceed transport limits. Writes must fit within both the transport sending budget and the channel sending budget.

**Rationale**: Provides a two-level flow control system. Transport-level limits prevent any single channel from monopolizing resources. Channel-level limits provide per-channel control.

**Impact**:
- Transport must track its own budget separate from channel budgets
- Channel writes must check both transport and channel budgets
- Channel limits must be validated against transport limits at channel creation
- Tests must verify two-level budget enforcement

## Conformance Issues in Existing Code

### [`src/channel.esm.js`](../src/channel.esm.js)

#### Issue 1: Method Names (Lines 487-571)
**Current**: `readChunkSync()`, `readChunk()`, `readMessageSync()`, `readMessage()`
**Required**: `readSync()`, `read()` (no message methods)
**Fix**: Rename methods and remove message-level methods

#### Issue 2: No Automatic Chunking in `write()` (Lines 290-340)
**Current**: `write()` throws if data exceeds `remoteMaxChunkSize` (line 307-309)
**Required**: `write()` must automatically chunk large writes
**Fix**: Implement chunking logic in `write()`

#### Issue 3: `_assertReadMessageSupported()` (Lines 573-582)
**Current**: Validates message read support
**Required**: Not needed (no message reads)
**Fix**: Remove this method entirely

#### Issue 4: `_readMessageSyncInternal()` (Lines 434-485)
**Current**: Implements message-level reading
**Required**: Not needed
**Fix**: Remove this method entirely

### [`src/flow-control.esm.js`](../src/flow-control.esm.js)

**Status**: ✓ Already conformant
- Supports out-of-order chunk consumption (lines 277-293)
- ACK generation uses include/skip ranges (lines 311-395)
- No changes needed

### [`src/protocol.esm.js`](../src/protocol.esm.js)

**Status**: ✓ Already conformant
- Protocol encoding/decoding is correct
- No changes needed

## Documentation and Comments Needed

### Areas Needing Better Comments

1. **[`src/channel.esm.js`](../src/channel.esm.js:290)** - `write()` method
   - Needs comments explaining automatic chunking behavior
   - Should document how `eom` flag is handled across chunks
   - Should explain message type consistency requirement

2. **[`src/channel.esm.js`](../src/channel.esm.js:394)** - `_drainReadWaiters()`
   - Needs comments explaining type-based filtering
   - Should document why only matching waiters are satisfied

3. **[`src/channel.esm.js`](../src/channel.esm.js:415)** - `_readChunkSyncInternal()`
   - Needs comments explaining out-of-order consumption
   - Should document interaction with flow control

4. **[`src/flow-control.esm.js`](../src/flow-control.esm.js:311)** - `createAck()`
   - Already well-commented, but could add note about out-of-order support

5. **[`src/protocol.esm.js`](../src/protocol.esm.js:115)** - `encodeAckHeaderInto()`
   - Already has security comment about padding
   - Could add note about include/skip range format

## Implementation Priority

### High Priority (Breaking Changes)
1. Rename `readChunk()` → `read()` and `readChunkSync()` → `readSync()`
2. Remove `readMessage()` and `readMessageSync()`
3. Implement automatic chunking in `write()`
4. Remove `maxMessageSize` enforcement

### Medium Priority (Enhancements)
5. Add transport-level budget tracking
6. Validate channel limits against transport limits
7. Ensure filtered reads don't interfere with each other

### Low Priority (Documentation)
8. Add comprehensive comments to key methods
9. Update all documentation references
10. Add examples of new behavior

## Test Plan Updates Required

### Unit Tests to Update

1. **[`test/unit/channel.test.js`](../test/unit/channel.test.js)**
   - Rename all `readChunk` tests → `read`
   - Rename all `readChunkSync` tests → `readSync`
   - Remove all `readMessage` and `readMessageSync` tests
   - Add tests for automatic chunking in `write()`
   - Add tests for concurrent filtered reads
   - Add tests for write interleaving at chunk boundaries

2. **[`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js)**
   - ✓ Already has out-of-order tests
   - Add tests for two-level budget (transport + channel)

3. **[`test/unit/protocol.test.js`](../test/unit/protocol.test.js)**
   - ✓ No changes needed

### Integration Tests to Add

1. **Multi-type concurrent reads**
   - Multiple readers with different `{ only }` filters
   - Verify they don't interfere with each other

2. **Large write chunking**
   - Write data exceeding chunk limit
   - Verify automatic chunking
   - Verify `eom` flag only on final chunk

3. **Write interleaving**
   - Two concurrent writes of different types
   - Verify chunks may interleave
   - Verify each chunk is atomic

4. **Two-level budget enforcement**
   - Transport-level budget limits
   - Channel-level budget limits
   - Verify both are enforced

## Migration Guide for Existing Code

### For Code Using Old API

```javascript
// OLD:
const chunk = await channel.readChunk({ timeout: 1000, only: 'myType' });
const message = await channel.readMessage({ timeout: 1000, only: 'myType' });

// NEW:
const chunk = await channel.read({ timeout: 1000, only: 'myType' });
// For message-level reading, accumulate chunks until eom=true:
const chunks = [];
let chunk;
do {
  chunk = await channel.read({ timeout: 1000, only: 'myType' });
  chunks.push(chunk.data);
} while (!chunk.eom);
const message = concatenateChunks(chunks);
```

### For Code Writing Large Data

```javascript
// OLD:
if (data.length > channel.remoteMaxChunkSize) {
  // Manual chunking required
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.slice(offset, offset + chunkSize);
    const eom = (offset + chunkSize >= data.length);
    await channel.write(type, chunk, { eom });
  }
}

// NEW:
// Automatic chunking - just write the data
await channel.write(type, data, { eom: true });
```

## Next Steps

1. Update [`arch/implementation-plan.md`](../arch/implementation-plan.md) with these changes
2. Update [`arch/test-plan.md`](../arch/test-plan.md) with new test requirements
3. Create a conformance checklist for existing code
4. Prioritize implementation of breaking changes
5. Add comprehensive comments to key areas
