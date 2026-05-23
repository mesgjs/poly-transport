/*
 * PostMessageTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerTransportLifecycleTests(makeMessageTransportPair);
