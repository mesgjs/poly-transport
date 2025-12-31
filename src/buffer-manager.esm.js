// Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
//
// Buffer management for PolyTransport
// Provides efficient buffer pooling, virtual buffer views, and BYOB reader support

/**
 * VirtualBuffer - Provides a view over multiple non-contiguous buffer ranges
 * 
 * Allows treating multiple ArrayBuffer ranges as a single logical buffer
 * without copying data. Useful for efficient message assembly from chunks.
 */
const ranges = new WeakMap();

const getRanges = (vb) => {
	const r = ranges.get(vb);
	if (!r) {
		throw new Error('Internal error: missing ranges');
	}
	return r;
};

export class VirtualBuffer {
	constructor () {
		// NOTE: this is intentionally not a private field so `VirtualRWBuffer` can extend
		// and reuse the range machinery without copying code.
		ranges.set(this, []); // Array of { buffer: Uint8Array, offset: number, length: number }
		this.totalLength = 0;
	}

	/**
	 * Append a buffer range to the virtual buffer
	 * @param {Uint8Array} buffer - The buffer to add
	 * @param {number} offset - Starting offset in the buffer (default: 0)
	 * @param {number} length - Length to use (default: buffer.length - offset)
	 */
	append (buffer, offset = 0, length = buffer.length - offset) {
		if (!(buffer instanceof Uint8Array)) {
			throw new TypeError('Buffer must be a Uint8Array');
		}
		if (offset < 0 || offset > buffer.length) {
			throw new RangeError('Offset out of bounds');
		}
		if (length < 0 || offset + length > buffer.length) {
			throw new RangeError('Length out of bounds');
		}
		if (length === 0) {
			return; // Don't add empty ranges
		}

		getRanges(this).push({ buffer, offset, length });
		this.totalLength += length;
	}

	/**
	 * Get the total length of all ranges
	 * @returns {number}
	 */
	get length () {
		return this.totalLength;
	}

	/**
	 * Return a single byte at the given virtual offset
	 * @param {number} virtualOffset - Offset in the virtual buffer
	 * @returns {number} The byte value
	 */
	get (virtualOffset) {
		if (virtualOffset < 0 || virtualOffset >= this.totalLength) {
			throw new RangeError('Virtual offset out of bounds');
		}

		let currentOffset = 0;
		for (const range of getRanges(this)) {
			if (virtualOffset < currentOffset + range.length) {
				const rangeOffset = virtualOffset - currentOffset;
				return range.buffer[range.offset + rangeOffset];
			}
			currentOffset += range.length;
		}

		throw new Error('Internal error: offset not found in ranges');
	}

	/**
	 * Copy data from the virtual buffer to a target buffer
	 * @param {Uint8Array} target - Target buffer
	 * @param {number} targetOffset - Offset in target buffer
	 * @param {number} virtualOffset - Offset in virtual buffer
	 * @param {number} length - Number of bytes to copy
	 * @returns {number} Number of bytes copied
	 */
	copyTo (target, targetOffset = 0, virtualOffset = 0, length = this.totalLength - virtualOffset) {
		if (!(target instanceof Uint8Array)) {
			throw new TypeError('Target must be a Uint8Array');
		}
		if (targetOffset < 0 || targetOffset > target.length) {
			throw new RangeError('Target offset out of bounds');
		}
		if (virtualOffset < 0 || virtualOffset > this.totalLength) {
			throw new RangeError('Virtual offset out of bounds');
		}

		// Clamp length to available space
		length = Math.min(length, this.totalLength - virtualOffset, target.length - targetOffset);
		if (length <= 0) {
			return 0;
		}

		let remaining = length;
		let currentVirtualOffset = 0;
		let currentTargetOffset = targetOffset;

		for (const range of getRanges(this)) {
			// Skip ranges before our start offset
			if (virtualOffset >= currentVirtualOffset + range.length) {
				currentVirtualOffset += range.length;
				continue;
			}

			// Calculate how much to copy from this range
			const rangeStartOffset = Math.max(0, virtualOffset - currentVirtualOffset);
			const rangeAvailable = range.length - rangeStartOffset;
			const toCopy = Math.min(remaining, rangeAvailable);

			// Copy the data
			target.set(
				range.buffer.subarray(
					range.offset + rangeStartOffset,
					range.offset + rangeStartOffset + toCopy
				),
				currentTargetOffset
			);

			currentTargetOffset += toCopy;
			remaining -= toCopy;

			if (remaining === 0) {
				break;
			}

			currentVirtualOffset += range.length;
		}

		return length;
	}

	/**
	 * Create a new Uint8Array containing all data from the virtual buffer
	 * @returns {Uint8Array}
	 */
	toUint8Array () {
		const result = new Uint8Array(this.totalLength);
		this.copyTo(result, 0, 0, this.totalLength);
		return result;
	}

	/**
	 * Remove the first n bytes from the virtual buffer
	 * @param {number} count - Number of bytes to consume
	 */
	consume (count) {
		if (count < 0) {
			throw new RangeError('Count must be non-negative');
		}
		if (count === 0) {
			return;
		}
		if (count > this.totalLength) {
			throw new RangeError('Cannot consume more bytes than available');
		}

		let remaining = count;
		const r = getRanges(this);
		while (remaining > 0 && r.length > 0) {
			const range = r[0];
			if (remaining >= range.length) {
				// Consume entire range
				remaining -= range.length;
				this.totalLength -= range.length;
				r.shift();
			} else {
				// Consume part of range
				range.offset += remaining;
				range.length -= remaining;
				this.totalLength -= remaining;
				remaining = 0;
			}
		}
	}

	/**
	 * Clear all ranges
	 */
	clear () {
		ranges.set(this, []);
		this.totalLength = 0;
	}
}

/**
 * VirtualRWBuffer - A VirtualBuffer that supports writing.
 *
 * Used for ring-backed outbound reservations.
 */
export class VirtualRWBuffer extends VirtualBuffer {
	constructor () {
		super();
	}

	set (virtualOffset, value) {
		if (virtualOffset < 0 || virtualOffset >= this.totalLength) {
			throw new RangeError('Virtual offset out of bounds');
		}
		if (!Number.isInteger(value) || value < 0 || value > 255) {
			throw new RangeError('value must be an integer in [0, 255]');
		}

		let currentOffset = 0;
		for (const range of getRanges(this)) {
			if (virtualOffset < currentOffset + range.length) {
				const rangeOffset = virtualOffset - currentOffset;
				range.buffer[range.offset + rangeOffset] = value;
				return;
			}
			currentOffset += range.length;
		}

		throw new Error('Internal error: offset not found in ranges');
	}

	/**
	 * Fill bytes in the virtual buffer.
	 *
	 * This is useful for explicitly pre-zeroing ring-backed reservations.
	 */
	fill (value = 0, virtualOffset = 0, length = this.totalLength - virtualOffset) {
		if (!Number.isInteger(value) || value < 0 || value > 255) {
			throw new RangeError('value must be an integer in [0, 255]');
		}
		if (virtualOffset < 0 || virtualOffset > this.totalLength) {
			throw new RangeError('Virtual offset out of bounds');
		}

		length = Math.min(length, this.totalLength - virtualOffset);
		if (length <= 0) {
			return 0;
		}

		let remaining = length;
		let currentVirtualOffset = 0;

		for (const range of getRanges(this)) {
			if (virtualOffset >= currentVirtualOffset + range.length) {
				currentVirtualOffset += range.length;
				continue;
			}

			const rangeStartOffset = Math.max(0, virtualOffset - currentVirtualOffset);
			const rangeAvailable = range.length - rangeStartOffset;
			const toFill = Math.min(remaining, rangeAvailable);
			range.buffer.fill(value, range.offset + rangeStartOffset, range.offset + rangeStartOffset + toFill);

			remaining -= toFill;
			if (remaining === 0) {
				break;
			}

			currentVirtualOffset += range.length;
		}

		return length;
	}

	copyFrom (source, sourceOffset = 0, virtualOffset = 0, length = source.length - sourceOffset) {
		if (!(source instanceof Uint8Array)) {
			throw new TypeError('Source must be a Uint8Array');
		}
		if (sourceOffset < 0 || sourceOffset > source.length) {
			throw new RangeError('Source offset out of bounds');
		}
		if (virtualOffset < 0 || virtualOffset > this.totalLength) {
			throw new RangeError('Virtual offset out of bounds');
		}

		length = Math.min(length, source.length - sourceOffset, this.totalLength - virtualOffset);
		if (length <= 0) {
			return 0;
		}

		let remaining = length;
		let currentVirtualOffset = 0;
		let currentSourceOffset = sourceOffset;

		for (const range of getRanges(this)) {
			// Skip ranges before our start offset
			if (virtualOffset >= currentVirtualOffset + range.length) {
				currentVirtualOffset += range.length;
				continue;
			}

			// Calculate how much to copy into this range
			const rangeStartOffset = Math.max(0, virtualOffset - currentVirtualOffset);
			const rangeAvailable = range.length - rangeStartOffset;
			const toCopy = Math.min(remaining, rangeAvailable);

			range.buffer.set(
				source.subarray(currentSourceOffset, currentSourceOffset + toCopy),
				range.offset + rangeStartOffset
			);

			currentSourceOffset += toCopy;
			remaining -= toCopy;

			if (remaining === 0) {
				break;
			}

			currentVirtualOffset += range.length;
		}

		return length;
	}
}

/**
 * BufferPool - Manages a pool of reusable ArrayBuffers
 * 
 * Reduces allocation overhead by reusing buffers. Buffers are organized
 * by size class for efficient allocation.
 */
export class BufferPool {
	constructor (options = {}) {
		this.minSize = options.minSize || 1024; // 1KB minimum
		this.maxSize = options.maxSize || 1024 * 1024; // 1MB maximum
		this.maxPoolSize = options.maxPoolSize || 100; // Max buffers per size class
		this.pools = new Map(); // size -> array of buffers
	}

	/**
	 * Get the size class for a requested size
	 * Rounds up to next power of 2
	 * @param {number} size - Requested size
	 * @returns {number} Size class
	 */
	getSizeClass (size) {
		if (size <= this.minSize) {
			return this.minSize;
		}
		if (size >= this.maxSize) {
			return this.maxSize;
		}

		// Round up to next power of 2
		let sizeClass = this.minSize;
		while (sizeClass < size) {
			sizeClass *= 2;
		}
		return Math.min(sizeClass, this.maxSize);
	}

	/**
	 * Allocate a buffer of at least the requested size
	 * @param {number} size - Minimum size needed
	 * @returns {Uint8Array} Buffer of at least the requested size
	 */
	allocate (size) {
		const sizeClass = this.getSizeClass(size);
		const pool = this.pools.get(sizeClass);

		if (pool && pool.length > 0) {
			return pool.pop();
		}

		// No pooled buffer available, create new one
		return new Uint8Array(sizeClass);
	}

	/**
	 * Return a buffer to the pool for reuse
	 * @param {Uint8Array} buffer - Buffer to return
	 */
	release (buffer) {
		if (!(buffer instanceof Uint8Array)) {
			return; // Ignore non-Uint8Array buffers
		}

		const size = buffer.length;
		const sizeClass = this.getSizeClass(size);

		// Only pool if it matches a size class
		if (size !== sizeClass) {
			return; // Don't pool odd-sized buffers
		}

		let pool = this.pools.get(sizeClass);
		if (!pool) {
			pool = [];
			this.pools.set(sizeClass, pool);
		}

		// Only add if pool isn't full
		if (pool.length < this.maxPoolSize) {
			pool.push(buffer);
		}
	}

	/**
	 * Clear all pooled buffers
	 */
	clear () {
		this.pools.clear();
	}

	/**
	 * Get statistics about the pool
	 * @returns {Object} Pool statistics
	 */
	getStats () {
		const stats = {
			sizeClasses: [],
			totalBuffers: 0,
			totalBytes: 0
		};

		for (const [sizeClass, pool] of this.pools) {
			const count = pool.length;
			stats.sizeClasses.push({ size: sizeClass, count });
			stats.totalBuffers += count;
			stats.totalBytes += sizeClass * count;
		}

		return stats;
	}
}

/**
 * BufferManager - Manages buffer lifecycle with reference counting
 * 
 * Tracks buffer ownership and automatically returns buffers to the pool
 * when no longer referenced. Supports BYOB (Bring Your Own Buffer) readers.
 */
export class BufferManager {
	constructor (pool = null) {
		this.pool = pool || new BufferPool();
		this.references = new WeakMap(); // buffer -> refCount
		this.bufferInfo = new Map(); // buffer -> { refCount, size }
	}

	/**
	 * Allocate a managed buffer
	 * @param {number} size - Minimum size needed
	 * @returns {Uint8Array} Managed buffer with refCount = 1
	 */
	allocate (size) {
		const buffer = this.pool.allocate(size);
		this.bufferInfo.set(buffer, { refCount: 1, size: buffer.length });
		return buffer;
	}

	/**
	 * Increment reference count for a buffer
	 * @param {Uint8Array} buffer - Buffer to reference
	 * @returns {boolean} True if successful, false if buffer not managed
	 */
	addRef (buffer) {
		const info = this.bufferInfo.get(buffer);
		if (!info) {
			return false;
		}
		info.refCount++;
		return true;
	}

	/**
	 * Decrement reference count and release if zero
	 * @param {Uint8Array} buffer - Buffer to release
	 * @returns {boolean} True if buffer was released to pool
	 */
	release (buffer) {
		const info = this.bufferInfo.get(buffer);
		if (!info) {
			return false;
		}

		info.refCount--;
		if (info.refCount <= 0) {
			this.bufferInfo.delete(buffer);
			this.pool.release(buffer);
			return true;
		}
		return false;
	}

	/**
	 * Get reference count for a buffer
	 * @param {Uint8Array} buffer - Buffer to check
	 * @returns {number} Reference count, or 0 if not managed
	 */
	getRefCount (buffer) {
		const info = this.bufferInfo.get(buffer);
		return info ? info.refCount : 0;
	}

	/**
	 * Get statistics about managed buffers
	 * @returns {Object} Manager statistics
	 */
	getStats () {
		const stats = {
			managedBuffers: this.bufferInfo.size,
			totalRefs: 0,
			poolStats: this.pool.getStats()
		};

		for (const info of this.bufferInfo.values()) {
			stats.totalRefs += info.refCount;
		}

		return stats;
	}
}

/**
 * RingPin - Explicit handle for pinned ring-backed byte ranges.
 *
 * A pin prevents the ring from overwriting the referenced range until the pin is
 * released. Pins are explicitly ref-counted and must be released for forward progress.
 */
export class RingPin {
	constructor (ring, id, absStart, length, holder) {
		this.ring = ring;
		this.id = id;
		this.absStart = absStart;
		this.length = length;
		this.holder = holder;
		this.refCount = 1;
		this.released = false;
	}

	addRef () {
		if (this.released) {
			throw new Error('RingPin already released');
		}
		this.refCount++;
	}

	release () {
		if (this.released) {
			return;
		}
		this.refCount--;
		if (this.refCount <= 0) {
			this.released = true;
			this.ring._releasePin(this);
		}
	}

	/**
	 * Views into the ring storage (contiguous or split at wrap).
	 *
	 * IMPORTANT: These are ring-backed and become invalid if the ring overwrites the
	 * underlying bytes.
	 */
	get views () {
		if (this.released) {
			return [];
		}
		return this.ring._absRangeViews(this.absStart, this.length);
	}

	/**
	 * Copy the pinned bytes into pool-managed storage and release the pin.
	 *
	 * Returns a managed buffer window descriptor.
	 */
	migrate (bufferManager) {
		if (!(bufferManager instanceof BufferManager)) {
			throw new TypeError('bufferManager must be a BufferManager');
		}
		if (this.released) {
			throw new Error('RingPin already released');
		}

		const managed = bufferManager.allocate(this.length);
		this.ring._copyAbsRangeInto(this.absStart, this.length, managed, 0);
		const result = { buffer: managed, offset: 0, length: this.length };
		this.release();
		return result;
	}
}

/**
 * RingBuffer - Circular buffer for BYOB reader support
 * 
 * Provides efficient buffer reuse for streaming scenarios where data
 * is continuously read and consumed.
 */
export class RingBuffer {
	constructor (size) {
		if (size <= 0 || !Number.isInteger(size)) {
			throw new TypeError('Size must be a positive integer');
		}
		this.buffer = new Uint8Array(size);
		this.readPos = 0;
		this.writePos = 0;
		this.size = size;
		this.count = 0; // Track actual data count
		this._pins = new Map(); // id -> RingPin
		this._nextPinId = 1;
		this._absRead = 0;
		this._absWrite = 0;
	}

	/**
	 * Get the number of bytes available to read
	 * @returns {number}
	 */
	get available () {
		return this.count;
	}

	/**
	 * Get the number of bytes available to write
	 * @returns {number}
	 */
	get space () {
		return this.size - this.count;
	}

	get pinnedCount () {
		return this._pins.size;
	}

	_absRangeViews (absStart, length) {
		if (length === 0) {
			return [];
		}
		if (length < 0 || length > this.size) {
			throw new RangeError('Invalid ring range length');
		}

		const start = absStart % this.size;
		const endPos = start + length;
		if (endPos <= this.size) {
			return [this.buffer.subarray(start, endPos)];
		}
		const firstChunk = this.size - start;
		return [
			this.buffer.subarray(start, this.size),
			this.buffer.subarray(0, length - firstChunk)
		];
	}

	_copyAbsRangeInto (absStart, length, target, targetOffset = 0) {
		if (!(target instanceof Uint8Array)) {
			throw new TypeError('Target must be a Uint8Array');
		}
		if (length === 0) {
			return 0;
		}
		if (length < 0 || length > this.size) {
			throw new RangeError('Invalid ring range length');
		}

		const start = absStart % this.size;
		const endPos = start + length;
		if (endPos <= this.size) {
			target.set(this.buffer.subarray(start, endPos), targetOffset);
			return length;
		}

		const firstChunk = this.size - start;
		target.set(this.buffer.subarray(start, this.size), targetOffset);
		target.set(this.buffer.subarray(0, length - firstChunk), targetOffset + firstChunk);
		return length;
	}

	_pinReadable (offset, length, holder) {
		if (!Number.isInteger(offset) || offset < 0) {
			throw new RangeError('offset must be a non-negative integer');
		}
		if (!Number.isInteger(length) || length < 0) {
			throw new RangeError('length must be a non-negative integer');
		}
		if (offset + length > this.available) {
			throw new RangeError('Pin range out of bounds');
		}
		if (!holder) {
			throw new TypeError('holder is required');
		}
		const absStart = this._absRead + offset;
		const id = this._nextPinId++;
		const pin = new RingPin(this, id, absStart, length, holder);
		this._pins.set(id, pin);
		return pin;
	}

	_releasePin(pin) {
		this._pins.delete(pin.id);
	}

	_overlapsWrite (pin, absWriteStart, writeLength) {
		// Detect whether a future write range would overwrite the pinned bytes due to wrap-around.
		// We test overlap against the pin shifted by +/- n*size near the write range.
		const pinStart = pin.absStart;
		const pinEnd = pinStart + pin.length;
		const writeEnd = absWriteStart + writeLength;
		const size = this.size;

		const baseK = Math.floor((absWriteStart - pinStart) / size);
		for (const k of [baseK - 1, baseK, baseK + 1]) {
			if (k < 0) {
				continue;
			}
			const shiftedStart = pinStart + k * size;
			const shiftedEnd = pinEnd + k * size;
			if (Math.max(shiftedStart, absWriteStart) < Math.min(shiftedEnd, writeEnd)) {
				return true;
			}
		}

		return false;
	}

	_writeRangesForLength (length) {
		if (length === 0) {
			return [];
		}
		const endPos = this.writePos + length;
		if (endPos <= this.size) {
			return [{ start: this.writePos, length }];
		}
		const firstChunk = this.size - this.writePos;
		return [
			{ start: this.writePos, length: firstChunk },
			{ start: 0, length: length - firstChunk }
		];
	}

	async _reclaimForWrite (absWriteStart, writeLength) {
		if (writeLength === 0 || this._pins.size === 0) {
			return;
		}

		const pins = [];
		for (const pin of this._pins.values()) {
			if (!pin.released && this._overlapsWrite(pin, absWriteStart, writeLength)) {
				pins.push(pin);
			}
		}
		if (pins.length === 0) {
			return;
		}

		const ranges = this._writeRangesForLength(writeLength);
		const byHolder = new Map();
		for (const pin of pins) {
			let list = byHolder.get(pin.holder);
			if (!list) {
				list = [];
				byHolder.set(pin.holder, list);
			}
			list.push(pin);
		}

		for (const [holder, holderPins] of byHolder) {
			if (!holder || typeof holder.onRingReclaim !== 'function') {
				throw new Error('Ring pin holder missing onRingReclaim handler');
			}
			await holder.onRingReclaim({
				ring: this,
				ranges,
				pins: holderPins,
				absWriteStart,
				writeLength
			});
		}

		// Verify reclaim succeeded.
		for (const pin of this._pins.values()) {
			if (!pin.released && this._overlapsWrite(pin, absWriteStart, writeLength)) {
				throw new Error('Ring reclaim failed: pin still overlaps write range');
			}
		}
	}

	peekVirtual (length, { offset = 0 } = {}) {
		if (!Number.isInteger(offset) || offset < 0) {
			throw new RangeError('offset must be a non-negative integer');
		}
		if (!Number.isInteger(length) || length < 0) {
			throw new RangeError('length must be a non-negative integer');
		}
		length = Math.min(length, this.available - offset);
		if (length <= 0) {
			return new VirtualBuffer();
		}

		const vb = new VirtualBuffer();
		const start = (this.readPos + offset) % this.size;
		const endPos = start + length;
		if (endPos <= this.size) {
			vb.append(this.buffer, start, length);
			return vb;
		}
		const firstChunk = this.size - start;
		vb.append(this.buffer, start, firstChunk);
		vb.append(this.buffer, 0, length - firstChunk);
		return vb;
	}

	peekPinnedVirtualBuffer (length, { offset = 0, bufferManager } = {}) {
		if (!(bufferManager instanceof BufferManager)) {
			throw new TypeError('bufferManager must be a BufferManager');
		}
		const vb = new RingBackedVirtualBuffer(this, bufferManager, offset, length);
		return vb;
	}

	async writeWithReclaim (data, offset = 0, length = data.length - offset) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('Data must be a Uint8Array');
		}

		length = Math.min(length, this.space);
		if (length === 0) {
			return 0;
		}

		const absWriteStart = this._absWrite;
		await this._reclaimForWrite(absWriteStart, length);
		return this.write(data, offset, length);
	}

	/**
	 * Write data to the ring buffer
	 * @param {Uint8Array} data - Data to write
	 * @param {number} offset - Offset in data (default: 0)
	 * @param {number} length - Length to write (default: data.length - offset)
	 * @returns {number} Number of bytes written
	 */
	write (data, offset = 0, length = data.length - offset) {
		if (!(data instanceof Uint8Array)) {
			throw new TypeError('Data must be a Uint8Array');
		}

		// Clamp to available space
		length = Math.min(length, this.space);
		if (length === 0) {
			return 0;
		}

		const endPos = this.writePos + length;
		if (endPos <= this.size) {
			// Contiguous write
			this.buffer.set(data.subarray(offset, offset + length), this.writePos);
			this.writePos = endPos % this.size;
		} else {
			// Wrapped write
			const firstChunk = this.size - this.writePos;
			this.buffer.set(data.subarray(offset, offset + firstChunk), this.writePos);
			this.buffer.set(data.subarray(offset + firstChunk, offset + length), 0);
			this.writePos = length - firstChunk;
		}

		this.count += length;
		this._absWrite += length;
		return length;
	}

	/**
	 * Read data from the ring buffer
	 * @param {Uint8Array} target - Target buffer
	 * @param {number} targetOffset - Offset in target (default: 0)
	 * @param {number} length - Length to read (default: target.length - targetOffset)
	 * @returns {number} Number of bytes read
	 */
	read (target, targetOffset = 0, length = target.length - targetOffset) {
		if (!(target instanceof Uint8Array)) {
			throw new TypeError('Target must be a Uint8Array');
		}

		// Clamp to available data
		length = Math.min(length, this.available);
		if (length === 0) {
			return 0;
		}

		const endPos = this.readPos + length;
		if (endPos <= this.size) {
			// Contiguous read
			target.set(this.buffer.subarray(this.readPos, endPos), targetOffset);
			this.readPos = endPos % this.size;
		} else {
			// Wrapped read
			const firstChunk = this.size - this.readPos;
			target.set(this.buffer.subarray(this.readPos, this.size), targetOffset);
			target.set(this.buffer.subarray(0, length - firstChunk), targetOffset + firstChunk);
			this.readPos = length - firstChunk;
		}

		this.count -= length;
		this._absRead += length;
		return length;
	}

	/**
	 * Peek at data without consuming it
	 * @param {Uint8Array} target - Target buffer
	 * @param {number} targetOffset - Offset in target (default: 0)
	 * @param {number} length - Length to peek (default: target.length - targetOffset)
	 * @returns {number} Number of bytes peeked
	 */
	peek (target, targetOffset = 0, length = target.length - targetOffset) {
		if (!(target instanceof Uint8Array)) {
			throw new TypeError('Target must be a Uint8Array');
		}

		// Clamp to available data
		length = Math.min(length, this.available);
		if (length === 0) {
			return 0;
		}

		const endPos = this.readPos + length;
		if (endPos <= this.size) {
			// Contiguous peek
			target.set(this.buffer.subarray(this.readPos, endPos), targetOffset);
		} else {
			// Wrapped peek
			const firstChunk = this.size - this.readPos;
			target.set(this.buffer.subarray(this.readPos, this.size), targetOffset);
			target.set(this.buffer.subarray(0, length - firstChunk), targetOffset + firstChunk);
		}

		return length;
	}

	/**
	 * Skip (consume) bytes without reading them
	 * @param {number} count - Number of bytes to skip
	 * @returns {number} Number of bytes skipped
	 */
	skip (count) {
		count = Math.min(count, this.available);
		if (count === 0) {
			return 0;
		}

		this.readPos = (this.readPos + count) % this.size;
		this.count -= count;
		this._absRead += count;

		return count;
	}

	/**
	 * Clear the ring buffer
	 */
	clear () {
		this.readPos = 0;
		this.writePos = 0;
		this.count = 0;
		this._absRead = 0;
		this._absWrite = 0;
		this._pins.clear();
	}
}

/**
 * RingBackedVirtualBuffer - A VirtualBuffer that pins ring-backed ranges and
 * migrates them to pool-managed storage if the ring needs to reclaim space.
 */
export class RingBackedVirtualBuffer extends VirtualBuffer {
	constructor (ring, bufferManager, offset = 0, length = 0) {
		super();
		this.ring = ring;
		this.bufferManager = bufferManager;
		this.pin = null;

		if (!Number.isInteger(offset) || offset < 0) {
			throw new RangeError('offset must be a non-negative integer');
		}
		if (!Number.isInteger(length) || length < 0) {
			throw new RangeError('length must be a non-negative integer');
		}

		length = Math.min(length, ring.available - offset);
		if (length <= 0) {
			return;
		}

		// Build ring-backed ranges and pin them.
		const start = (ring.readPos + offset) % ring.size;
		const endPos = start + length;
		if (endPos <= ring.size) {
			this.append(ring.buffer, start, length);
		} else {
			const firstChunk = ring.size - start;
			this.append(ring.buffer, start, firstChunk);
			this.append(ring.buffer, 0, length - firstChunk);
		}

		this.pin = ring._pinReadable(offset, length, this);
	}

	releaseRingPin () {
		if (this.pin) {
			this.pin.release();
			this.pin = null;
		}
	}

	async onRingReclaim ({ pins }) {
		if (!this.pin) {
			return;
		}
		if (!pins || !pins.includes(this.pin)) {
			return;
		}

		const migrated = this.pin.migrate(this.bufferManager);
		this.clear();
		this.append(migrated.buffer, migrated.offset, migrated.length);
		this.pin = null;
	}
}
