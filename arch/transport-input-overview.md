# Transport Input Overview

## Assumptions

- When the transport is started, it adds a task to the event loop to analyze, process, and release incoming bytes per the algorithms described below
- Depending on the transport, raw input might be "pushed" by the underlying source into the VirtualRWBuffer when data becomes available (likely handled by a separate task), or raw input might be "pulled" as part of the "ensure bytes" implementation (in the same task)

## Handshake Processing

### Objectives

- Distinguish between out-of-band data (non-transport-content, such as exception and console logging) and transport-content prior to entering byte-stream mode
- Generate `outOfBandData` events for non-transport content
- Identify transport configuration (before commencement of standard operations)
- Identify when the log channel has been established (if configured) and it's safe to switch to byte-stream mode

### Approach

- Start in a (mostly) line-based mode
  - (Without assuming that transport communications will always begin immediately after a new-line)
- Use STX and ETX marker characters to help distinguish transport-content from non-transport-content in line mode
- Use STX + transport greeting (`PolyTransport:`) + JSON config + ETX + new-line to identify transport-handshake configuration
  - (`GREET_CONFIG_PREFIX` and `GREET_CONFIG_SUFFIX` in protocol.esm.js)
- Use STX + SOH + ETX + new-line sequence to switch to byte-stream-mode
  - (`START_BYTE_STREAM` in protocol.esm.js)

### Handshake Algorithm

1. Set the read head to the beginning of the buffer (offset 0)
2. If the read head is at the end of the buffer
   - Wait for more input (ensure offset+1 bytes)
3. If the current character is STX (`[2]`) AND not at offset 0
   - Decode the line from the start of the buffer up to, but not including, the STX
   - Release the bytes just decoded
   - Set the read head back to offset 0
   - Emit a transport `outOfBandData` event for the line
   - Go back to step 2
4. If the current character is a new-line (`[10]`)
   - Decode the line from the start of the buffer up to and including the new-line
   - Release the bytes just decoded
   - Set the read head back to offset 0
   - If the decoded line matches the byte-stream-mode sequence exactly (correct length and content)
     - Line/handshake mode ends and byte-stream/operational mode begins
     - (Switch to byte-stream message processing)
   - If the decoded line begins with the transport greeting, and\
  the decoded line ends with ETX (`[3]`), and\
  it's the first one
     - Decode and process the JSON configuration
   - Otherwise, emit a transport `outOfBandData` event for the line
   - Go back to step 2
5. Advance the read head and go to step 2

## Byte-Stream Message Processing

### Byte-Stream Message Algorithm

1. Ensure at least 2 bytes
2. Fetch header-type and encoded remaining-header-size bytes
3. Ensure total-header-size bytes
4. Decode header and construct header object
5. Release header bytes
6. If dataSize > 0
   - Ensure dataSize bytes
   - Copy data to pool
   - Release dataSize bytes
7. Pass header object, with data buffer(s), when present, to channel for processing
8. Go back to step 1
