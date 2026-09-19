/** Real startup/domain/SQL/registrars. Only OS and external transports are synthetic. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createOutreachProviders } from '../../src/main/outreach/providers/outreachProviders';
import { createEmailService } from '../../src/main/outreach/emailService';
import type { GeneratedDraft, GroundedDraftContext, SafeStorage } from '../../src/main/outreach/providers/providerTypes';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { createTempDatabase, createTestWorkspaceKey } from './tempDatabase';
import type { RegisteredIpcHandler } from './registeredIpcHandler';
import type { CompanyFact } from '../../src/main/research/companyFactExtraction';

type WireInput = { sources: { sourceId: string; blocks: { id: string; text: string; ref?: number }[] }[] };

export const localSetupClaims = {
  portfolio_description: 'Our residential portfolio includes apartments and single-family homes, but we do not publish a managed-unit count.',
  ownership: 'Selected Management is independently owned and operated.',
};
export const localSetupRelationship = 'Maya Ortiz is the property manager at Selected Management.';
export const localSetupPages: Record<string, string> = {
  'https://selected.invalid/': [...Object.values(localSetupClaims), localSetupRelationship].map(text => `<p>${text}</p>`).join(''),
};

export const firstUsePages: Record<string, string> = {
  'https://selected.invalid/': '<p>We manage 240 residential units.</p><p>Main office phone: +14015550100</p>',
  'https://selected.invalid/services': '<p>Residential property management.</p><p>Team email: office@selected.invalid</p>',
  'https://selected.invalid/team': '<p>Maya Ortiz is the property manager at Selected Management.</p>',
};
const allowed = new Set([
  'health:get', 'daily:get', 'local-workspace:get', 'local-workspace:get-commitments',
  'leads:list', 'lead-detail:get',
  'outreach:delegation-status', 'local-workspace:review-company', 'local-workspace:create-company',
  'local-workspace:company-create-status', 'local-workspace:get-company', 'local-workspace:get-company-draft', 'local-workspace:research-company',
  'local-workspace:company-research-status', 'local-workspace:link-company-person',
  'outreach:status', 'outreach:open-draft', 'outreach:save-draft', 'outreach:inspect-local-authority',
  'local-workspace:get-company-research-settings',
]);
export async function createFirstUseDomainFixture(handlers: Map<string, RegisteredIpcHandler>, options: {
  draftModel?: (context: GroundedDraftContext) => Pick<GeneratedDraft, 'subject' | 'body' | 'evidenceIds'>;
  /** Real public setup, no pairing/override or saved model. Old fixture modes are unchanged. */
  localResearchSetup?: boolean;
} = {}) {
  const temp = createTempDatabase();
  const key = randomBytes(32);
  const denied: string[] = [];
  const deny = (operation: string): never => { denied.push(operation); throw Error(`First-use fixture denies ${operation}`); };
  const safeStorage: SafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: bytes => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  const modelRequests: { url: string; context: GroundedDraftContext; model: string; store: boolean }[] = [];
  const extractionRequests: { model: string; store: boolean; input: WireInput; facts: CompanyFact[] }[] = [];
  const fixturePages = options.localResearchSetup ? localSetupPages : firstUsePages;
  const manager = createOutreachProviders({ directory: join(dirname(temp.path), 'outreach'), safeStorage,
    fetch: async (url, init) => {
      if ((!options.draftModel && !options.localResearchSetup) || url !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST'
        || typeof init.body !== 'string' || init.signal?.aborted) return deny('provider fetch');
      const request = JSON.parse(init.body);
      if (options.localResearchSetup && request.text?.format?.name === 'company_facts') {
        if (request.model !== 'gpt-4.1-mini-2025-04-14' || request.store !== false || request.tool_choice !== 'none'
          || JSON.stringify(request.tools) !== '[]' || request.max_output_tokens !== 2048 || init.redirect !== 'error') return deny('unexpected extraction request');
        const input: WireInput = JSON.parse(request.input);
        if (input.sources.length !== 1) return deny('unexpected extraction sources');
        const source = input.sources[0];
        const selections: { key: CompanyFact['key']; ref: number }[] = [];
        const facts = (Object.entries(localSetupClaims) as [CompanyFact['key'], string][]).map(([key, quote]) => {
          const matches = source.blocks.filter(item => item.text === quote && typeof item.ref === 'number');
          if (matches.length !== 1) return deny('missing unique whole extraction block');
          const block = matches[0];
          if (typeof block.ref !== 'number') return deny('missing extraction ref');
          selections.push({ key, ref: block.ref });
          return { key, sourceId: source.sourceId, blockId: block.id, quote };
        });
        extractionRequests.push({ model: request.model, store: request.store, input: structuredClone(input), facts });
        return new Response(JSON.stringify({ status: 'completed', model: request.model,
          output: [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify({ facts: selections }) }] }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.text?.format?.name !== 'grounded_email' || request.store !== false
        || request.model !== (options.localResearchSetup ? 'gpt-4.1-mini-2025-04-14' : 'first-use-fixture-model')
        || !options.draftModel) return deny('unexpected model request');
      const context: GroundedDraftContext = JSON.parse(request.input);
      modelRequests.push({ url, context: structuredClone(context), model: request.model, store: request.store });
      const draft = options.draftModel(context);
      return new Response(JSON.stringify({ id: 'first_use_response', status: 'completed', model: request.model,
        output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(draft) }] }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }, openExternal: async () => deny('openExternal') });
  const pages: string[] = [], resolutions: string[] = [];
  const trace: { channel: string; args: unknown[]; result?: unknown; error?: unknown }[] = [];
  const pending = new Set<Promise<unknown>>();
  let runtime!: FoundationRuntime;
  let domainRuntime: DomainRuntime | undefined;
  const limits = { maxCompanies: 1, maxPages: 3, maxBytes: 10000, maxCostMicros: 100 };
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(), prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: database => {
      domainRuntime = new DomainRuntime({ database, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } });
      return domainRuntime;
    },
    createHealthService: options => new HealthService(options),
    registerApplicationIpc: (...args) => { runtime = args[0]; return registerApplicationIpc(...args); },
    registerOutreachIpc,
    createResearchProviders: () => manager,
    createEmailService: (gate, _path, providers) => {
      if (!providers) throw Error('Startup must lend its real provider manager');
      return createEmailService({ databaseGate: gate, providers });
    },
    companyResearchResolve: async hostname => {
      resolutions.push(hostname);
      if (hostname !== 'selected.invalid') return deny(`DNS ${hostname}`);
      return ['93.184.216.34'];
    },
    companyResearchHttp: async input => {
      if (!Object.hasOwn(fixturePages, input.url) || input.address !== '93.184.216.34' || input.signal.aborted) return deny(`PageHttp ${input.url}`);
      pages.push(input.url);
      return new Response(fixturePages[input.url], { headers: { 'content-type': 'text/html' } });
    },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
      createBackup: async () => deny('backup'), listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: async () => deny('recovery'), beginSetup: async () => deny('recovery'),
      saveSetupMaterial: async () => deny('recovery'), completeSetup: async () => deny('recovery'),
      selectAndRunRestoreDrill: async () => deny('restore'), shutdown: async () => undefined }),
    createAppleBridgeSupervisor: () => deny('Apple bridge'),
  };
  try {
    mkdirSync(dirname(temp.path), { recursive: true, mode: 0o700 });
    if (options.draftModel && !options.localResearchSetup) await manager.configure({ apiKey: 'synthetic-first-use-key', model: 'first-use-fixture-model' });
    const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path),
      ...(options.localResearchSetup ? {} : { companyResearch: { workspaceId: 'first-use-fixture', budgetId: 'first-use-budget',
        audience: { residential: true, regions: ['Fictional Region'], terms: ['residential PM'] },
        discoveryLimits: limits, researchLimits: limits,
        capability: { model: 'unused-fixture-model', webSearch: true, searchCostMicros: 50, modelCostMicros: 50 },
        maxAccountBudgetMicros: 1000, permittedSources: Object.keys(firstUsePages) } }),
      createWindow: () => undefined }, dependencies);
    const api = createCallieApi({ invoke: (channel, ...args) => {
      const entry: typeof trace[number] = { channel, args: structuredClone(args) }; trace.push(entry);
      const promise = (async () => {
        const setupReadOrSave = options.localResearchSetup && ['outreach:configure',
          'outreach:google-connection-status', 'outreach:google-connection-disclosure',
          'local-workspace:get-company-research-settings', 'local-workspace:update-company-research-settings'].includes(channel);
        if (!allowed.has(channel) && !setupReadOrSave) return deny(`IPC ${channel}`);
        const handler = handlers.get(channel);
        if (!handler) throw Error(`Missing production registrar: ${channel}`);
        try { const result = await handler({ senderFrame: { url: 'callie://app/index.html' } }, ...args); entry.result = structuredClone(result); return result; }
        catch (error) { entry.error = error; throw error; }
      })();
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    } });
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('First-use fixture did not drain within 5 seconds')), 5000);
      })]); } finally { clearTimeout(timer!); }
    };
    const drain = () => bounded((async () => { while (pending.size) await Promise.allSettled([...pending]); })());
    // Exactly the initialized graph, for the person seeding the removed importer used to perform.
    const services = () => { if (!domainRuntime) throw Error('First-use fixture has no domain runtime yet'); return domainRuntime.getServices(); };
    return { api, runtime, services, trace, pages, resolutions, modelRequests, extractionRequests, denied, deny, drain, directory: dirname(temp.path),
      async close() {
        try { await drain(); }
        finally {
          try { await bounded(app.shutdown()); }
          finally { key.fill(0); temp.cleanup(); }
        }
      },
    };
  } catch (error) { manager.dispose(); key.fill(0); temp.cleanup(); throw error; }
}
