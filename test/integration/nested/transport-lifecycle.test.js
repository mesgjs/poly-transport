/*
 * NestedTransport Transport Lifecycle Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeNestedTransportPairFactory } from '../../transport-nested-helpers.js';

registerTransportLifecycleTests(makeNestedTransportPairFactory());
