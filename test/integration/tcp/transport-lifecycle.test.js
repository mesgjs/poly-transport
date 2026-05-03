/*
 * TcpTransport Transport Lifecycle Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeTcpTransportPair } from '../../transport-tcp-helpers.js';

registerTransportLifecycleTests(makeTcpTransportPair);
