/*
 * SocketTransport (Unix) Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerSignalTests(makeUnixSocketTransportPair);
