/*
 * TcpTransport Data Exchange Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeTcpTransportPair } from '../../transport-tcp-helpers.js';

registerDataExchangeTests(makeTcpTransportPair);
