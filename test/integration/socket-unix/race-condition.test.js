import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerRaceConditionTests(makeUnixSocketTransportPair);
