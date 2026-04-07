import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerMessageTypeTests(makeByteTransportPair);
