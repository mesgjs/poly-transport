/*
 * TcpTransport Message Types Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeTcpTransportPair } from '../../transport-tcp-helpers.js';

registerMessageTypeTests(makeTcpTransportPair);
