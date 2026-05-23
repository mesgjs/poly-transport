/*
 * PostMessageTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerChannelCloseTests(makeMessageTransportPair);
