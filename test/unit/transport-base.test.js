import { assertEquals, assertRejects, assert } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { Transport, TimeoutError, DuplicateReaderError, UnsupportedOperationError } from '../../src/transport/base.esm.js';

// Mock transport implementation for testing
class MockTransport extends Transport {
	#startCalled = false;
	#closeCalled = false;
	#requestedChannels = [];
	#sentMessages = [];

	async _start () {
		this.#startCalled = true;
	}

	async _close () {
		this.#closeCalled = true;
	}

	async _requestChannel (idOrName, options) {
		this.#requestedChannels.push({ idOrName, options });
		// Return a mock channel
		return { id: idOrName, name: idOrName };
	}

	async _sendMessage (channelId, message) {
		this.#sentMessages.push({ channelId, message });
	}

	_handleIncomingMessage (message) {
		// Mock implementation
	}

	// Test helpers
	get startCalled () { return this.#startCalled; }
	get closeCalled () { return this.#closeCalled; }
	get requestedChannels () { return this.#requestedChannels; }
	get sentMessages () { return this.#sentMessages; }
}

Deno.test('Transport - constructor with default logger', () => {
	const transport = new MockTransport();
	assert(transport.logger !== null);
	assertEquals(transport.isStarted, false);
	assertEquals(transport.isClosed, false);
});

Deno.test('Transport - constructor with custom logger', () => {
	const customLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
	const transport = new MockTransport({ logger: customLogger });
	assertEquals(transport.logger, customLogger);
});

Deno.test('Transport - setChannelDefaults', () => {
	const transport = new MockTransport();
	
	transport.setChannelDefaults({
		maxBufferBytes: 1024,
		maxChunkBytes: 512,
		maxMessageBytes: 2048,
		lowBufferBytes: 256,
	});

	const defaults = transport.getChannelDefaults();
	assertEquals(defaults.maxBufferBytes, 1024);
	assertEquals(defaults.maxChunkBytes, 512);
	assertEquals(defaults.maxMessageBytes, 2048);
	assertEquals(defaults.lowBufferBytes, 256);
});

Deno.test('Transport - setChannelDefaults partial update', () => {
	const transport = new MockTransport();
	
	transport.setChannelDefaults({ maxBufferBytes: 1024 });
	let defaults = transport.getChannelDefaults();
	assertEquals(defaults.maxBufferBytes, 1024);
	assertEquals(defaults.maxChunkBytes, 0);

	transport.setChannelDefaults({ maxChunkBytes: 512 });
	defaults = transport.getChannelDefaults();
	assertEquals(defaults.maxBufferBytes, 1024);
	assertEquals(defaults.maxChunkBytes, 512);
});

Deno.test('Transport - start', async () => {
	const transport = new MockTransport();
	
	assertEquals(transport.isStarted, false);
	await transport.start();
	assertEquals(transport.isStarted, true);
	assertEquals(transport.startCalled, true);
});

Deno.test('Transport - start throws if already started', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	await assertRejects(
		() => transport.start(),
		Error,
		'Transport already started'
	);
});

Deno.test('Transport - start throws if closed', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	await transport.close();
	
	await assertRejects(
		() => transport.start(),
		Error,
		'Transport is closed'
	);
});

Deno.test('Transport - close', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	assertEquals(transport.isClosed, false);
	
	await transport.close();
	assertEquals(transport.isClosed, true);
	assertEquals(transport.closeCalled, true);
});

Deno.test('Transport - close is idempotent', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	await transport.close();
	await transport.close(); // Should not throw
	
	assertEquals(transport.isClosed, true);
});

Deno.test('Transport - close emits beforeClosing and closed events', async () => {
	const transport = new MockTransport();
	const events = [];
	
	transport.addEventListener('beforeClosing', (event) => {
		events.push('beforeClosing');
	});
	
	transport.addEventListener('closed', (event) => {
		events.push('closed');
	});
	
	await transport.start();
	await transport.close();
	
	assertEquals(events, ['beforeClosing', 'closed']);
});

Deno.test('Transport - requestChannel', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	const channel = await transport.requestChannel('test-channel', { timeout: 5000 });
	
	assertEquals(channel.id, 'test-channel');
	assertEquals(transport.requestedChannels.length, 1);
	assertEquals(transport.requestedChannels[0].idOrName, 'test-channel');
	assertEquals(transport.requestedChannels[0].options.timeout, 5000);
});

Deno.test('Transport - requestChannel throws if not started', async () => {
	const transport = new MockTransport();
	
	await assertRejects(
		() => transport.requestChannel('test-channel'),
		Error,
		'Transport not started'
	);
});

Deno.test('Transport - requestChannel throws if closed', async () => {
	const transport = new MockTransport();
	
	await transport.start();
	await transport.close();
	
	await assertRejects(
		() => transport.requestChannel('test-channel'),
		Error,
		'Transport is closed'
	);
});

Deno.test('Transport - getChannel returns undefined for non-existent channel', () => {
	const transport = new MockTransport();
	
	const channel = transport.getChannel('non-existent');
	assertEquals(channel, undefined);
});

Deno.test('Transport - channels returns empty map initially', () => {
	const transport = new MockTransport();
	
	const channels = transport.channels;
	assertEquals(channels.size, 0);
});

Deno.test('Transport - _registerChannel and getChannel', () => {
	const transport = new MockTransport();
	const mockChannel = { id: 'test', name: 'test' };
	
	transport._registerChannel('test', mockChannel);
	
	const retrieved = transport.getChannel('test');
	assertEquals(retrieved, mockChannel);
	
	const channels = transport.channels;
	assertEquals(channels.size, 1);
	assertEquals(channels.get('test'), mockChannel);
});

Deno.test('Transport - _unregisterChannel', () => {
	const transport = new MockTransport();
	const mockChannel = { id: 'test', name: 'test' };
	
	transport._registerChannel('test', mockChannel);
	assertEquals(transport.getChannel('test'), mockChannel);
	
	transport._unregisterChannel('test');
	assertEquals(transport.getChannel('test'), undefined);
});

Deno.test('Transport - abstract methods throw if not implemented', async () => {
	class IncompleteTransport extends Transport {}
	const transport = new IncompleteTransport();
	
	await assertRejects(
		() => transport._start(),
		Error,
		'_start() must be implemented by subclass'
	);
	
	await assertRejects(
		() => transport._close(),
		Error,
		'_close() must be implemented by subclass'
	);
	
	await assertRejects(
		() => transport._requestChannel('test', {}),
		Error,
		'_requestChannel() must be implemented by subclass'
	);
	
	await assertRejects(
		() => transport._sendMessage(1, {}),
		Error,
		'_sendMessage() must be implemented by subclass'
	);
	
	try {
		transport._handleIncomingMessage({});
		assert(false, 'Should have thrown');
	} catch (err) {
		assertEquals(err.message, '_handleIncomingMessage() must be implemented by subclass');
	}
});

Deno.test('TimeoutError', () => {
	const error = new TimeoutError();
	assertEquals(error.name, 'TimeoutError');
	assertEquals(error.message, 'Operation timed out');
	
	const customError = new TimeoutError('Custom timeout');
	assertEquals(customError.message, 'Custom timeout');
});

Deno.test('DuplicateReaderError', () => {
	const error = new DuplicateReaderError();
	assertEquals(error.name, 'DuplicateReaderError');
	assertEquals(error.message, 'Duplicate reader detected');
	
	const customError = new DuplicateReaderError('Custom duplicate');
	assertEquals(customError.message, 'Custom duplicate');
});

Deno.test('UnsupportedOperationError', () => {
	const error = new UnsupportedOperationError();
	assertEquals(error.name, 'UnsupportedOperationError');
	assertEquals(error.message, 'Unsupported operation');
	
	const customError = new UnsupportedOperationError('Custom unsupported');
	assertEquals(customError.message, 'Custom unsupported');
});
