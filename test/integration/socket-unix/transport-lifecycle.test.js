import { registerTransportLifecycleTests } from '../suites/transport-lifecycle.suite.js';
import { makeUnixSocketTransportPair } from '../../transport-unix-helpers.js';

registerTransportLifecycleTests(makeUnixSocketTransportPair);
