import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerChannelCloseTests(makeUnixSocketTransportPair);
