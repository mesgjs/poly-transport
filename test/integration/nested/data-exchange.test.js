/*
 * NestedTransport Data Exchange Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerDataExchangeTests(makeNestedTransportPairFactory());
