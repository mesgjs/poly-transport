/*
 * WebSocketTransport Channel Close Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerChannelCloseTests } from '../suites/channel-close.suite.js';
import { makeWebSocketTransportPair } from '../../transport-websocket-helpers.js';

registerChannelCloseTests(makeWebSocketTransportPair);
