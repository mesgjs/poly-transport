/*
 * SocketTransport Message Types Integration Tests
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { registerMessageTypeTests } from '../suites/message-types.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerMessageTypeTests(makeSocketTransportPair);
