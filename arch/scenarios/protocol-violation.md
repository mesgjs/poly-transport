# Protocol Violation Scenario

## Overview

This scenario documents how PolyTransport detects and handles protocol violations - situations where the remote transport violates the PolyTransport protocol rules. Protocol violations are **events** (not exceptions) because they're triggered by external traffic, not local requests. The transport emits `protocolViolation` events, and the application decides how to handle them (close channel, close transport, log and ignore, etc.).

**Key Principle**: Protocol violations are detected by ChannelFlowControl and Channel, but handled by Transport event handlers. This separation allows applications to implement custom policies for different violation types and deployment scenarios.

## Preconditions

- Transport is started and operational
- Channel is open (or was open - closed channels remain tracked)
- Remote transport sends data that violates protocol rules

## Actors

- **ChannelFlowControl**: Detects violations (sequence order, budget, ACK validation)
- **Channel**: Catches violations, emits events on transport
- **Transport**: Emits `protocolViolation` events, provides default handling
- **Application**: Listens for events, decides action (close, log, ignore)

## Protocol Violation Types

### 1. Out-of-Order Sequence

**Condition**: Received sequence number is not consecutive (`seq !== nextExpectedSeq`)

**Detection**: [`ChannelFlowControl.recordReceived(seq, chunkBytes)`](../../src/channel-flow-control.esm.js:288)

**Error**: `ProtocolViolationError('Sequence out of order', { expected, received })`

**Rationale**: PolyTransport assumes reliable, ordered transport (TCP, WebSocket). Out-of-order chunks indicate transport failure or malicious behavior.

**Example**:
```javascript
// Expected seq 5, received seq 7 (missing seq 6)
throw new ProtocolViolationError('Sequence out of order', {
  expected: 5,
  received: 7
});
```

### 2. Over-Budget Chunk

**Condition**: Chunk size exceeds available buffer (`chunkBytes > bufferAvailable`)

**Detection**: [`ChannelFlowControl.recordReceived(seq, chunkBytes)`](../../src/channel-flow-control.esm.js:288)

**Error**: `ProtocolViolationError('Over budget', { available, requested })`

**Rationale**: Sender should respect receiver's budget (from ACKs). Over-budget indicates sender bug or malicious behavior.

**Example**:
```javascript
// Available buffer 1000 bytes, received chunk 1500 bytes
throw new ProtocolViolationError('Over budget', {
  available: 1000,
  requested: 1500
});
```

### 3. Duplicate ACK

**Condition**: ACK for sequence that was already ACK'd

**Detection**: [`ChannelFlowControl.processAck(baseSeq, ranges)`](../../src/channel-flow-control.esm.js:157)

**Error**: `ProtocolViolationError('Duplicate ACK', { sequence, reason })`

**Rationale**: Duplicate ACKs indicate sender bug or malicious behavior. Could cause incorrect budget calculations.

**Example**:
```javascript
// Sequence 5 already ACK'd, received ACK for 5 again
throw new ProtocolViolationError('Duplicate ACK', {
  sequence: 5,
  reason: 'Sequence already acknowledged'
});
```

### 4. Premature ACK

**Condition**: ACK for sequence that hasn't been sent yet (`seq >= nextSendSeq`)

**Detection**: [`ChannelFlowControl.processAck(baseSeq, ranges)`](../../src/channel-flow-control.esm.js:157)

**Error**: `ProtocolViolationError('PrematureAck', { sequence, nextSendSeq, reason })`

**Rationale**: ACKing unsent sequences indicates sender bug or malicious behavior. Could cause incorrect budget calculations.

**Example**:
```javascript
// Next send seq is 10, received ACK for seq 15
throw new ProtocolViolationError('PrematureAck', {
  sequence: 15,
  nextSendSeq: 10,
  reason: 'ACK beyond assigned sequence'
});
```

### 5. Unknown Channel

**Condition**: Message for channel ID that doesn't exist

**Detection**: Transport (when routing incoming message)

**Error**: Transport emits `protocolViolation` event directly (no exception)

**Rationale**: Unknown channel indicates sender bug or malicious behavior. Even closed channels are tracked for transport lifetime.

**Example**:
```javascript
// Channel 99 doesn't exist
transport.dispatchEvent('protocolViolation', {
  reason: 'Unknown channel',
  channelId: 99,
  seq: 1
});
```

## Step-by-Step Sequence

### Scenario 1: Out-of-Order Sequence

#### Step 1: Transport receives chunk

**Actor**: Transport

**Action**: Receives data from underlying transport (WebSocket, pipe, etc.)

**Details**:
- Read bytes from transport
- Parse header to determine type (type 2 = channel data message)
- Extract channel ID, sequence number, data

#### Step 2: Transport routes to channel

**Actor**: Transport

**Action**: Looks up channel by channel ID

**Details**:
- Look up channel in transport's channel map
- If channel not found, emit `protocolViolation` event (unknown channel)
- If channel found, call [`channel._handleIncomingChunk(header, dataVB)`](../../src/channel.esm.js)

#### Step 3: Channel validates sequence

**Actor**: Channel

**Action**: Calls [`flowControl.recordReceived(seq, chunkBytes)`](../../src/channel-flow-control.esm.js:288)

**Details**:
- ChannelFlowControl validates sequence order
- If `seq !== nextExpectedSeq`, throws `ProtocolViolationError('Sequence out of order')`

#### Step 4: Channel catches violation

**Actor**: Channel

**Action**: Catches `ProtocolViolationError` from `recordReceived()`

**Details**:
```javascript
try {
  flowControl.recordReceived(seq, chunkBytes);
} catch (err) {
  if (err instanceof ProtocolViolationError) {
    // Emit event on transport
    this.#transport.dispatchEvent('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: this.id
    });
    return; // Don't process chunk
  }
  throw err; // Re-throw other errors
}
```

#### Step 5: Transport emits event

**Actor**: Transport

**Action**: Emits `protocolViolation` event

**Details**:
- Event type: `'protocolViolation'`
- Event detail: `{ reason: 'Sequence out of order', details: { expected, received }, channelId }`
- Event handlers invoked (application-defined)

#### Step 6: Application handles violation

**Actor**: Application (event handler)

**Action**: Decides how to handle violation

**Options**:
1. **Close transport**: `transport.stop({ discard: true })`
2. **Close channel**: `channel.close({ discard: true })`
3. **Log and ignore**: `console.warn('Protocol violation:', event.detail)`
4. **Custom action**: Application-specific logic

**Example**:
```javascript
transport.addEventListener('protocolViolation', (event) => {
  const { reason, details, channelId } = event.detail;
  
  if (reason === 'Sequence out of order') {
    // Out-of-order is serious - close transport
    console.error('Out-of-order sequence:', details);
    transport.stop({ discard: true });
  } else if (reason === 'Over budget') {
    // Over-budget is serious - close transport
    console.error('Over-budget chunk:', details);
    transport.stop({ discard: true });
  } else {
    // Other violations - log and continue
    console.warn('Protocol violation:', reason, details);
  }
});
```

### Scenario 2: Over-Budget Chunk

**Steps 1-6**: Same as Scenario 1, except:
- **Step 3**: ChannelFlowControl validates budget instead of sequence
- **Step 4**: Catches `ProtocolViolationError('Over budget')`
- **Step 5**: Emits event with `reason: 'Over budget'`

### Scenario 3: Duplicate ACK

#### Step 1: Transport receives ACK

**Actor**: Transport

**Action**: Receives ACK message from remote transport

**Details**:
- Read bytes from transport
- Parse header to determine type (type 0 = ACK)
- Decode ACK: [`Protocol.decodeAckHeaderFrom(buffer, offset)`](../../src/protocol.esm.js:273)
- Extract: `{ channelId, baseSeq, ranges }`

#### Step 2: Transport routes to channel

**Actor**: Transport

**Action**: Looks up channel by channel ID

**Details**:
- Look up channel in transport's channel map
- If channel not found, emit `protocolViolation` event (unknown channel)
- If channel found, proceed to Step 3

#### Step 3: Channel processes ACK

**Actor**: Channel

**Action**: Calls [`flowControl.processAck(baseSeq, ranges)`](../../src/channel-flow-control.esm.js:157)

**Details**:
- ChannelFlowControl validates ACK sequences
- If sequence already ACK'd, throws `ProtocolViolationError('Duplicate ACK')`

#### Step 4: Channel catches violation

**Actor**: Channel

**Action**: Catches `ProtocolViolationError` from `processAck()`

**Details**:
```javascript
try {
  const bytesFreed = flowControl.processAck(baseSeq, ranges);
  // ... restore transport budget
} catch (err) {
  if (err instanceof ProtocolViolationError) {
    // Emit event on transport
    this.#transport.dispatchEvent('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: this.id
    });
    return; // Don't process ACK
  }
  throw err; // Re-throw other errors
}
```

#### Step 5: Transport emits event

**Actor**: Transport

**Action**: Emits `protocolViolation` event

**Details**:
- Event type: `'protocolViolation'`
- Event detail: `{ reason: 'Duplicate ACK', details: { sequence, reason }, channelId }`
- Event handlers invoked (application-defined)

#### Step 6: Application handles violation

**Actor**: Application (event handler)

**Action**: Decides how to handle violation (same as Scenario 1)

### Scenario 4: Premature ACK

**Steps 1-6**: Same as Scenario 3, except:
- **Step 3**: ChannelFlowControl validates ACK is not beyond assigned
- **Step 4**: Catches `ProtocolViolationError('PrematureAck')`
- **Step 5**: Emits event with `reason: 'PrematureAck'`

### Scenario 5: Unknown Channel

#### Step 1: Transport receives message

**Actor**: Transport

**Action**: Receives data from underlying transport

**Details**:
- Read bytes from transport
- Parse header to determine type (type 0/1/2)
- Extract channel ID

#### Step 2: Transport looks up channel

**Actor**: Transport

**Action**: Looks up channel by channel ID

**Details**:
- Look up channel in transport's channel map
- Channel not found (doesn't exist or was never created)

#### Step 3: Transport emits event

**Actor**: Transport

**Action**: Emits `protocolViolation` event directly (no exception)

**Details**:
```javascript
const channel = this.#channels.get(channelId);
if (!channel) {
  this.dispatchEvent('protocolViolation', {
    reason: 'Unknown channel',
    channelId,
    seq: header.seq || null
  });
  return; // Don't process message
}
```

#### Step 4: Application handles violation

**Actor**: Application (event handler)

**Action**: Decides how to handle violation (same as Scenario 1)

**Note**: Unknown channel is serious - typically indicates malicious behavior or severe bug. Most applications will close transport.

## Postconditions

### After Violation Detection

- `ProtocolViolationError` thrown (or event emitted directly)
- Violating message not processed (discarded)
- Channel state unchanged (no budget consumed, no sequence incremented)

### After Event Emission

- `protocolViolation` event emitted on transport
- Event handlers invoked (application-defined)
- Application decides action (close, log, ignore)

### After Application Handling

- Transport may be closed (if handler decides)
- Channel may be closed (if handler decides)
- Or violation logged and ignored (if handler decides)

## Error Conditions

### No Event Handler

**Condition**: No `protocolViolation` event handler registered

**Handling**:
- Event emitted but no handler invoked
- Violation logged to console (if default handler exists)
- Transport continues operating (no automatic closure)

**Recommendation**: Always register a `protocolViolation` handler to detect and handle violations.

### Handler Throws Exception

**Condition**: Event handler throws exception

**Handling**:
- Exception propagates to event dispatcher
- Transport may close depending on exception type
- Other handlers may not be invoked (depends on event system)

**Recommendation**: Event handlers should catch and log exceptions, not throw them.

## Related Scenarios

- **[`send-flow-control.md`](send-flow-control.md)** - Sending with budget validation
- **[`receive-flow-control.md`](receive-flow-control.md)** - Receiving with sequence/budget validation
- **[`ack-generation-processing.md`](ack-generation-processing.md)** - ACK processing with validation
- **[`simple-read.md`](simple-read.md)** - Reading with protocol violation handling
- **[`streaming-read.md`](streaming-read.md)** - Multi-chunk reading with protocol violation handling

## Implementation Notes

### 1. Events vs Exceptions

**Critical**: Protocol violations are **events** (not exceptions) because they're triggered by external traffic.

**Rationale**:
- Violations are not local errors (not caused by application code)
- Application should decide policy (close, log, ignore)
- Prevents uncaught exceptions from crashing application
- Allows different policies for different violation types

**Implementation**:
```javascript
// ChannelFlowControl throws exception
throw new ProtocolViolationError('Sequence out of order', { expected, received });

// Channel catches and emits event
try {
  flowControl.recordReceived(seq, chunkBytes);
} catch (err) {
  if (err instanceof ProtocolViolationError) {
    this.#transport.dispatchEvent('protocolViolation', {
      reason: err.reason,
      details: err.details,
      channelId: this.id
    });
    return;
  }
  throw err;
}
```

### 2. ProtocolViolationError Structure

**Critical**: Error includes `reason` and `details` for event emission.

**Structure**:
```javascript
class ProtocolViolationError extends Error {
  constructor(reason, details) {
    super(`Protocol violation: ${reason}`);
    this.name = 'ProtocolViolationError';
    this.reason = reason;  // 'Sequence out of order' | 'Over budget' | 'Duplicate ACK' | 'PrematureAck'
    this.details = details; // Additional context
  }
}
```

**Reason Values**:
- `'Sequence out of order'`: Sequence not consecutive
- `'Over budget'`: Chunk exceeds available buffer
- `'Duplicate ACK'`: Sequence already ACK'd
- `'PrematureAck'`: ACK beyond assigned sequence
- `'Unknown channel'`: Channel doesn't exist

### 3. Event Detail Format

**Critical**: Event detail includes `reason`, `details`, and `channelId`.

**Format**:
```javascript
{
  reason: string,      // Violation type
  details: object,     // Additional context
  channelId: number    // Channel ID (if applicable)
}
```

**Examples**:
```javascript
// Out-of-order
{ reason: 'Sequence out of order', details: { expected: 5, received: 7 }, channelId: 42 }

// Over-budget
{ reason: 'Over budget', details: { available: 1000, requested: 1500 }, channelId: 42 }

// Duplicate ACK
{ reason: 'Duplicate ACK', details: { sequence: 5, reason: 'Sequence already acknowledged' }, channelId: 42 }

// Premature ACK
{ reason: 'PrematureAck', details: { sequence: 15, nextSendSeq: 10, reason: 'ACK beyond assigned sequence' }, channelId: 42 }

// Unknown channel
{ reason: 'Unknown channel', channelId: 99, seq: 1 }
```

### 4. Default Handling Policy

**Critical**: No default action - application must decide policy.

**Rationale**:
- Different deployments have different requirements
- Some violations are more serious than others
- Application knows context (trusted vs untrusted remote)

**Recommendation**:
- **Out-of-order**: Close transport (serious - indicates transport failure)
- **Over-budget**: Close transport (serious - indicates sender bug or malicious behavior)
- **Duplicate ACK**: Log and continue (may be benign - network duplication)
- **Premature ACK**: Close transport (serious - indicates sender bug or malicious behavior)
- **Unknown channel**: Close transport (serious - indicates malicious behavior or severe bug)

### 5. Violation Detection Points

**Critical**: Violations detected at multiple points in the flow.

**Detection Points**:
1. **ChannelFlowControl.recordReceived()**: Out-of-order, over-budget
2. **ChannelFlowControl.processAck()**: Duplicate ACK, premature ACK
3. **Transport (routing)**: Unknown channel

**Rationale**: Each component validates its own invariants. Separation of concerns.

### 6. Channel State After Violation

**Critical**: Channel state unchanged after violation (no side effects).

**Rationale**:
- Violating message not processed (discarded)
- No budget consumed, no sequence incremented
- Channel remains in consistent state
- Application can decide whether to close channel

**Implementation**:
```javascript
try {
  flowControl.recordReceived(seq, chunkBytes);
  // ... process chunk
} catch (err) {
  if (err instanceof ProtocolViolationError) {
    // Emit event, return early (no state changes)
    this.#transport.dispatchEvent('protocolViolation', { ... });
    return;
  }
  throw err;
}
```

### 7. Closed Channel Tracking

**Critical**: Even closed channels are tracked for transport lifetime.

**Rationale**:
- Prevents "unknown channel" violations for recently-closed channels
- Allows graceful handling of in-flight messages
- Simplifies implementation (no need to track "recently closed" separately)

**Implementation**:
- Channels remain in transport's channel map after close
- Channel state set to `'closed'`
- Messages for closed channels are discarded (not violations)

### 8. Testing Strategy

**Critical**: Test all violation types and handling policies.

**Test Cases**:
1. Out-of-order sequence (expected 5, received 7)
2. Over-budget chunk (available 1000, requested 1500)
3. Duplicate ACK (sequence 5 already ACK'd)
4. Premature ACK (ACK for sequence 15, next send seq 10)
5. Unknown channel (channel 99 doesn't exist)
6. Event handler closes transport
7. Event handler closes channel
8. Event handler logs and ignores
9. No event handler (violation logged to console)
10. Handler throws exception (exception propagates)

## API Reference

### ProtocolViolationError

```javascript
class ProtocolViolationError extends Error {
  constructor(reason, details)
  
  reason: string      // 'Sequence out of order' | 'Over budget' | 'Duplicate ACK' | 'PrematureAck'
  details: object     // Additional context
}
```

### Transport Event

```javascript
transport.addEventListener('protocolViolation', (event) => {
  const { reason, details, channelId } = event.detail;
  
  // Decide action based on reason
  if (reason === 'Sequence out of order' || reason === 'Over budget') {
    transport.stop({ discard: true });
  } else {
    console.warn('Protocol violation:', reason, details);
  }
});
```

### ChannelFlowControl Methods

```javascript
class ChannelFlowControl {
  // Throws ProtocolViolationError if validation fails
  recordReceived(seq, chunkBytes)  // Validates sequence order and budget
  processAck(baseSeq, ranges)      // Validates ACK sequences
}
```

## Statistics

Protocol violations can be tracked via transport statistics:

```javascript
{
  protocolViolations: {
    seqOutOfOrder: number,      // Count of out-of-order violations
    overBudget: number,      // Count of over-budget violations
    duplicateAck: number,    // Count of duplicate ACK violations
    prematureAck: number,    // Count of premature ACK violations
    unknownChannel: number   // Count of unknown channel violations
  }
}
```

## Security Considerations

### 1. Malicious Remote

**Threat**: Remote transport intentionally violates protocol to disrupt service.

**Mitigation**:
- Detect violations immediately (no processing of violating messages)
- Emit events for monitoring and alerting
- Close transport on serious violations (out-of-order, over-budget, premature ACK)
- Rate-limit violations (close transport after N violations in M seconds)

### 2. Buggy Remote

**Threat**: Remote transport has bugs that cause protocol violations.

**Mitigation**:
- Same as malicious remote (can't distinguish intent)
- Log violations for debugging
- Close transport to prevent further issues

### 3. Network Issues

**Threat**: Network issues cause message corruption or duplication.

**Mitigation**:
- Reliable transport (TCP, WebSocket) prevents most issues
- Duplicate ACKs may be benign (network duplication)
- Application decides policy (log and continue vs close)

### 4. Denial of Service

**Threat**: Remote floods with violating messages to exhaust resources.

**Mitigation**:
- Close transport immediately on serious violations
- Rate-limit violations (close after N violations)
- Don't process violating messages (discard immediately)
- Monitor violation rates for alerting
