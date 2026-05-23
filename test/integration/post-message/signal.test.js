/*
 * PostMessageTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerSignalTests(makeMessageTransportPair);
