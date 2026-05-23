/*
 * ByteTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeByteTransportPair } from '../../integration/helpers.js';

registerRaceConditionTests(makeByteTransportPair);
