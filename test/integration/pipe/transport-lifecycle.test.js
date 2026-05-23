/*
 * PipeTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerTransportLifecycleTests(makePipeTransportPair);
