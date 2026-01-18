# Scenario: Virtual Buffer Operations

**Status**: Complete
**Last Updated**: 2026-01-17

## Overview

This scenario documents the operations of VirtualBuffer (read-only) and VirtualRWBuffer (read-write) classes, which provide zero-copy buffer views that can span multiple non-contiguous memory segments. These classes are fundamental to PolyTransport's efficient buffer management strategy.

**Key Implementation Details**:
- **Segment caching**: VirtualBuffer caches the last accessed segment to minimize segment searches during sequential access
- **Multi-segment support**: Can span 2+ segments (e.g., OutputRingBuffer wrap-around: 2 segments; VirtualRingBuffer large reservation: 200KB = 64KB + 64KB + 64KB + 8KB of 16KB buffer)

## Purpose

Virtual buffers enable:
- **Zero-copy operations**: Direct access to underlying buffers without intermediate copies
- **Multi-segment support**: Single logical view over multiple physical buffer segments
- **DataView compatibility**: Standard DataView methods (getUint8/16/32, setUint8/16/32)
- **Text encoding/decoding**: Direct UTF-8 encoding/decoding without intermediate buffers
- **Ring buffer integration**: Efficient reading/writing across ring buffer wrap-around boundaries

## Key Components

- **VirtualBuffer**: Read-only buffer view (for reading received data)
- **VirtualRWBuffer**: Read-write buffer view (for writing outgoing data)
- **Segment**: Single contiguous Uint8Array within a virtual buffer
- **TextEncoder/TextDecoder**: Standard Web APIs for UTF-8 encoding/decoding

## Scenario 1: VirtualBuffer Creation and Basic Operations

### Initial State

Application has received data in one or more buffers and needs to process it.

### Step-by-Step Flow

#### 1. Create VirtualBuffer from Single Segment

**Input**: Single Uint8Array buffer

```javascript
const buffer = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
const vb = new VirtualBuffer([buffer]);
```

**State**:
- `vb.length` = 5
- `vb.segmentCount` = 1
- Internal segments array: `[{ buffer, start: 0, end: 5 }]`

#### 2. Create VirtualBuffer from Multiple Segments

**Input**: Array of Uint8Array buffers (e.g., from ring buffer wrap-around)

```javascript
const segment1 = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
const segment2 = new Uint8Array([0x6C, 0x6F]);       // "lo"
const vb = new VirtualBuffer([segment1, segment2]);
```

**State**:
- `vb.length` = 5
- `vb.segmentCount` = 2
- Internal segments array: `[{ buffer: segment1, start: 0, end: 3 }, { buffer: segment2, start: 0, end: 2 }]`

#### 3. Read Bytes Using DataView Methods

**Operation**: Read individual bytes

```javascript
const byte0 = vb.getUint8(0); // 0x48 ('H')
const byte4 = vb.getUint8(4); // 0x6F ('o')
```

**Internal Logic**:
- `getUint8(offset)` locates the segment containing `offset`
- For single-segment: Direct access to `segment.buffer[segment.start + offset]`
- For multi-segment: Calculate cumulative offset across segments

#### 4. Read Multi-Byte Values

**Operation**: Read 16-bit or 32-bit values (potentially spanning segments)

```javascript
const buffer = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
const vb = new VirtualBuffer([buffer]);

const uint16 = vb.getUint16(0, false); // 0x1234 (big-endian)
const uint32 = vb.getUint32(0, false); // 0x12345678 (big-endian)
```

**Internal Logic**:
- For values within single segment: Direct DataView access
- For values spanning segments: Read bytes individually and combine

#### 5. Slice Virtual Buffer

**Operation**: Create sub-view without copying

```javascript
const vb = new VirtualBuffer([new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F])]);
const slice = vb.slice(1, 4); // "ell"
```

**State**:
- `slice.length` = 3
- `slice.segmentCount` = 1
- Internal segments: `[{ buffer: original, start: 1, end: 4 }]`
- **Zero-copy**: Slice references original buffer, no data copied

#### 6. Decode Text (Single Segment)

**Operation**: Decode UTF-8 text from single segment

```javascript
const vb = new VirtualBuffer([new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F])]);
const text = vb.decode(); // "Hello"
```

**Internal Logic**:
- Single segment: Direct `TextDecoder.decode(segment.buffer.subarray(start, end))`
- **Zero-copy**: No intermediate buffer allocation

#### 7. Decode Text (Multiple Segments with Streaming)

**Operation**: Decode UTF-8 text spanning multiple segments

```javascript
const segment1 = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
const segment2 = new Uint8Array([0x6C, 0x6F]);       // "lo"
const vb = new VirtualBuffer([segment1, segment2]);
const text = vb.decode(); // "Hello"
```

**Internal Logic**:
- Create `TextDecoder` instance
- For each segment except last: `decoder.decode(segment, { stream: true })`
- For last segment: `decoder.decode(segment, { stream: false })`
- **Streaming decoder**: Correctly handles multi-byte UTF-8 sequences split across segments

**Example with Split UTF-8 Sequence**:

```javascript
// UTF-8 encoding of "€" (U+20AC) is [0xE2, 0x82, 0xAC]
const segment1 = new Uint8Array([0x48, 0xE2]);       // "H" + first byte of "€"
const segment2 = new Uint8Array([0x82, 0xAC, 0x69]); // rest of "€" + "i"
const vb = new VirtualBuffer([segment1, segment2]);
const text = vb.decode(); // "H€i"
```

**Why Streaming Works**:
- First segment: Decoder sees incomplete sequence, buffers 0xE2
- Second segment: Decoder completes sequence with 0x82, 0xAC, outputs "€"

#### 8. Copy to Uint8Array

**Operation**: Copy virtual buffer contents to new Uint8Array

```javascript
const vb = new VirtualBuffer([segment1, segment2]);
const copy = vb.toUint8Array(); // New Uint8Array with all data
```

**Internal Logic**:
- Allocate new `Uint8Array(vb.length)`
- Copy each segment to appropriate offset in new array
- Return new array

**Optional Buffer Parameter**:

```javascript
const buffer = new Uint8Array(10); // Pre-allocated buffer
vb.toUint8Array(buffer); // Copy into existing buffer at offset 0
```

## Scenario 2: VirtualRWBuffer Write Operations

### Initial State

Application needs to write data to a ring buffer reservation (potentially spanning wrap-around).

### Step-by-Step Flow

#### 1. Create VirtualRWBuffer from Ring Buffer Reservation

**Input**: Ring buffer reservation (one or two segments)

```javascript
// Single segment (no wrap-around)
const reservation = ringBuffer.reserve(100);
// reservation is VirtualRWBuffer with one segment
// reservation.length = 100
// reservation.segmentCount = 1

// Two segments (wrap-around)
const reservation = ringBuffer.reserve(100);
// reservation is VirtualRWBuffer with two segments
// reservation.length = 100
// reservation.segmentCount = 2
```

**Critical**: Only ONE reservation can be pending at a time. The ring buffer enforces this with `if (this.#pendingReservation !== null) throw new RingBufferReservationError('Reservation already pending')`.

**State**:
- `reservation.length` = 100
- `reservation.segmentCount` = 1 or 2 (depending on wrap-around)
- Ring buffer: `ring.#pendingReservation = reservation`

#### 2. Write Bytes Using DataView Methods

**Operation**: Write individual bytes

```javascript
reservation.setUint8(0, 0x48); // 'H'
reservation.setUint8(1, 0x65); // 'e'
```

**Internal Logic**:
- `setUint8(offset, value)` locates segment containing `offset`
- Writes directly to `segment.buffer[segment.start + offset]`
- Handles wrap-around transparently (second segment if needed)

#### 3. Write Multi-Byte Values

**Operation**: Write 16-bit or 32-bit values

```javascript
reservation.setUint16(0, 0x1234, false); // Big-endian
reservation.setUint32(2, 0x56789ABC, false); // Big-endian
```

**Internal Logic**:
- For values within single segment: Direct DataView access
- For values spanning segments: Write bytes individually across segments

#### 4. Copy Data Using set()

**Operation**: Copy data from source array

```javascript
const source = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
reservation.set(source, 0); // Copy to offset 0
```

**Internal Logic**:
- For single segment: Direct `segment.buffer.set(source, segment.start + offset)`
- For multiple segments: Split copy across segments at boundaries

**Example with Wrap-Around**:

```javascript
// Reservation spans two segments: [0..10] and [0..5]
const source = new Uint8Array(12); // 12 bytes
reservation.set(source, 4); // Copy starting at offset 4

// Internal logic:
// - First 6 bytes (4..9) go to first segment
// - Next 6 bytes (0..5) go to second segment
```

#### 5. Fill with Value

**Operation**: Fill range with specific byte value

```javascript
reservation.fill(0x00, 0, 10); // Zero first 10 bytes
reservation.fill(0xFF, 10, 20); // Fill bytes 10-19 with 0xFF
```

**Internal Logic**:
- For single segment: Direct `segment.buffer.fill(value, start, end)`
- For multiple segments: Fill each segment's portion separately

#### 6. Encode Text (Single Chunk)

**Operation**: Encode UTF-8 text directly into reservation

```javascript
const text = "Hello, World!";
const result = reservation.encodeFrom(text, 0);
// result = { read: 13, written: 13 }
```

**State**:
- `result.read` = 13 (UTF-16 code units consumed from string)
- `result.written` = 13 (bytes written to buffer)
- Reservation now contains UTF-8 encoding of "Hello, World!"

**Internal Logic**:
- Create `TextEncoder` instance
- For single segment: Direct `encoder.encodeInto(text, segment.buffer.subarray(start, end))`
- For multiple segments: Encode to first segment, then continue to second if needed

#### 7. Encode Text (Multi-Chunk with Shrinking)

**Operation**: Encode large string that requires multiple chunks

**Critical**: Only ONE reservation can be pending at a time, so this is a LOOP of reserve→encode→shrink→commit cycles, NOT multiple simultaneous reservations.

```javascript
const largeText = "..."; // 10,000 characters
let offset = 0;

while (offset < largeText.length) {
  // Over-allocate: worst-case UTF-8 is 3 bytes per UTF-16 code unit
  const remaining = largeText.length - offset;
  const reserveSize = Math.min(remaining * 3, maxChunkSize);
  
  // Reserve space (only one reservation at a time)
  const reservation = ringBuffer.reserve(reserveSize);
  
  // Encode as much as fits
  const result = reservation.encodeFrom(largeText, offset);
  
  // Shrink reservation to actual bytes written
  reservation.shrink(result.written);
  
  // Commit (frees pending reservation slot)
  ringBuffer.commit(reservation);
  
  // Now can reserve again for next chunk
  
  // Advance offset
  offset += result.read;
}
```

**Key Points**:
- **Over-allocation**: Reserve worst-case (3 bytes per code unit)
- **Actual encoding**: May use fewer bytes (ASCII = 1 byte, most common = 2 bytes)
- **Shrinking**: Release unused space back to ring buffer
- **Commit before next reserve**: Must commit current reservation before reserving next chunk
- **Resume encoding**: `offset` tracks position in string for next chunk

#### 8. Shrink Reservation

**Operation**: Reduce reservation size after encoding

```javascript
const reservation = ringBuffer.reserve(100); // Reserve 100 bytes
const result = reservation.encodeFrom("Hello", 0);
// result.written = 5

reservation.shrink(5); // Shrink to actual bytes used
```

**State**:
- Reservation length reduced from 100 to 5
- Ring buffer's `#reserved` field updated: `#reserved -= 95`
- Freed space available for next reservation

**Internal Logic**:
- Validate: `newLength <= currentLength`
- Update segment end offsets
- Update ring buffer's reserved bytes counter
- **Important**: Must shrink before commit (after commit, reservation is immutable)

## Scenario 3: Edge Cases and Error Handling

### Edge Case 1: Empty Virtual Buffer

```javascript
const vb = new VirtualBuffer([]);
// vb.length = 0
// vb.segmentCount = 0
// vb.decode() = ""
// vb.toUint8Array() = new Uint8Array(0)
```

### Edge Case 2: Out-of-Bounds Access

```javascript
const vb = new VirtualBuffer([new Uint8Array([0x48, 0x65])]);
try {
  vb.getUint8(5); // Out of bounds
} catch (error) {
  // RangeError: Offset out of bounds
}
```

### Edge Case 3: Invalid Slice Range

```javascript
const vb = new VirtualBuffer([new Uint8Array([0x48, 0x65, 0x6C])]);
const slice = vb.slice(5, 10); // Beyond buffer length
// Returns empty VirtualBuffer (length = 0)
```

### Edge Case 4: Shrink to Zero

```javascript
const reservation = ringBuffer.reserve(100);
reservation.shrink(0); // Valid: shrink to zero bytes
// Reservation length = 0
// All reserved space released
```

### Edge Case 5: Invalid Shrink (Larger than Current)

```javascript
const reservation = ringBuffer.reserve(100);
try {
  reservation.shrink(150); // Invalid: larger than current
} catch (error) {
  // RangeError: Cannot shrink to larger size
}
```

### Edge Case 6: Shrink After Commit

```javascript
const reservation = ringBuffer.reserve(100);
ringBuffer.commit(reservation);
try {
  reservation.shrink(50); // Invalid: already committed
} catch (error) {
  // Error: Cannot shrink committed reservation
}
```

### Edge Case 7: Multiple Pending Reservations

```javascript
const res1 = ringBuffer.reserve(100);
try {
  const res2 = ringBuffer.reserve(200); // Invalid: res1 still pending
} catch (error) {
  // RingBufferReservationError: 'Reservation already pending'
}

// Must commit or abandon res1 before reserving again
ringBuffer.commit(res1);
const res2 = ringBuffer.reserve(200); // Now valid
```

## Scenario 4: Performance Optimizations

### Optimization 1: Segment Caching

**Strategy**: Cache the last accessed segment to minimize segment searches during sequential access

**Implementation** (from [`src/virtual-buffer.esm.js`](../../src/virtual-buffer.esm.js)):
```javascript
// State includes segment cache
this.#state = {
  segments: [],
  length: 0,
  // Segment cache for DataView methods (getUint8/setUint8)
  cachedSegIndex: -1,
  cachedSegStart: 0,
  cachedSegEnd: 0
};

// getUint8() checks cache first
getUint8 (offset) {
  const state = this.#state;
  const segments = state.segments;

  // Check cached segment first
  if (state.cachedSegIndex >= 0 &&
      offset >= state.cachedSegStart &&
      offset < state.cachedSegEnd) {
    const seg = segments[state.cachedSegIndex];
    const segOffset = offset - state.cachedSegStart;
    return seg.buffer[seg.offset + segOffset];
  }

  // Search for segment containing offset
  let currentPos = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segEnd = currentPos + seg.length;
    
    if (offset < segEnd) {
      // Cache this segment
      state.cachedSegIndex = i;
      state.cachedSegStart = currentPos;
      state.cachedSegEnd = segEnd;
      
      const segOffset = offset - currentPos;
      return seg.buffer[seg.offset + segOffset];
    }
    currentPos = segEnd;
  }
}
```

**Benefit**: Sequential access (common pattern) hits cache on (almost) every access after first, avoiding O(n) segment search

**Example**:
```javascript
// Reading protocol header sequentially
const type = vb.getUint8(0);      // Cache miss, search segments, cache segment 0
const size = vb.getUint8(1);      // Cache hit (offset 1 in segment 0)
const flags = vb.getUint16(2);    // Cache hit (offsets 2-3 in segment 0)
const channelId = vb.getUint32(4); // Cache hit (offsets 4-7 in segment 0)
// All subsequent reads hit cache until crossing segment boundary
```

### Optimization 2: Single-Segment Fast Path

**Strategy**: Detect single-segment case and use direct buffer access (not currently implemented, but could be added)

```javascript
// VirtualBuffer.getUint8() implementation (hypothetical optimization)
getUint8 (offset) {
  if (this.segmentCount === 1) {
    // Fast path: direct access
    const seg = this.#segments[0];
    return seg.buffer[seg.start + offset];
  }
  // Slow path: use segment cache
  return this.#getUint8WithCache(offset);
}
```

**Benefit**: Avoids segment lookup overhead for common case (single contiguous buffer)

**Note**: Current implementation uses segment caching for all cases, which is nearly as fast and simpler

### Optimization 3: Cached TextEncoder/TextDecoder

**Strategy**: Reuse encoder/decoder instances

```javascript
// Module-level cache
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// VirtualRWBuffer.encodeFrom() uses cached encoder
encodeFrom (str, offset = 0, label = 'utf-8') {
  // Use cached textEncoder
  return textEncoder.encodeInto(str.slice(offset), ...);
}
```

**Benefit**: Avoids repeated encoder/decoder allocation

### Optimization 3: Zero-Copy Slice

**Strategy**: Slice creates new VirtualBuffer referencing same underlying buffers

```javascript
// VirtualBuffer.slice() implementation
slice (start = 0, end = this.length) {
  // Calculate new segment ranges (no data copy)
  const newSegments = this.#calculateSliceSegments(start, end);
  return new VirtualBuffer(newSegments);
}
```

**Benefit**: No memory allocation or copying for slices

### Optimization 4: Batch Operations

**Strategy**: Process multiple operations in single pass

```javascript
// Instead of multiple set() calls:
reservation.set(header, 0);
reservation.set(data, headerSize);

// Use single set() with combined buffer:
const combined = new Uint8Array(headerSize + dataSize);
combined.set(header, 0);
combined.set(data, headerSize);
reservation.set(combined, 0);
```

**Benefit**: Reduces segment boundary checks and function call overhead

## Integration Points

### With OutputRingBuffer

```javascript
// Ring buffer returns VirtualRWBuffer for reservations
const reservation = ringBuffer.reserve(100);
// reservation is VirtualRWBuffer (1 or 2 segments)

// Write data
reservation.encodeFrom("Hello", 0);

// Shrink if needed
reservation.shrink(actualSize);

// Commit (frees pending reservation slot)
ringBuffer.commit(reservation);

// Get buffers for I/O
const buffers = ringBuffer.getBuffers(actualSize);
// buffers is array of Uint8Array (1 or 2 if wrapped)
```

### With Protocol Layer

```javascript
// Encode protocol header
const reservation = ringBuffer.reserve(18 + dataSize);
reservation.setUint8(0, messageType);
reservation.setUint8(1, 16); // Remaining header size
reservation.setUint32(2, dataSize, false);
reservation.setUint16(6, flags, false);
reservation.setUint32(8, channelId, false);
reservation.setUint32(12, sequence, false);
reservation.setUint16(16, messageTypeId, false);

// Encode data
reservation.set(dataBytes, 18);

// Commit
ringBuffer.commit(reservation);
```

### With Channel Read Operations

```javascript
// Receive data from transport
const buffers = await transport.receive(); // Array of Uint8Array

// Create VirtualBuffer for zero-copy processing
const vb = new VirtualBuffer(buffers);

// Decode header
const messageType = vb.getUint8(0);
const dataSize = vb.getUint32(2, false);

// Slice data portion
const dataView = vb.slice(18, 18 + dataSize);

// Decode text
const text = dataView.decode();
```

## Key Takeaways

1. **Zero-Copy Philosophy**: Virtual buffers avoid intermediate copies by providing views over existing buffers
2. **Multi-Segment Support**: Transparently handles data spanning multiple non-contiguous buffers
3. **DataView Compatibility**: Standard DataView methods work across segment boundaries
4. **Streaming Text Decoding**: Correctly handles UTF-8 sequences split across segments
5. **Write-Then-Shrink Pattern**: Over-allocate for worst-case, encode, then shrink to actual size
6. **Single Pending Reservation**: Only one reservation at a time (enforced by ring buffer)
7. **Single-Segment Optimization**: Fast path for common case (no segment lookup)
8. **Immutability After Commit**: Reservations cannot be modified after commit
9. **Error Handling**: Clear errors for out-of-bounds access and invalid operations

## Related Scenarios

- [`ring-buffer-lifecycle.md`](ring-buffer-lifecycle.md) - Ring buffer operations that create VirtualRWBuffer reservations
- [`simple-write.md`](simple-write.md) - Uses VirtualRWBuffer for encoding protocol headers
- [`multi-chunk-write.md`](multi-chunk-write.md) - Uses encodeFrom() for multi-chunk string encoding
- [`simple-read.md`](simple-read.md) - Uses VirtualBuffer for decoding received data
- [`message-encoding.md`](message-encoding.md) - Protocol encoding using VirtualRWBuffer (TODO)
- [`message-decoding.md`](message-decoding.md) - Protocol decoding using VirtualBuffer (TODO)
