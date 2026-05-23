/*
 * ByteTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerChannelCloseTests(makeByteTransportPair);
