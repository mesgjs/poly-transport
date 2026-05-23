/*
 * SocketTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerChannelCloseTests(makeSocketTransportPair);
