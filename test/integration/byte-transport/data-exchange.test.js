import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeByteTransportPair } from '../helpers.js';

registerDataExchangeTests(makeByteTransportPair);
