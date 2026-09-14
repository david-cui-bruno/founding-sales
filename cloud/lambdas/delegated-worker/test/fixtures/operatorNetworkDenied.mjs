/* global globalThis */
import { createRequire, syncBuiltinESMExports } from 'node:module';
const loadBuiltin = createRequire(import.meta.url);
// Test-only guard: Node 24 permissions do not themselves deny network access.
const deny = () => { process.stderr.write('OPERATOR_NETWORK_DENIED\n'); throw new Error('OPERATOR_NETWORK_DENIED'); };
for (const [module, methods] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:http2', ['connect']], ['node:net', ['connect', 'createConnection']],
  ['node:tls', ['connect']], ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ['node:dns/promises', ['lookup', 'resolve', 'resolve4', 'resolve6']],
]) for (const method of methods) loadBuiltin(module)[method] = deny;
loadBuiltin('node:net').Socket.prototype.connect = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
