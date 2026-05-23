/*
 * PipeTransport Signal Integration Tests
 */

import { registerSignalTests } from '../suites/signal.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerSignalTests(makePipeTransportPair);
