/*
 * SocketTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerRaceConditionTests(makeSocketTransportPair);
