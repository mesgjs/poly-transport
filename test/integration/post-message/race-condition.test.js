/*
 * PostMessageTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeMessageTransportPair } from '../../integration/helpers.js';

registerRaceConditionTests(makeMessageTransportPair);
