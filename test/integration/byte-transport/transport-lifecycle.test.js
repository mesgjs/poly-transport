/*
 * ByteTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerTransportLifecycleTests(makeByteTransportPair);
