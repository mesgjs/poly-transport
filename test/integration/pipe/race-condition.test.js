/*
 * PipeTransport Race Condition Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerRaceConditionTests(makePipeTransportPair);
