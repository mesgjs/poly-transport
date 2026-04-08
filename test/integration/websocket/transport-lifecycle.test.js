/*
 * WebSocketTransport Transport Lifecycle Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerTransportLifecycleTests(makeWebSocketTransportPair);
