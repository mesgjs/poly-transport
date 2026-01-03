# Code Conformance Checklist - 2026-01-02-A Requirements

Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung

## Overview

This checklist tracks conformance of existing code to the requirements updates from 2026-01-02-A. Use this to guide implementation updates.

## Status Legend

- ✓ **Conformant**: Code meets the requirement
- ⚠️ **Non-Conformant**: Code needs updates
- 🔄 **Partial**: Some aspects conform, others don't
- ➕ **Missing**: Feature not yet implemented

## Requirements Checklist

### 1. API Simplification: `read()` and `readSync()` Replace Old Methods

**Requirement**: Lines 589-590 of [`arch/requirements.md`](requirements.md:589)

| Component | Status | Notes |
|-----------|--------|-------|
| [`src/channel.esm.js`](../src/channel.esm.js:487) | ⚠️ | Has `readChunkSync()` - should be `readSync()` |
| [`src/channel.esm.js`](../src/channel.esm.js:498) | ⚠️ | Has `readChunk()` - should be `read()` |
| [`src/channel.esm.js`](../src/channel.esm.js:530) | ⚠️ | Has `readMessageSync()` - should be removed |
| [`src/channel.esm.js`](../src/channel.esm.js:541) | ⚠️ | Has `readMessage()` - should be removed |
| [`src/channel.esm.js`](../src/channel.esm.js:573) | ⚠️ | Has `_assertReadMessageSupported()` - should be removed |
| [`src/channel.esm.js`](../src/channel.esm.js:434) | ⚠️ | Has `_readMessageSyncInternal()` - should be removed |
| [`test/unit/channel.test.js`](../test/unit/channel.test.js) | ➕ | Tests not yet created |

**Action Items**:
1. Rename `readChunkSync()` → `readSync()`
2. Rename `readChunk()` → `read()`
3. Remove `readMessageSync()` method
4. Remove `readMessage()` method
5. Remove `_assertReadMessageSupported()` method
6. Remove `_readMessageSyncInternal()` method
7. Update all internal references
8. Update all tests
9. Update all documentation

---

### 2. Automatic Chunking in `write()`

**Requirement**: Line 591 of [`arch/requirements.md`](requirements.md:591)

| Component | Status | Notes |
|-----------|--------|-------|
| [`src/channel.esm.js`](../src/channel.esm.js:290) | ⚠️ | `write()` throws on oversized data (line 307-309) |
| [`src/channel.esm.js`](../src/channel.esm.js:290) | ⚠️ | No chunking logic implemented |
| [`test/unit/channel.test.js`](../test/unit/channel.test.js) | ➕ | No auto-chunking tests |
| [`test/integration/auto-chunking.test.js`](../test/integration/auto-chunking.test.js) | ➕ | Test file doesn't exist |

**Action Items**:
1. Remove size check that throws error (lines 307-309)
2. Implement chunking logic in `write()`:
   - Check if `data.length > remoteMaxChunkSize`
   - If yes, split into multiple chunks
   - Set `eom=false` for all but final chunk
   - Set `eom=true` only on final chunk (or single chunk)
   - Maintain message type consistency
3. Add comprehensive comments explaining chunking behavior
4. Create unit tests for auto-chunking
5. Create integration tests for auto-chunking

**Implementation Notes**:
```javascript
// Pseudo-code for chunking logic
async write (type, data, { eom = true, timeout = 0 } = {}) {
	// ... validation ...
	
	if (this.remoteMaxChunkSize === 0 || data.length <= this.remoteMaxChunkSize) {
		// Single chunk - use eom as provided
		// ... existing single-chunk logic ...
	} else {
		// Multi-chunk - split data
		let offset = 0;
		while (offset < data.length) {
			const chunkSize = Math.min(this.remoteMaxChunkSize, data.length - offset);
			const chunkData = data.slice(offset, offset + chunkSize);
			const isLastChunk = (offset + chunkSize >= data.length);
			const chunkEom = isLastChunk ? eom : false;
			
			// ... send chunk with chunkEom ...
			
			offset += chunkSize;
		}
	}
}
```

---

### 3. `maxMessageSize` is Informational Only

**Requirement**: Line 592 of [`arch/requirements.md`](requirements.md:592)

| Component | Status | Notes |
|-----------|--------|-------|
| [`src/channel.esm.js`](../src/channel.esm.js) | ✓ | No enforcement found |
| [`src/flow-control.esm.js`](../src/flow-control.esm.js) | ✓ | No enforcement found |

**Action Items**:
1. Verify no `maxMessageSize` enforcement exists
2. Update documentation to clarify it's advisory only
3. Remove any tests expecting `maxMessageSize` violations

---

### 4. Filtered Reads Must Not Impact Other Filtered Reads

**Requirement**: Line 593 of [`arch/requirements.md`](requirements.md:593)

| Component | Status | Notes |
|-----------|--------|-------|
| [`src/channel.esm.js`](../src/channel.esm.js:394) | 🔄 | `_drainReadWaiters()` exists but needs verification |
| [`src/channel.esm.js`](../src/channel.esm.js:415) | 🔄 | `_readChunkSyncInternal()` has filtering logic |
| [`test/unit/channel.test.js`](../test/unit/channel.test.js) | ➕ | No concurrent filtered read tests |
| [`test/integration/concurrent-filtered-reads.test.js`](../test/integration/concurrent-filtered-reads.test.js) | ➕ | Test file doesn't exist |

**Action Items**:
1. Review `_drainReadWaiters()` to ensure type-aware waiter satisfaction
2. Add comments explaining filtered read behavior
3. Create unit tests for concurrent filtered reads
4. Create integration tests for concurrent filtered reads
5. Document that mixing filtered and unfiltered reads is unsupported

**Implementation Notes**:
- When a chunk arrives, only waiters with matching `onlySet` should be satisfied
- Non-matching waiters should remain pending
- Each waiter tracks its own `onlySet` filter

---

### 5. Out-of-Order Chunk Consumption

**Requirement**: Lines 594-595 of [`arch/requirements.md`](requirements.md:594)

| Component | Status | Notes |
|-----------|--------|-------|
| [`src/flow-control.esm.js`](../src/flow-control.esm.js:277) | ✓ | `onConsumeChunk()` supports out-of-order |
| [`src/flow-control.esm.js`](../src/flow-control.esm.js:311) | ✓ | `createAck()` generates include/skip ranges |
| [`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js) | ✓ | Has out-of-order tests |

**Action Items**:
1. ✓ Already conformant
2. Consider adding more comprehensive out-of-order tests
3. Add comments explaining out-of-order support

---

### 6. Individual Chunk Atomicity, Not Large Write Atomicity

**Requirement**: Lines 596-597 of [`arch/requirements.md`](requirements.md:596)

| Component | Status | Notes |
|-----------|--------|-------|
| Transport output pump | ➕ | Not yet implemented (Phase 1.1) |
| [`test/integration/write-interleaving.test.js`](../test/integration/write-interleaving.test.js) | ➕ | Test file doesn't exist |

**Action Items**:
1. Implement transport output pump with chunk atomicity guarantee
2. Ensure each `[header][payload]` frame is atomic
3. Allow multiple writes to interleave at chunk boundaries
4. Create integration tests for write interleaving
5. Document atomicity guarantees

**Implementation Notes**:
- Output pump must not insert bytes between header and payload of a single chunk
- Multiple concurrent writes may produce: A(chunk1), B(chunk1), A(chunk2), B(chunk2)
- This is acceptable as long as each chunk is atomic

---

### 7. Transport and Channel Budget Hierarchy

**Requirement**: Lines 598-600 of [`arch/requirements.md`](requirements.md:598)

| Component | Status | Notes |
|-----------|--------|-------|
| Transport base class | ➕ | Not yet implemented (Phase 2.1) |
| [`src/flow-control.esm.js`](../src/flow-control.esm.js) | 🔄 | Has channel-level budget, needs transport-level |
| [`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js) | ➕ | No two-level budget tests |
| [`test/integration/two-level-budget.test.js`](../test/integration/two-level-budget.test.js) | ➕ | Test file doesn't exist |

**Action Items**:
1. Implement transport-level budget tracking
2. Extend `FlowController` or create `TransportFlowController`
3. Validate channel limits against transport limits at channel creation
4. Ensure writes check both transport and channel budgets
5. Create unit tests for two-level budget
6. Create integration tests for two-level budget
7. Document budget hierarchy

**Implementation Notes**:
```javascript
// Pseudo-code for two-level budget
import { TaskQueue } from '@task-queue';

class Transport {
	constructor (options) {
		this.maxChunkSize = options.maxChunkSize || 0;
		this.maxBufferSize = options.maxBufferSize || 0;
		this.transportFlow = new FlowController({
			channelId: 0, // transport-level
			remoteMaxBufferSize: options.remoteMaxBufferSize || 0
		});
		this.budgetQueue = new TaskQueue();
	}
	
	async requestChannel (name, options) {
		// Validate channel limits don't exceed transport limits
		if (options.maxChunkSize > this.maxChunkSize) {
			throw new Error('Channel maxChunkSize exceeds transport limit');
		}
		if (options.maxBufferSize > this.maxBufferSize) {
			throw new Error('Channel maxBufferSize exceeds transport limit');
		}
		// ... create channel ...
	}
	
	async _sendChunk (channel, data) {
		// After the channel has budget (and we know it's not "stuck"), FIFO wait for transport budget
		const seqno = await channel._sendFlow.reserveSend(data.length);
		await this.budgetQueue.task(async () => this.transportFlow.reserveSend(data.length));
		// ... send chunk ...
	}
}
```

---

## Documentation Updates Needed

### Code Comments

| File | Location | Status | Notes |
|------|----------|--------|-------|
| [`src/channel.esm.js`](../src/channel.esm.js:290) | `write()` method | ⚠️ | Needs comments on auto-chunking |
| [`src/channel.esm.js`](../src/channel.esm.js:394) | `_drainReadWaiters()` | ⚠️ | Needs comments on type-based filtering |
| [`src/channel.esm.js`](../src/channel.esm.js:415) | `_readChunkSyncInternal()` | ⚠️ | Needs comments on out-of-order consumption |
| [`src/flow-control.esm.js`](../src/flow-control.esm.js:311) | `createAck()` | 🔄 | Has comments, could add note on out-of-order |
| [`src/protocol.esm.js`](../src/protocol.esm.js:115) | `encodeAckHeaderInto()` | 🔄 | Has security comment, could add range format note |

### Documentation Files

| File | Status | Notes |
|------|--------|-------|
| [`arch/implementation-plan.md`](../arch/implementation-plan.md) | ✓ | Updated 2026-01-03 |
| [`arch/test-plan.md`](../arch/test-plan.md) | ✓ | Updated 2026-01-03 |
| [`arch/20260103-requirements-update-analysis.md`](../arch/20260103-requirements-update-analysis.md) | ✓ | Created 2026-01-03 |
| API documentation | ➕ | Needs creation/update |
| Migration guide | ➕ | Needs creation |

---

## Priority Summary

### High Priority (Breaking Changes)
1. ⚠️ Rename `readChunk()` → `read()` and `readChunkSync()` → `readSync()`
2. ⚠️ Remove `readMessage()` and `readMessageSync()`
3. ⚠️ Implement automatic chunking in `write()`
4. ⚠️ Remove `maxMessageSize` enforcement (if any)

### Medium Priority (Enhancements)
5. ➕ Add transport-level budget tracking
6. ➕ Validate channel limits against transport limits
7. 🔄 Ensure filtered reads don't interfere with each other
8. ➕ Implement transport output pump with chunk atomicity

### Low Priority (Documentation)
9. ⚠️ Add comprehensive comments to key methods
10. ➕ Update all documentation references
11. ➕ Create migration guide
12. ➕ Add examples of new behavior

---

## Test Coverage Summary

### Existing Tests to Update
- [`test/unit/protocol.test.js`](../test/unit/protocol.test.js) - ✓ No changes needed
- [`test/unit/buffer-manager.test.js`](../test/unit/buffer-manager.test.js) - ✓ No changes needed
- [`test/unit/flow-control.test.js`](../test/unit/flow-control.test.js) - ⚠️ Add two-level budget tests
- [`test/unit/channel.test.js`](../test/unit/channel.test.js) - ➕ Needs creation with new API

### New Tests to Create
- [`test/integration/auto-chunking.test.js`](../test/integration/auto-chunking.test.js) - ➕ ~10 tests
- [`test/integration/concurrent-filtered-reads.test.js`](../test/integration/concurrent-filtered-reads.test.js) - ➕ ~10 tests
- [`test/integration/write-interleaving.test.js`](../test/integration/write-interleaving.test.js) - ➕ ~8 tests
- [`test/integration/two-level-budget.test.js`](../test/integration/two-level-budget.test.js) - ➕ ~10 tests

---

## Completion Checklist

Use this to track overall progress:

- [ ] All API methods renamed
- [ ] All removed methods deleted
- [ ] Automatic chunking implemented
- [ ] Transport-level budget implemented
- [ ] Channel limit validation implemented
- [ ] Filtered read independence verified
- [ ] Chunk atomicity implemented
- [ ] All unit tests updated
- [ ] All integration tests created
- [ ] All code comments added
- [ ] All documentation updated
- [ ] Migration guide created

---

## Notes

- This checklist should be updated as work progresses
- Mark items as complete (✓) when verified
- Add notes for any deviations or special considerations
- Reference specific line numbers when possible for traceability
