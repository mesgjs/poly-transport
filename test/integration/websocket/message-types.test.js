/*
 * WebSocketTransport Message Types Integration Tests
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerMessageTypeTests(makeWebSocketTransportPair);
