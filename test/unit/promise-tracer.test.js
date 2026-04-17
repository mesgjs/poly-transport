/**
 * Unit tests for PromiseTracer
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { PromiseTracer } from '../../src/promise-tracer.esm.js';

// Helper to create a deferred promise
function defer () {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Helper to wait for a specific duration
function delay (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to capture log output
function captureLogs () {
	const logs = [];
	const log = (...args) => logs.push(args.join(' '));
	return { log, logs };
}

Deno.test('PromiseTracer - constructor with defaults', () => {
	const tracer = new PromiseTracer(5000);
	assertExists(tracer);
	tracer.stop();
});

Deno.test('PromiseTracer - constructor with custom options', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(3000, {
		intervalMs: 2000,
		log,
		logRejections: true
	});
	assertExists(tracer);
	tracer.stop();
});

Deno.test('PromiseTracer - trace() registers promise', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise, resolve } = defer();
	tracer.trace(promise, 'test wait');
	
	// Promise should be in registry (not directly testable, but we can verify via report)
	tracer.report({ quiet: true });
	assertEquals(logs.length, 1); // Should report the pending wait
	
	resolve();
	tracer.stop();
});

Deno.test('PromiseTracer - trace() returns same promise', () => {
	const tracer = new PromiseTracer(5000);
	const { promise } = defer();
	const returned = tracer.trace(promise, 'test wait');
	assertEquals(returned, promise);
	tracer.stop();
});

Deno.test('PromiseTracer - promise auto-removed on resolve', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise, resolve } = defer();
	tracer.trace(promise, 'test wait');
	
	resolve('done');
	await promise;
	
	// Give .then() handler time to run
	await delay(10);
	
	tracer.report({ quiet: true });
	assertEquals(logs.length, 0); // Should not report anything (promise settled)
	
	tracer.stop();
});

Deno.test('PromiseTracer - promise auto-removed on reject (logRejections=false)', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log, logRejections: false });
	
	const { promise, reject } = defer();
	tracer.trace(promise, 'test wait');
	
	reject(new Error('test error'));
	
	// Catch the rejection to prevent uncaught error
	try {
		await promise;
	} catch (_) {
		// Expected
	}
	
	// Give .catch() handler time to run
	await delay(10);
	
	tracer.report({ quiet: true });
	assertEquals(logs.length, 0); // Should not report anything (promise settled, logRejections=false)
	
	tracer.stop();
});

Deno.test('PromiseTracer - promise rejection logged when logRejections=true', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log, logRejections: true });
	
	const { promise, reject } = defer();
	tracer.trace(promise, 'test wait');
	
	reject(new Error('test error'));
	
	// Catch the rejection to prevent uncaught error
	try {
		await promise;
	} catch (_) {
		// Expected
	}
	
	// Give .catch() handler time to run
	await delay(10);
	
	assertEquals(logs.length, 1); // Should log the rejection
	assertEquals(logs[0].includes('[TRACE]'), true);
	assertEquals(logs[0].includes('Rejected'), true);
	assertEquals(logs[0].includes('test wait'), true);
	assertEquals(logs[0].includes('test error'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - clear() removes promise', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise } = defer();
	tracer.trace(promise, 'test wait');
	tracer.clear(promise);
	
	tracer.report({ quiet: true });
	assertEquals(logs.length, 0); // Should not report anything (manually cleared)
	
	tracer.stop();
});

Deno.test('PromiseTracer - clear() is no-op for unregistered promise', () => {
	const tracer = new PromiseTracer(5000);
	const { promise } = defer();
	tracer.clear(promise); // Should not throw
	tracer.stop();
});

Deno.test('PromiseTracer - report() shows all pending waits', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise: p1 } = defer();
	const { promise: p2 } = defer();
	tracer.trace(p1, 'wait 1');
	tracer.trace(p2, 'wait 2');
	
	tracer.report();
	assertEquals(logs.length, 2); // Should report both waits
	assertEquals(logs[0].includes('wait 1'), true);
	assertEquals(logs[1].includes('wait 2'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - report() with overdueOnly filters by threshold', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 10000 }); // 100ms threshold
	
	const { promise: p1 } = defer();
	const { promise: p2 } = defer();
	tracer.trace(p1, 'old wait');
	
	await delay(150); // Wait past threshold
	
	tracer.trace(p2, 'new wait');
	
	tracer.report({ overdueOnly: true });
	assertEquals(logs.length, 1); // Should only report old wait
	assertEquals(logs[0].includes('old wait'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - report() with quiet suppresses "No pending waits"', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	tracer.report({ quiet: true });
	assertEquals(logs.length, 0); // Should not log anything
	
	tracer.stop();
});

Deno.test('PromiseTracer - report() without quiet shows "No pending waits"', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	tracer.report({ quiet: false });
	assertEquals(logs.length, 1);
	assertEquals(logs[0].includes('No pending waits'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - report() sorts by timestamp', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise: p1 } = defer();
	tracer.trace(p1, 'first');
	
	await delay(50);
	
	const { promise: p2 } = defer();
	tracer.trace(p2, 'second');
	
	tracer.report();
	assertEquals(logs.length, 2);
	// First log should be the older wait
	assertEquals(logs[0].includes('first'), true);
	assertEquals(logs[1].includes('second'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - interval scan reports overdue waits', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 }); // 100ms threshold, 150ms interval
	
	const { promise } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Wait for interval scan to run
	await delay(200);
	
	// Should have auto-reported the overdue wait
	assertEquals(logs.length >= 1, true);
	assertEquals(logs[0].includes('[TRACE #1]'), true);
	assertEquals(logs[0].includes('overdue wait'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - interval scan assigns event ID', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Wait for interval scan to run
	await delay(200);
	
	// Should have assigned event ID #1
	assertEquals(logs[0].includes('[TRACE #1]'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - interval scan reports each wait exactly once', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Wait for multiple interval scans
	await delay(500);
	
	// Should have reported exactly once (not repeated)
	const traceReports = logs.filter(l => l.includes('[TRACE #1]') && l.includes('overdue wait'));
	assertEquals(traceReports.length, 1);
	
	tracer.stop();
});

Deno.test('PromiseTracer - resolution logged for auto-reported wait', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise, resolve } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Wait for interval scan to run
	await delay(200);
	
	// Clear logs from auto-report
	logs.length = 0;
	
	// Resolve the promise
	resolve('done');
	await promise;
	await delay(10); // Give .then() handler time to run
	
	// Should have logged resolution
	assertEquals(logs.length, 1);
	assertEquals(logs[0].includes('[TRACE #1]'), true);
	assertEquals(logs[0].includes('Resolved after'), true);
	assertEquals(logs[0].includes('overdue wait'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - resolution not logged for non-reported wait', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log, intervalMs: 10000 }); // Long threshold/interval
	
	const { promise, resolve } = defer();
	tracer.trace(promise, 'quick wait');
	
	// Resolve immediately (before auto-report)
	resolve('done');
	await promise;
	await delay(10); // Give .then() handler time to run
	
	// Should not have logged anything (not auto-reported)
	assertEquals(logs.length, 0);
	
	tracer.stop();
});

Deno.test('PromiseTracer - stop() clears interval timer', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Stop immediately (before first interval fires)
	tracer.stop();
	
	const initialLogCount = logs.length; // Should be 0 or 1 (if stop() reported pending wait)
	
	// Wait past when interval would have fired
	await delay(300);
	
	// Should not have any new auto-reports (timer cleared)
	assertEquals(logs.length, initialLogCount);
});

Deno.test('PromiseTracer - stop() reports pending waits in quiet mode', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise } = defer();
	tracer.trace(promise, 'pending wait');
	
	tracer.stop();
	
	// Should have reported the pending wait
	assertEquals(logs.length, 1);
	assertEquals(logs[0].includes('pending wait'), true);
	// Should not include "No pending waits" message (quiet mode)
	assertEquals(logs[0].includes('No pending waits'), false);
});

Deno.test('PromiseTracer - stop() with no pending waits is silent', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	tracer.stop();
	
	// Should not have logged anything (quiet mode, no pending waits)
	assertEquals(logs.length, 0);
});

Deno.test('PromiseTracer - report() includes event ID when assigned', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise } = defer();
	tracer.trace(promise, 'overdue wait');
	
	// Wait for interval scan to assign event ID
	await delay(200);
	
	// Clear logs from auto-report
	logs.length = 0;
	
	// Manual report should include event ID
	tracer.report();
	assertEquals(logs.length, 1);
	assertEquals(logs[0].includes('[TRACE #1]'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - report() without event ID shows no ID', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log, intervalMs: 10000 }); // Long interval
	
	const { promise } = defer();
	tracer.trace(promise, 'pending wait');
	
	tracer.report();
	assertEquals(logs.length, 1);
	// Should show [TRACE] without event ID
	assertEquals(logs[0].includes('[TRACE]'), true);
	assertEquals(logs[0].includes('[TRACE #'), false);
	
	tracer.stop();
});

Deno.test('PromiseTracer - stack trace captured at trace() call site', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	function outerFunction () {
		function innerFunction () {
			const { promise } = defer();
			tracer.trace(promise, 'test wait');
		}
		innerFunction();
	}
	outerFunction();
	
	tracer.report();
	assertEquals(logs.length, 1);
	// Stack trace should include innerFunction and outerFunction
	assertEquals(logs[0].includes('innerFunction'), true);
	assertEquals(logs[0].includes('outerFunction'), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - multiple event IDs increment correctly', async () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(100, { log, intervalMs: 150 });
	
	const { promise: p1 } = defer();
	const { promise: p2 } = defer();
	tracer.trace(p1, 'wait 1');
	tracer.trace(p2, 'wait 2');
	
	// Wait for interval scan to run
	await delay(200);
	
	// Should have assigned event IDs #1 and #2
	assertEquals(logs.some(l => l.includes('[TRACE #1]')), true);
	assertEquals(logs.some(l => l.includes('[TRACE #2]')), true);
	
	tracer.stop();
});

Deno.test('PromiseTracer - log format includes timestamp and age', () => {
	const { log, logs } = captureLogs();
	const tracer = new PromiseTracer(5000, { log });
	
	const { promise } = defer();
	tracer.trace(promise, 'test wait');
	
	tracer.report();
	assertEquals(logs.length, 1);
	// Should include ISO timestamp and age in ms
	assertEquals(logs[0].match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/) !== null, true);
	assertEquals(logs[0].includes('ms)'), true);
	
	tracer.stop();
});
