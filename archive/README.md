# Archived Implementation (2026-01-03)

This directory contains the initial implementation attempt that was archived due to a fundamental architectural mismatch with the requirements.

## Why Archived

The implementation was based on an incorrect interpretation of the channel architecture:

- **Requirements**: A channel can be unidirectional OR bidirectional, determined by whether one or both sides request it
- **This implementation**: Each `Channel` object represents a single direction (`direction: 'read'` or `direction: 'write'`)

This mismatch meant that:
- Methods like `clear({direction})` and `close({direction})` didn't make sense (each Channel was already a single direction)
- The architecture would need complete restructuring, not just bug fixes
- All 358+ tests were testing the wrong assumptions

## What's Archived

### Source Files
- `src/protocol.esm.js` - Protocol layer (message encoding/decoding)
- `src/buffer-manager.esm.js` - Buffer management (VirtualBuffer, BufferPool, RingBuffer)
- `src/flow-control.esm.js` - Flow control (credit-based system)
- `src/channel.esm.js` - Channel implementation (incorrect architecture)

### Test Files
- `test/unit/protocol.test.js` - 40+ protocol tests
- `test/unit/buffer-manager.test.js` - 69 buffer management tests
- `test/unit/flow-control.test.js` - 103 flow control tests
- `test/unit/channel.test.js` - 146 channel tests

### Documentation
- `arch/implementation-plan.md` - Implementation plan based on incorrect architecture
- `arch/test-plan.md` - Test plan based on incorrect architecture
- `arch/20260103-code-conformance-checklist.md` - Conformance tracking
- `arch/20260103-deep-code-analysis.md` - Line-by-line analysis
- `arch/20260103-requirements-update-analysis.md` - Requirements analysis

## Lessons Learned

1. **Verify architecture early**: The fundamental channel model should have been validated against requirements before implementation
2. **Test count ≠ correctness**: Having many passing tests doesn't mean you're building the right thing
3. **Requirements are the source of truth**: When in doubt, always refer back to the requirements document

## What Was Kept

- `arch/requirements.md` - The authoritative requirements specification
- `nanos/` - NANOS library dependency (correct and needed)
- Memory bank files - Updated to reflect the reset

## Next Steps

The project will restart with correct architecture:
- Channel = potentially bidirectional container (may have read direction, write direction, or both)
- Each direction has its own flow control
- Methods like `close({direction})` operate on one direction of a bidirectional channel
