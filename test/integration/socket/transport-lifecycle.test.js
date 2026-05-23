/*
 * SocketTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerTransportLifecycleTests(makeSocketTransportPair);
