/*
 * PipeTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerChannelCloseTests(makePipeTransportPair);
