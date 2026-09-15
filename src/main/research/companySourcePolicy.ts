import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { parseCompanyPageText } from './companyPageText';
import { accountSourceSchema, type AccountSource } from '../../shared/contracts/accountContract';

/** Conservative public-address allowlist. IPv6 is denied until a fully pinned IPv6 policy exists. */
export function publicResearchAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  if (a === undefined || b === undefined) return false;
  return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b))
    && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
}
export function companySourcePolicy(value: string): 'candidate' | 'manual_only' | 'blocked' {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !host.includes('.') || host.includes(':') || host.endsWith('.local') || host.endsWith('.localhost')
      || (isIP(host) !== 0 && !publicResearchAddress(host))) return 'blocked';
    if (host === 'narpm.org' || host.endsWith('.narpm.org')) return 'blocked';
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'manual_only';
    return 'candidate';
  } catch { return 'blocked'; }
}
const fingerprint = (accountId: string, source: AccountSource) => createHash('sha256').update(JSON.stringify([accountId, source.id, source.url, source.fetchedAt, source.sha256, source.excerpt, source.permitted])).digest('hex');
/** Main/worker composition capability, never a model/IPC permission flag. Receipts are
 * issued only by the bounded page adapter after permitted, pinned successful HTTP.
 * Admission checks exact account, byte hash, timestamp and excerpt. Restart settlement
 * uses committed SQL receipts and does not need to reconstruct this ephemeral ledger. */
export function createFetchedReceiptPolicy() {
  const issued = new Set<string>();
  return {
    recordFetched(input: { accountId: string; url: string; fetchedAt: string; body: Uint8Array; excerpt: string }): AccountSource {
      if (companySourcePolicy(input.url) !== 'candidate' || !Buffer.from(input.body).toString('utf8').includes(input.excerpt)) throw new Error('Invalid fetched receipt');
      const source = accountSourceSchema.parse({ id: randomUUID(), url: input.url, fetchedAt: input.fetchedAt,
        sha256: createHash('sha256').update(input.body).digest('hex'), excerpt: input.excerpt, permitted: true });
      issued.add(fingerprint(input.accountId, source));
      return source;
    },
    /** Parsed excerpts are independently reproduced from the fetched bytes, not
     * accepted from a model. Raw-body SHA remains the provenance identity. */
    recordParsedFetched(input: { accountId: string; url: string; fetchedAt: string; body: Uint8Array; contentType: string }): AccountSource {
      if (companySourcePolicy(input.url) !== 'candidate') throw new Error('Invalid fetched receipt');
      const parsed = parseCompanyPageText(input.body, input.contentType);
      const source = accountSourceSchema.parse({ id: randomUUID(), url: input.url, fetchedAt: input.fetchedAt,
        sha256: createHash('sha256').update(input.body).digest('hex'), excerpt: parsed.text, permitted: true });
      issued.add(fingerprint(input.accountId, source));
      return source;
    },
    attest(source: Readonly<AccountSource>, accountId: string): boolean { return issued.has(fingerprint(accountId, source)); },
  };
}
export type FetchedReceiptPolicy = ReturnType<typeof createFetchedReceiptPolicy>;
