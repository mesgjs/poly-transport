import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerMessageTypeTests(makeMessageTransportPair);
