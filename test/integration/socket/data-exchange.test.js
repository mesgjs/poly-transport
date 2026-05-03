/*
 * SocketTransport Data Exchange Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerDataExchangeTests(makeSocketTransportPair);
