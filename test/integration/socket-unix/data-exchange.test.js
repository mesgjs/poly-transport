import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerDataExchangeTests(makeUnixSocketTransportPair);
