/*
 * NestedTransport Message Types Integration Tests
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerMessageTypeTests(makeNestedTransportPairFactory());
