/*
 * PostMessageTransport Transport Lifecycle Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerTransportLifecycleTests(makeMessageTransportPair);
