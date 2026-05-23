/*
 * SocketTransport Data Exchange Integration Tests
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeSocketTransportPair } from '../../transport-socket-helpers.js';

registerDataExchangeTests(makeSocketTransportPair);
