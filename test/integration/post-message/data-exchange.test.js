import { registerDataExchangeTests } from '../suites/data-exchange.suite.js';
import { makeMessageTransportPair } from '../helpers.js';

registerDataExchangeTests(makeMessageTransportPair);
