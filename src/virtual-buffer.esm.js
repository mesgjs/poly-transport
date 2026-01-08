/**
 * VirtualBuffer - Zero-copy buffer management with views into underlying storage
 * 
 * Wraps Uint8Array or ring buffer segments to support slicing without copying.
 * Includes pin/unpin mechanism for ring buffer integration.
 *
 * @copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

// File-scoped WeakMap for secure private state storage
const privateState = new WeakMap();

export class VirtualBuffer {
	#state;

	/**
	 * Create a VirtualBuffer from one or more sources
	 * @param {Uint8Array|Array<{buffer: Uint8Array, offset: number, length: number}>} source
	 * @param {number} offset - Starting offset (only used if source is Uint8Array)
	 * @param {number} length - Length (only used if source is Uint8Array)
	 */
	constructor (source, offset = 0, length = undefined) {
		this.#state = {
			segments: [],
			length: 0,
			// Segment cache for DataView methods (getUint8/setUint8)
			cachedSegIndex: -1,
			cachedSegStart: 0,
			cachedSegEnd: 0
		};
		privateState.set(this, this.#state);

		if (source !== undefined) {
			this.append(source, offset, length);
		}
	}

	/**
	 * Append data to this virtual buffer
	 * @param {Uint8Array|VirtualBuffer|Array<{buffer: Uint8Array, offset: number, length: number}>} source
	 * @param {number} offset - Starting offset (only used if source is Uint8Array)
	 * @param {number} length - Length (only used if source is Uint8Array)
	 */
	append (source, offset = 0, length = undefined) {
		const state = this.#state;

		if (Array.isArray(source)) {
			// Already segmented
			for (const seg of source) {
				state.segments.push(seg);
				state.length += seg.length;
			}
		} else if (source instanceof VirtualBuffer) {
			// VirtualBuffer - copy segments
			const sourceState = privateState.get(source);
			for (const seg of sourceState.segments) {
				state.segments.push({ ...seg });
				state.length += seg.length;
			}
		} else if (source instanceof Uint8Array) {
			// Single Uint8Array
			const actualLength = length !== undefined ? length : source.length - offset;
			if (actualLength > 0) {
				state.segments.push({
					buffer: source,
					offset: offset,
					length: actualLength
				});
				state.length += actualLength;
			}
		} else {
			throw new TypeError('Source must be Uint8Array, VirtualBuffer, or array of segments');
		}
	}

	/**
	 * Get the total length of the virtual buffer
	 */
	get length () {
		return this.#state.length;
	}

	/**
	 * Get the byte length (alias for length)
	 */
	get byteLength () {
		return this.#state.length;
	}

	/**
	 * Get the number of segments
	 */
	get segmentCount () {
		return this.#state.segments.length;
	}

	/**
	 * Create a slice of this virtual buffer
	 * @param {number} start - Starting position (default 0)
	 * @param {number} end - Ending position (default length)
	 * @returns {VirtualBuffer}
	 */
	slice (start = 0, end = this.length) {
		const state = this.#state;
		// Normalize negative indices
		if (start < 0) start = Math.max(0, state.length + start);
		if (end < 0) end = Math.max(0, state.length + end);

		// Clamp to valid range
		start = Math.max(0, Math.min(start, state.length));
		end = Math.max(start, Math.min(end, state.length));

		const sliceLength = end - start;
		if (sliceLength === 0) {
			return new VirtualBuffer();
		}

		// Find segments that overlap with [start, end)
		const segments = state.segments;
		const newSegments = [];
		let currentPos = 0;

		for (const seg of segments) {
			const segStart = currentPos;
			const segEnd = currentPos + seg.length;

			if (segEnd <= start) {
				// Segment is entirely before slice
				currentPos = segEnd;
				continue;
			}

			if (segStart >= end) {
				// Segment is entirely after slice
				break;
			}

			// Segment overlaps with slice
			const overlapStart = Math.max(0, start - segStart);
			const overlapEnd = Math.min(seg.length, end - segStart);
			const overlapLength = overlapEnd - overlapStart;

			newSegments.push({
				buffer: seg.buffer,
				offset: seg.offset + overlapStart,
				length: overlapLength
			});

			currentPos = segEnd;
		}

		return new VirtualBuffer(newSegments);
	}

	/**
	 * Convert to a contiguous Uint8Array (always copies for security)
	 * @param {Uint8Array} buffer - Optional destination buffer (must be at least this.length bytes)
	 * @returns {Uint8Array} The destination buffer (or new buffer if not provided)
	 */
	toUint8Array (buffer = null) {
		const state = this.#state;
		const segments = state.segments;

		if (segments.length === 0) {
			return buffer || new Uint8Array(0);
		}

		// Validate provided buffer
		if (buffer !== null) {
			if (!(buffer instanceof Uint8Array)) {
				throw new TypeError('Buffer must be a Uint8Array');
			}
			if (buffer.length < state.length) {
				throw new RangeError(`Buffer too small: need ${state.length} bytes, got ${buffer.length}`);
			}
		}

		// Use provided buffer or allocate new one
		const result = buffer || new Uint8Array(state.length);
		let destOffset = 0;

		for (const seg of segments) {
			const view = seg.buffer.subarray(seg.offset, seg.offset + seg.length);
			result.set(view, destOffset);
			destOffset += seg.length;
		}

		return result;
	}

	/**
	 * Concatenate this buffer with another
	 * @param {VirtualBuffer} other
	 * @returns {VirtualBuffer}
	 */
	concat (other) {
		if (!(other instanceof VirtualBuffer)) {
			throw new TypeError('Can only concat with another VirtualBuffer');
		}

		const thisState = this.#state;
		const otherState = other.#state;

		// Create a deep copy of segments to avoid sharing references
		const newSegments = [
			...thisState.segments.map(seg => ({ ...seg })),
			...otherState.segments.map(seg => ({ ...seg }))
		];
		return new VirtualBuffer(newSegments);
	}

	/**
	 * Decode text from this buffer
	 * @param {Object} options
	 * @param {number} options.start - Start position (default 0)
	 * @param {number} options.end - End position (default length)
	 * @param {string} options.label - Encoding label (default 'utf-8')
	 * @param {boolean} options.fatal - Throw on decode errors (default false)
	 * @param {boolean} options.ignoreBOM - Ignore byte order mark (default false)
	 * @returns {string}
	 */
	decode ({ start = 0, end = this.length, label = 'utf-8', fatal = false, ignoreBOM = false } = {}) {
		const state = this.#state;
		// Normalize range
		if (start < 0) start = Math.max(0, state.length + start);
		if (end < 0) end = Math.max(0, state.length + end);
		start = Math.max(0, Math.min(start, state.length));
		end = Math.max(start, Math.min(end, state.length));

		if (start === end) {
			return '';
		}

		// Get the slice to decode
		const slice = (start === 0 && end === state.length) ? this : this.slice(start, end);
		const segments = privateState.get(slice).segments;

		// Single-segment optimization: zero-copy decode
		if (segments.length === 1) {
			const seg = segments[0];
			const view = seg.buffer.subarray(seg.offset, seg.offset + seg.length);
			const decoder = new TextDecoder(label, { fatal, ignoreBOM });
			return decoder.decode(view);
		}

		// Multi-segment: use streaming decoder
		const decoder = new TextDecoder(label, { fatal, ignoreBOM });
		const parts = [];

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const view = seg.buffer.subarray(seg.offset, seg.offset + seg.length);
			const isLast = (i === segments.length - 1);
			
			// Use stream: true for all but the last segment
			parts.push(decoder.decode(view, { stream: !isLast }));
		}

		return parts.join('');
	}

	/**
	 * Read an unsigned 8-bit integer at the specified offset
	 * @param {number} offset - Byte offset
	 * @returns {number} Value (0-255)
	 */
	getUint8 (offset) {
		const state = this.#state;
		if (offset < 0 || offset >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range [0, ${state.length})`);
		}

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

		throw new Error('Internal error: offset not found in segments');
	}

	/**
	 * Read an unsigned 16-bit integer (big-endian) at the specified offset
	 * @param {number} offset - Byte offset
	 * @returns {number} Value (0-65535)
	 */
	getUint16 (offset) {
		const state = this.#state;
		if (offset < 0 || offset + 1 >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range for Uint16`);
		}

		const byte0 = this.getUint8(offset);
		const byte1 = this.getUint8(offset + 1);
		return (byte0 << 8) | byte1;
	}

	/**
	 * Read an unsigned 32-bit integer (big-endian) at the specified offset
	 * @param {number} offset - Byte offset
	 * @returns {number} Value (0-4294967295)
	 */
	getUint32 (offset) {
		const state = this.#state;
		if (offset < 0 || offset + 3 >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range for Uint32`);
		}

		const byte0 = this.getUint8(offset);
		const byte1 = this.getUint8(offset + 1);
		const byte2 = this.getUint8(offset + 2);
		const byte3 = this.getUint8(offset + 3);
		return ((byte0 << 24) | (byte1 << 16) | (byte2 << 8) | byte3) >>> 0;
	}
}

/**
 * VirtualRWBuffer - Read/write subclass of VirtualBuffer for zero-copy writing
 *
 * Extends VirtualBuffer with write operations to support writing directly to
 * ring buffers (potentially split around wrap-around).
 *
 * Security: Can only be constructed from Uint8Array or VirtualRWBuffer to prevent
 * privilege escalation (granting write access to read-only data).
 */
export class VirtualRWBuffer extends VirtualBuffer {
	#state;

	constructor (...args) {
		super(...args);
		this.#state = privateState.get(this);
	}

	/**
	 * Append data to this virtual buffer (overrides parent to enforce security)
	 * @param {Uint8Array|VirtualRWBuffer|Array<{buffer: Uint8Array, offset: number, length: number}>} source
	 * @param {number} offset - Starting offset (only used if source is Uint8Array)
	 * @param {number} length - Length (only used if source is Uint8Array)
	 */
	append (source, offset = 0, length = undefined) {
		// Security: Only allow VirtualRWBuffer, not base VirtualBuffer
		if (source instanceof VirtualBuffer && !(source instanceof VirtualRWBuffer)) {
			throw new TypeError('VirtualRWBuffer can only append from Uint8Array, VirtualRWBuffer, or array of segments');
		}
		super.append(source, offset, length);
	}

	/**
	 * Write bytes from source into this buffer
	 * @param {Uint8Array|VirtualRWBuffer} source - Data to write
	 * @param {number} offset - Offset in this buffer to start writing (default 0)
	 * @returns {number} Number of bytes written
	 */
	set (source, offset = 0) {
		const state = this.#state;
		if (offset < 0 || offset >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range [0, ${state.length})`);
		}

		// Security: Only accept Uint8Array or VirtualRWBuffer
		let sourceData;
		if (source instanceof VirtualRWBuffer) {
			sourceData = source.toUint8Array();
		} else if (source instanceof Uint8Array) {
			sourceData = source;
		} else {
			throw new TypeError('Source must be Uint8Array or VirtualRWBuffer');
		}

		const bytesToWrite = Math.min(sourceData.length, state.length - offset);
		if (bytesToWrite === 0) {
			return 0;
		}

		// Get segments and write data
		const segments = state.segments;
		let sourceOffset = 0;
		let remainingOffset = offset;
		let remainingBytes = bytesToWrite;

		for (const seg of segments) {
			if (remainingOffset >= seg.length) {
				// Skip this segment
				remainingOffset -= seg.length;
				continue;
			}

			// Calculate how much to write to this segment
			const segWriteStart = seg.offset + remainingOffset;
			const segAvailable = seg.length - remainingOffset;
			const segWriteLength = Math.min(segAvailable, remainingBytes);

			// Write to this segment
			seg.buffer.set(
				sourceData.subarray(sourceOffset, sourceOffset + segWriteLength),
				segWriteStart
			);

			sourceOffset += segWriteLength;
			remainingBytes -= segWriteLength;
			remainingOffset = 0;

			if (remainingBytes === 0) {
				break;
			}
		}

		return bytesToWrite;
	}

	/**
	 * Fill this buffer with a repeated byte value
	 * @param {number} value - Byte value to fill (0-255; default 0)
	 * @param {number} start - Start position (default 0)
	 * @param {number} end - End position (default length)
	 * @returns {VirtualRWBuffer} This buffer for chaining
	 */
	fill (value = 0, start = 0, end = this.length) {
		const state = this.#state;
		// Normalize range
		if (start < 0) start = Math.max(0, state.length + start);
		if (end < 0) end = Math.max(0, state.length + end);
		start = Math.max(0, Math.min(start, state.length));
		end = Math.max(start, Math.min(end, state.length));

		if (start === end) {
			return this;
		}

		// Fill segments
		const segments = state.segments;
		let currentPos = 0;

		for (const seg of segments) {
			const segStart = currentPos;
			const segEnd = currentPos + seg.length;

			if (segEnd <= start) {
				// Segment is entirely before fill range
				currentPos = segEnd;
				continue;
			}

			if (segStart >= end) {
				// Segment is entirely after fill range
				break;
			}

			// Segment overlaps with fill range
			const fillStart = Math.max(0, start - segStart);
			const fillEnd = Math.min(seg.length, end - segStart);

			seg.buffer.fill(value, seg.offset + fillStart, seg.offset + fillEnd);

			currentPos = segEnd;
		}

		return this;
	}

	/**
	 * Encode string directly into this buffer
	 * @param {string} str - String to encode
	 * @param {number} offset - Offset in this buffer to start writing (default 0)
	 * @param {string} label - Encoding label (default 'utf-8')
	 * @returns {{read: number, written: number}} UTF-16 code units read and bytes written
	 */
	encodeFrom (str, offset = 0, label = 'utf-8') {
		const state = this.#state;
		if (offset < 0 || offset >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range [0, ${this.length})`);
		}

		if (label !== 'utf-8') {
			throw new Error('Only utf-8 encoding is currently supported');
		}

		const encoder = new TextEncoder();
		const segments = state.segments;
		
		let totalRead = 0;
		let totalWritten = 0;
		let remainingOffset = offset;
		let strOffset = 0;

		for (const seg of segments) {
			if (remainingOffset >= seg.length) {
				// Skip this segment
				remainingOffset -= seg.length;
				continue;
			}

			// Calculate available space in this segment
			const segWriteStart = seg.offset + remainingOffset;
			const segAvailable = seg.length - remainingOffset;

			if (segAvailable === 0 || strOffset >= str.length) {
				break;
			}

			// Create a view for this segment's available space
			const targetView = new Uint8Array(
				seg.buffer.buffer,
				seg.buffer.byteOffset + segWriteStart,
				segAvailable
			);

			// Encode as much as fits
			const result = encoder.encodeInto(str.slice(strOffset), targetView);
			
			totalRead += result.read;
			totalWritten += result.written;
			strOffset += result.read;
			remainingOffset = 0;

			if (strOffset >= str.length) {
				break;
			}
		}

		return { read: totalRead, written: totalWritten };
	}

	/**
	 * Shrink this buffer to a new length (releases over-allocated space)
	 * @param {number} newLength - New length (must be <= current length)
	 */
	shrink (newLength) {
		const state = this.#state;
		if (newLength < 0 || newLength > state.length) {
			throw new RangeError(`New length ${newLength} is out of range [0, ${state.length}]`);
		}

		if (newLength === state.length) {
			return;
		}

		// If this is a ring reservation, notify the ring buffer
		if (this._ringReservation && this._ringReservation.ring) {
			this._ringReservation.ring.shrinkReservation(this, newLength);
		}

		// Adjust segments to match new length
		let currentPos = 0;
		const newSegments = [];

		for (const seg of state.segments) {
			const segStart = currentPos;
			const segEnd = currentPos + seg.length;

			if (segStart >= newLength) {
				// This segment is entirely beyond new length
				break;
			}

			if (segEnd <= newLength) {
				// This segment is entirely within new length
				newSegments.push(seg);
				currentPos = segEnd;
			} else {
				// This segment is partially within new length
				const truncatedLength = newLength - segStart;
				newSegments.push({
					buffer: seg.buffer,
					offset: seg.offset,
					length: truncatedLength
				});
				break;
			}
		}

		// Replace segments
		state.segments = newSegments;
		state.length = newLength;

		// Invalidate segment cache
		state.cachedSegIndex = -1;
	}

	/**
	 * Write an unsigned 8-bit integer at the specified offset
	 * @param {number} offset - Byte offset
	 * @param {number} value - Value to write (0-255)
	 */
	setUint8 (offset, value) {
		const state = this.#state;
		if (offset < 0 || offset >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range [0, ${state.length})`);
		}

		if (value < 0 || value > 255) {
			throw new RangeError(`Value ${value} is out of range [0, 255]`);
		}

		const segments = state.segments;

		// Check cached segment first
		if (state.cachedSegIndex >= 0 &&
		    offset >= state.cachedSegStart &&
		    offset < state.cachedSegEnd) {
			const seg = segments[state.cachedSegIndex];
			const segOffset = offset - state.cachedSegStart;
			seg.buffer[seg.offset + segOffset] = value;
			return;
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
				seg.buffer[seg.offset + segOffset] = value;
				return;
			}
			currentPos = segEnd;
		}

		throw new Error('Internal error: offset not found in segments');
	}

	/**
	 * Write an unsigned 16-bit integer (big-endian) at the specified offset
	 * @param {number} offset - Byte offset
	 * @param {number} value - Value to write (0-65535)
	 */
	setUint16 (offset, value) {
		const state = this.#state;
		if (offset < 0 || offset + 1 >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range for Uint16`);
		}

		if (value < 0 || value > 65535) {
			throw new RangeError(`Value ${value} is out of range [0, 65535]`);
		}

		this.setUint8(offset, (value >> 8) & 0xFF);
		this.setUint8(offset + 1, value & 0xFF);
	}

	/**
	 * Write an unsigned 32-bit integer (big-endian) at the specified offset
	 * @param {number} offset - Byte offset
	 * @param {number} value - Value to write (0-4294967295)
	 */
	setUint32 (offset, value) {
		const state = this.#state;
		if (offset < 0 || offset + 3 >= state.length) {
			throw new RangeError(`Offset ${offset} is out of range for Uint32`);
		}

		if (value < 0 || value > 4294967295) {
			throw new RangeError(`Value ${value} is out of range [0, 4294967295]`);
		}

		this.setUint8(offset, (value >> 24) & 0xFF);
		this.setUint8(offset + 1, (value >> 16) & 0xFF);
		this.setUint8(offset + 2, (value >> 8) & 0xFF);
		this.setUint8(offset + 3, value & 0xFF);
	}
}
