/*
 * TcpTransport Race Condition Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerRaceConditionTests } from '../suites/race-condition.suite.js';
import { makeTcpTransportPair } from '../../transport-tcp-helpers.js';

registerRaceConditionTests(makeTcpTransportPair);
