/*
 * WebSocketTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerChannelCloseTests(makeWebSocketTransportPair);
