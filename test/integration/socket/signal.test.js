/*
 * SocketTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerSignalTests(makeSocketTransportPair);
