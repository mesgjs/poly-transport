/*
 * NestedTransport Transport Lifecycle Integration Tests
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerTransportLifecycleTests(makeNestedTransportPairFactory());
