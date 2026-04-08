/*
 * WebSocketTransport Data Exchange Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerDataExchangeTests(makeWebSocketTransportPair);
