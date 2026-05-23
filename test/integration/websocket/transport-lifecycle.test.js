/*
 * WebSocketTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerTransportLifecycleTests(makeWebSocketTransportPair);
