/*
 * PipeTransport Data Exchange Integration Tests
 */

import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makePipeTransportPair } from '../../transport-pipe-helpers.js';

registerDataExchangeTests(makePipeTransportPair);
