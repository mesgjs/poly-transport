/*
 * ByteTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerSignalTests(makeByteTransportPair);
