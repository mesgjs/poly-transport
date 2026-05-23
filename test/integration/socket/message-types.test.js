/*
 * SocketTransport Message Types Integration Tests
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerMessageTypeTests(makeSocketTransportPair);
