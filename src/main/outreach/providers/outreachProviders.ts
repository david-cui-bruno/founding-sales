import { requestCompanyFacts } from '../../research/companyFactExtraction';
import { requestCompanyDiscovery } from '../../research/companyDiscoveryProvider';
import { z } from 'zod';
import type { CompanyResearchModelProvider, OutreachProviders, OutreachProviderOptions, OutreachStatus, StoredCredentials } from './providerTypes';
import { CredentialStore } from './credentialStore';
import { authorizeGoogle } from './googleOAuth';
import { generateOpenAiDraft } from './openAiDraftProvider';
import { createPreparedGmailSender, refreshGmailToken } from './gmailProvider';
import { fail, ProviderError, safeError, storedCredentialsSchema } from './providerValidation';

const configureSchema = z.object({
  apiKey: storedCredentialsSchema.shape.model.shape.apiKey.optional(),
  model: storedCredentialsSchema.shape.model.shape.model.optional(),
  googleClientId: z.union([z.literal(''), z.string().max(500).regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/)]).optional(),
  googleClientSecret: storedCredentialsSchema.shape.gmail.shape.clientSecret.optional(),
  senderName: storedCredentialsSchema.shape.senderName.optional(),
  postalAddress: storedCredentialsSchema.shape.postalAddress.optional(),
}).strict();
const empty = (): StoredCredentials => ({ model: { apiKey: '', model: '' },
  gmail: { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0, email: '' },
  senderName: '', postalAddress: '' });

/** One manager per immutable workspace runtime. No eager reads, HTTP, OAuth or
 * background reconnect. Mutations serialize, epochs invalidate synchronously.
 */
export function createOutreachProviders(options: OutreachProviderOptions): OutreachProviders & CompanyResearchModelProvider & { invalidate(): void } {
  const store = new CredentialStore({ directory: options.directory, safeStorage: options.safeStorage });
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let epoch = 0;
  let lifetime = new AbortController();
  let disposed = false;
  let reauthorize = false;
  let tail: Promise<unknown> = Promise.resolve();
  function assertCurrent(expected: number): void {
    if (disposed || epoch !== expected) fail('provider_invalidated');
  }
  function invalidate(): number {
    epoch++;
    lifetime.abort();
    lifetime = new AbortController();
    return epoch;
  }
  function serial<T>(expected: number, operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      assertCurrent(expected);
      try { return await operation(); } catch (error) { throw safeError(error, 'provider_response_invalid'); }
    });
    tail = result.catch((): undefined => undefined);
    return result;
  }
  function describe(value: StoredCredentials): OutreachStatus {
    return { model: value.model.apiKey && value.model.model ? 'ready' : 'unconfigured', modelName: value.model.model,
      gmail: reauthorize ? 'reauthorize' : value.gmail.clientId && value.gmail.refreshToken && value.gmail.email ? 'ready' : 'unconfigured',
      accountEmail: value.gmail.email || null, senderName: value.senderName, postalAddress: value.postalAddress };
  }
  function status(): Promise<OutreachStatus> {
    const expected = epoch;
    return serial(expected, async () => {
      const value = await store.load() ?? empty();
      assertCurrent(expected);
      return describe(value);
    }).catch((error): OutreachStatus => {
      const state = error instanceof ProviderError && ['credentials_locked', 'provider_invalidated'].includes(error.code) ? 'locked' : 'error';
      return { model: state, modelName: '', gmail: state, accountEmail: null, senderName: '', postalAddress: '' };
    });
  }
  return {
    status,
    configure(raw) {
      const parsed = configureSchema.safeParse(raw);
      if (!parsed.success) return Promise.reject(new ProviderError('invalid_configuration'));
      const expected = invalidate();
      return serial(expected, async () => {
        const value = await store.load() ?? empty();
        assertCurrent(expected);
        const input = parsed.data;
        const clientChanged = (input.googleClientId !== undefined && input.googleClientId !== value.gmail.clientId)
          || (input.googleClientSecret !== undefined && input.googleClientSecret !== value.gmail.clientSecret);
        const gmail = clientChanged ? { ...empty().gmail, clientId: value.gmail.clientId, clientSecret: value.gmail.clientSecret } : value.gmail;
        const updated: StoredCredentials = {
          model: { apiKey: input.apiKey ?? value.model.apiKey, model: input.model ?? value.model.model },
          gmail: { ...gmail, clientId: input.googleClientId ?? gmail.clientId, clientSecret: input.googleClientSecret ?? gmail.clientSecret },
          senderName: input.senderName ?? value.senderName, postalAddress: input.postalAddress ?? value.postalAddress,
        };
        await store.save(updated, () => assertCurrent(expected));
        assertCurrent(expected);
        if (clientChanged) reauthorize = false;
        return describe(updated);
      });
    },
    connectGmail() {
      const expected = invalidate();
      const signal = lifetime.signal;
      return serial(expected, async () => {
        const value = await store.load() ?? empty();
        assertCurrent(expected);
        if (!value.gmail.clientId) fail('gmail_unconfigured');
        const gmail = await authorizeGoogle({ clientId: value.gmail.clientId, clientSecret: value.gmail.clientSecret,
          openExternal: options.openExternal, fetch: fetcher, signal, now });
        assertCurrent(expected);
        const updated = { ...value, gmail };
        await store.save(updated, () => assertCurrent(expected));
        assertCurrent(expected);
        reauthorize = false;
        return describe(updated);
      });
    },
    disconnectGmail() {
      const expected = invalidate();
      return serial(expected, async () => {
        const value = await store.load() ?? empty();
        assertCurrent(expected);
        const updated = { ...value, gmail: { ...empty().gmail, clientId: value.gmail.clientId, clientSecret: value.gmail.clientSecret } };
        await store.save(updated, () => assertCurrent(expected));
        assertCurrent(expected);
        reauthorize = false;
        return describe(updated);
      });
    },
    async generate(context, callerSignal) {
      const expected = epoch;
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      const value = await serial(expected, async () => {
        const stored = await store.load() ?? empty(); assertCurrent(expected); return stored;
      });
      if (signal.aborted) fail('provider_invalidated');
      const result = await generateOpenAiDraft({ credentials: value.model, context, signal, fetch: fetcher });
      assertCurrent(expected);
      return result;
    },
    async researchCompanyFacts(input, callerSignal) {
      const expected = epoch;
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      try {
        const value = await serial(expected, async () => {
          const stored = await store.load() ?? empty(); assertCurrent(expected); return stored;
        });
        if (signal.aborted) fail('provider_invalidated');
        const result = await requestCompanyFacts({ input, credentials: value.model, signal, fetch: fetcher });
        assertCurrent(expected);
        if (signal.aborted) fail('provider_invalidated');
        return result;
      } catch (error) { throw safeError(error, 'provider_response_invalid'); }
    },
    async researchCompanies(input, callerSignal) {
      const expected = epoch;
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      try {
        const value = await serial(expected, async () => {
          const stored = await store.load() ?? empty(); assertCurrent(expected); return stored;
        });
        if (signal.aborted) fail('provider_invalidated');
        const result = await requestCompanyDiscovery({ ...input, credentials: value.model, signal, fetch: fetcher });
        assertCurrent(expected);
        if (signal.aborted) fail('provider_invalidated');
        return result;
      } catch (error) { throw safeError(error, 'provider_response_invalid'); }
    },
    prepare(callerSignal) {
      const expected = epoch;
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      return serial(expected, async () => {
        const value = await store.load() ?? empty();
        assertCurrent(expected);
        if (signal.aborted) fail('provider_invalidated');
        if (!value.gmail.clientId || !value.gmail.refreshToken || !value.gmail.email) fail('gmail_unconfigured');
        if (reauthorize) fail('gmail_reauthorize');
        let gmail = value.gmail;
        if (!gmail.accessToken || gmail.expiresAt <= now() + 60000) {
          try { gmail = await refreshGmailToken({ credentials: gmail, fetch: fetcher, signal, now }); }
          catch (error) {
            if (error instanceof ProviderError && error.code === 'gmail_reauthorize' && epoch === expected) reauthorize = true;
            throw error;
          }
          assertCurrent(expected);
          if (signal.aborted) fail('provider_invalidated');
          await store.save({ ...value, gmail }, () => {
            assertCurrent(expected);
            if (signal.aborted) fail('provider_invalidated');
          });
          assertCurrent(expected);
        }
        return createPreparedGmailSender({ accountEmail: gmail.email, accessToken: gmail.accessToken, fetch: fetcher, signal,
          isCurrent: () => !disposed && epoch === expected && gmail.expiresAt > now() + 1000 });
      });
    },
    invalidate() { if (!disposed) invalidate(); },
    dispose() { if (disposed) return; disposed = true; invalidate(); },
  };
}
