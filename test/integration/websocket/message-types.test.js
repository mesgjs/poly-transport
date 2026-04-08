/*
 * WebSocketTransport Message Types Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerMessageTypeTests(makeWebSocketTransportPair);
