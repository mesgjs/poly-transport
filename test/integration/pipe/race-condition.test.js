/*
 * PipeTransport Race Condition Integration Tests
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerRaceConditionTests(makePipeTransportPair);
