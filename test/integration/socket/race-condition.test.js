/*
 * SocketTransport Race Condition Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerRaceConditionTests(makeSocketTransportPair);
