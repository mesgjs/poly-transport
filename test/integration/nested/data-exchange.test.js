/*
 * NestedTransport Data Exchange Integration Tests
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerDataExchangeTests(makeNestedTransportPairFactory());
