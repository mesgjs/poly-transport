/*
 * WebSocketTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerRaceConditionTests(makeWebSocketTransportPair);
