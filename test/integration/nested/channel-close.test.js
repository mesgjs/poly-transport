/*
 * NestedTransport Channel Close Integration Tests
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerChannelCloseTests(makeNestedTransportPairFactory());
