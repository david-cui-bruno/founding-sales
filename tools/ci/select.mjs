// Required gate policy: input is every changed path, including deleted paths.
import { readFileSync } from 'node:fs';
const paths = readFileSync(0, 'utf8').split(/\r?\n/u).filter(Boolean);
const all = ['contracts', 'domain', 'api', 'worker', 'desktop', 'ops', 'ask-evaluation'];
const selected = new Set(['ops']);
const reasons = [];
let broad = process.argv.includes('--main') || paths.length === 0;
let upgrade = false;
if (broad) reasons.push(process.argv.includes('--main') ? 'main: broad regression' : 'uncertain or empty change inventory');
for (const path of paths) {
  if (/^packages\/domain\/db\/(migrations\/|schemaRange\.ts)/u.test(path) || path === '.gitattributes') upgrade = true;
  if (/^(docs\/|.*\.md$)/u.test(path)) reasons.push('documentation: operations contract checks');
  else if (path.startsWith('apps/api/')) {
    ['domain', 'api', 'desktop'].forEach(suite => selected.add(suite));
    reasons.push('API: domain controls and desktop consumer');
  } else if (path.startsWith('apps/worker/')) {
    ['domain', 'api', 'worker'].forEach(suite => selected.add(suite));
    reasons.push('worker: domain controls and API-owned configured provider journeys');
  } else if (path.startsWith('apps/desktop/')) {
    ['domain', 'desktop'].forEach(suite => selected.add(suite));
    reasons.push('desktop: domain controls');
  } else {
    broad = true;
    reasons.push(`shared, unknown or selector path: ${path}`);
  }
}
console.log(JSON.stringify({ broad, suites: broad ? all : all.filter(suite => selected.has(suite)), upgrade, reasons: [...new Set(reasons)] }));
