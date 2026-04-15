/*
 * WebSocketTransport Race Condition Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerRaceConditionTests(makeWebSocketTransportPair);
