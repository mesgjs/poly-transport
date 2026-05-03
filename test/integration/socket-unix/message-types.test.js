import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerMessageTypeTests(makeUnixSocketTransportPair);
