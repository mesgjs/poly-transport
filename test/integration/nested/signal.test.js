/*
 * NestedTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerSignalTests(makeNestedTransportPairFactory());
