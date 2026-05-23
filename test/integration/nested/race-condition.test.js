/*
 * NestedTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerRaceConditionTests(makeNestedTransportPairFactory());
