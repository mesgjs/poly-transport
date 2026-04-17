/*
 * IPC Pipe Transport Class
 *
 * Byte-stream transport over Deno stdin/stdout or Deno.Command pipes.
 *
 * Usage:
 *   // Using stdin/stdout (for IPC between parent and child processes)
 *   const transport = new PipeTransport({ readable: Deno.stdin.readable, writable: Deno.stdout.writable });
 *
 *   // Using Deno.Command pipes
 *   const cmd = new Deno.Command('some-process', { stdin: 'piped', stdout: 'piped' });
 *   const child = cmd.spawn();
 *   const transport = new PipeTransport({ readable: child.stdout, writable: child.stdin });
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ByteTransport } from './byte.esm.js';
import { Transport } from './base.esm.js';

export class PipeTransport extends ByteTransport {
	static __protected = Object.freeze(Object.setPrototypeOf({
		/**
		 * Start the byte reader.
		 * Calls super.startReader() (which starts the protocol parser / #byteReader),
		 * then launches the pipe I/O reader that feeds raw bytes into receiveBytes().
		 */
		startReader () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			super.startReader(); // Starts ByteTransport's #byteReader (protocol parser)
			thys.#pipeReader(); // Runs the actual I/O reader
		},

		/**
		 * Transport-specific stop: drain output buffer, clear write timer, close writer,
		 * and cancel the pipe reader so the byte-reader loop can exit.
		 * Called by Transport base class #finalizeStop() and #onDisconnect().
		 */
		async stop () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			// Let ByteTransport drain the output buffer and clear the write timer
			await super.stop();

			// Close the writer (signals the remote's readable stream to end)
			if (thys.#writer) {
				try {
					await thys.#writer.close();
				} catch (_) { /* ignore close errors */ }
				thys.#writer = null;
			}

			// Cancel the reader to unblock any pending reader.read() call.
			// This also wakes the #byteReader's readWaiter (via receiveBytes with empty data
			// or by the reader.cancel() causing the stream to end).
			if (thys.#reader) {
				try {
					await thys.#reader.cancel();
				} catch (_) { /* ignore cancel errors */ }
				thys.#reader = null;
			}
		},

		/**
		 * Write committed bytes from the output ring buffer to the writable stream.
		 * Called by scheduleWrite() when there is committed data to send.
		 */
		async writeBytes () {
			const [thys, _thys] = [this.__this, this];
			if (_thys !== thys.#_) throw new Error('Unauthorized');
			const { outputBuffer } = _thys;

			// Loop to drain all committed data, including any newly committed
			// while we were awaiting writer.write() in a previous iteration.
			while (outputBuffer.committed > 0) {
				const committed = outputBuffer.committed;
				const buffers = outputBuffer.getBuffers(committed);

				try {
					const writer = thys.#writer;
					if (!writer) break;
					for (const buf of buffers) {
						await writer.write(buf);
					}
				} catch (err) {
					// Write failed — connection lost
					thys.logger.error('PipeTransport: write error', err);
					_thys.onDisconnect();
					return;
				}

				outputBuffer.release(committed);
			}

			_thys.afterWrite();
		},
	}, super.__protected));

	#_; // PipeTransport-level view of shared protected state
	#readable; // ReadableStream<Uint8Array>
	#reader = null; // ReadableStreamDefaultReader (stored for cancellation on stop)
	#writable; // WritableStream<Uint8Array>
	#writer = null; // WritableStreamDefaultWriter

	/**
	 * @param {object} options
	 * @param {ReadableStream<Uint8Array>} options.readable - Readable byte stream (input)
	 * @param {WritableStream<Uint8Array>} options.writable - Writable byte stream (output)
	 */
	constructor (options = {}) {
		super(options);
		this._get_();
		const { readable, writable } = options;
		if (!readable) throw new TypeError('PipeTransport: options.readable is required');
		if (!writable) throw new TypeError('PipeTransport: options.writable is required');
		this.#readable = readable;
		this.#writable = writable;
		this.#writer = writable.getWriter();
	}

	/**
	 * Run the pipe I/O reader loop.
	 * Reads chunks from the readable stream and feeds them to receiveBytes().
	 * Runs until the stream ends normally (graceful stop) or an error occurs (disconnect).
	 */
	async #pipeReader () {
		const _thys = this.#_;
		const reader = this.#reader = this.#readable.getReader();
		try {
			while (true) { // Read until closed by transport
				let result;
				try {
					result = await reader.read();
				} catch (err) {
					// Read error — unexpected connection loss
					this.logger.error('PipeTransport: read error', err);
					_thys.onDisconnect();
					break;
				}
				if (result.done) { // Stream ended normally (graceful stop or cancelled)
					const state = _thys.state;
					if (state !== Transport.STATE_STOPPED && state !== Transport.STATE_REMOTE_STOPPING) {
						_thys.onDisconnect(); // Disconnect if not stopped
					}
					break;
				}
				if (result.value && result.value.byteLength > 0) {
					_thys.receiveBytes(result.value);
				}
			}
		} finally {
			try { reader.releaseLock(); } catch (_) { /* ignore if already released */ }
		}
	}

	/**
	 * Subscribe to protected state
	 * @param {Set} subs - Subscribers Set
	 */
	_sub_ (subs) {
		super._sub_(subs);
		subs.add((prot) => this.#_ ||= prot); // Set #_ once
	}
}
