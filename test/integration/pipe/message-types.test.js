/*
 * PipeTransport Message Types Integration Tests
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerMessageTypeTests(makePipeTransportPair);
