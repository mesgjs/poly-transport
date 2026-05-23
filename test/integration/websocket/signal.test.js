/*
 * WebSocketTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerSignalTests(makeWebSocketTransportPair);
