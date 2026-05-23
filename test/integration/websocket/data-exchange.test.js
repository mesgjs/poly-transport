/*
 * WebSocketTransport Data Exchange Integration Tests
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerDataExchangeTests(makeWebSocketTransportPair);
