import { AccountPreparationReadError, readAccountPreparation } from './accountPreparationRead';
import { ACCOUNT_PREPARATION_MAX_REQUEST_BYTES, ACCOUNT_PREPARATION_MAX_REPLY_BYTES } from '../../../../src/shared/contracts/accountPreparationContract';
import { parseResearchCycle, type ResearchCycleAdmission, type ResearchCycleAdmissionResult, type ResearchCycleStatusRequest, type ResearchCycleExecuteRequest, type ResearchCycleStatusResult, type ResearchCycleResult } from './researchCycleContract';
import { executeResearchCycle } from './researchCycle';
import { admitResearchOnceNext, executeResearchOnce, productionResearchBoundaries, researchProfile } from './researchProduction';
import { parseResearchOnce, type ResearchOnceRequest, type ResearchOnceResult, type ResearchOnceNextRequest, type ResearchOnceNextResult } from './researchOnceContract';
import { ResearchSetupService, type ResearchSetupProfile } from './researchSetup';
import {WorkerPolicyConfiguration} from './policyConfiguration';
import type { PageHttp } from '../../../../src/main/research/companyPageProvider';
import { createSourceCoordinator } from './sourceCoordinator';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient, type GetParameterCommandOutput } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { delegationCommandSchema } from '../../../../src/shared/contracts/delegationContract';
import { bootstrapSelectedAccountCommandSchema, ownerCommandSchema } from '../../../../src/shared/contracts/ownerCommandContract';
import { OwnerCommandCoordinator } from './ownerCommandCoordinator';
import { WorkerAuth } from './workerAuth';
import { DynamoExecutionRepository } from './executionRepository';
import { RemoteGoogleAuthorization, type RemoteGoogleConfig } from './remoteGoogleAuthorization';
import { googleGrantDisclosure, googleGrantPurposeSchema, personalGoogleGrantDisclosure } from './googleGrantCapabilities';
import { remoteGoogleGrantBeginSchema, remoteGoogleGrantSelectorSchema } from '../../../../src/shared/contracts/remoteGoogleGrantContract';
import { DynamoReadUnavailable, type DynamoAdapter } from './dynamoStore';
export type WorkerHttpResponse = { statusCode: number; body: string; headers: Record<string, string> };
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Strict-Transport-Security': 'max-age=31536000', 'X-Content-Type-Options': 'nosniff' };
const response = (statusCode: number, body: unknown): WorkerHttpResponse => ({ statusCode, body: JSON.stringify(body), headers });
// A persisted predecessor is bounded by the existing 390KB Dynamo item limit.
// JSON-escaped subject/body add at most 6*(240+20000) bytes, plus a small
// workspace/revision envelope. 1MiB bounds that combined ordinary-only request.
const ordinaryReplyEnvelopeMaxBytes = 1024 * 1024;
const eventSchema = z.object({ version: z.literal('2.0'), rawPath: z.string().max(100), rawQueryString: z.string().max(8192),
  headers: z.record(z.string(), z.string().max(16384)), body: z.string().max(ordinaryReplyEnvelopeMaxBytes).refine(value => Buffer.byteLength(value, 'utf8') <= ordinaryReplyEnvelopeMaxBytes).optional(), isBase64Encoded: z.literal(false).optional(),
  requestContext: z.object({ domainName: z.string(), http: z.object({ method: z.enum(['POST', 'GET']), sourceIp: z.string().min(1).max(256) }) }) })
  .refine(event => !event.body || Buffer.byteLength(event.body, 'utf8') <= (event.rawPath === '/reply/draft' && event.requestContext.http.method === 'POST' ? ordinaryReplyEnvelopeMaxBytes : 204096));
/** API Gateway v2 HTTPS only. No authorizer cache, event logging, query bearer,
 * operator bootstrap issuance, token-returning route or mail dispatch endpoint. */
export function createWorkerHandler(input: { auth: WorkerAuth; host: string; google?: RemoteGoogleAuthorization; researchSetupProfile?: ResearchSetupProfile }) {
  return async (raw: unknown): Promise<WorkerHttpResponse> => {
    try {
      const event = eventSchema.parse(raw);
      if (event.headers['x-forwarded-proto'] !== 'https' || event.headers.host !== input.host || event.requestContext.domainName !== input.host) return response(400, { error: 'worker_invalid_request' });
      const method = event.requestContext.http.method; const path = event.rawPath;
      if (path === '/accounts/preparation' && event.body && Buffer.byteLength(event.body, 'utf8') > ACCOUNT_PREPARATION_MAX_REQUEST_BYTES) return response(400, { error: 'worker_invalid_request' });
      // All other requests retain their existing limits. Only selected bootstrap
      // and the bounded prior+next ordinary draft envelope get larger bodies.
      if (event.body && Buffer.byteLength(event.body, 'utf8') > 65536 && !(path === '/reply/draft' && method === 'POST')) {
        if (path !== '/commands' || method !== 'POST') return response(400, { error: 'worker_request_rejected' });
        const selected = bootstrapSelectedAccountCommandSchema.parse(JSON.parse(event.body));
        if (Buffer.byteLength(JSON.stringify(selected.payload), 'utf8') > 200000) return response(400, { error: 'worker_request_rejected' });
      }
      const query = new URLSearchParams(event.rawQueryString);
      const allowed = path === '/oauth/callback' ? ['state', 'code', 'error', 'scope', 'authuser', 'prompt', 'hd'] : path === '/events' ? ['cursor'] : ['/google/status', '/google/disclosure'].includes(path) ? ['purpose'] : [];
      for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) return response(400, { error: 'worker_invalid_request' });
      const body = () => JSON.parse(event.body ?? '{}') as unknown;
      if (path === '/accounts/preparation' && method === 'POST') {
        let request: unknown;
        try { request = body(); } catch { return response(400, { error: 'worker_invalid_request' }); }
        try {
          const result = await readAccountPreparation(input.auth, request, event.headers.authorization);
          const reply = response(200, result);
          if (Buffer.byteLength(reply.body, 'utf8') > ACCOUNT_PREPARATION_MAX_REPLY_BYTES) return response(503, { error: 'worker_unavailable' });
          return reply;
        } catch (error) {
          return error instanceof AccountPreparationReadError ? response(error.statusCode, { error: error.code }) : response(503, { error: 'worker_unavailable' });
        }
      }
      if (path === '/pairing/redeem' && method === 'POST') {
        const parsed = z.strictObject({ code: z.string().max(128) }).parse(body());
        return response(200, await input.auth.redeemPairing(parsed.code, event.requestContext.http.sourceIp));
      }
      if (path === '/oauth/callback' && method === 'GET') {
        if (!input.google || !query.has('state') || query.has('code') === query.has('error')) return response(400, { error: 'worker_invalid_request' });
        await input.google.completeGoogleGrant(query.get('state')!, query.has('error') ? null : query.get('code'));
        return { statusCode: 200, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Authorization completed. Return to FSS.' };
      }
      if(path==='/policies/configure' && method==='POST') return response(200,await new WorkerPolicyConfiguration({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})}).apply(body(),event.headers.authorization??''));
      if(path==='/commands/reconcile' && method==='POST') {
        const owner=new OwnerCommandCoordinator({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})});
        return response(200,await owner.reconcile(body(),event.headers.authorization??''));
      }
      if (path === '/reply/draft' && method === 'POST') {
        const owner = new OwnerCommandCoordinator({ auth: input.auth, authorization: input.google ?? new RemoteGoogleAuthorization({ auth: input.auth }) });
        return response(200, await owner.replyDraft(body(), event.headers.authorization ?? ''));
      }
      if(path==='/requested-followup/draft' && method==='POST') {
        const owner=new OwnerCommandCoordinator({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})});
        return response(200,await owner.requestedDraft(body(),event.headers.authorization??''));
      }
      if(path==='/requested-followup/context' && method==='POST') {
        const owner=new OwnerCommandCoordinator({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})});
        return response(200,await owner.requestedContext(body(),event.headers.authorization??''));
      }
      if(path==='/readiness' && method==='POST') {
        const owner=new OwnerCommandCoordinator({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})});
        return response(200,await owner.checkpoint(body(),event.headers.authorization??'',AbortSignal.timeout(15000)));
      }
      if (method === 'POST' && ['/research/setup/status', '/research/setup'].includes(path)) {
        const setup = new ResearchSetupService({ auth: input.auth, profile: input.researchSetupProfile });
        return response(200, path === '/research/setup/status' ? await setup.status(body(), event.headers.authorization ?? '') : await setup.apply(body(), event.headers.authorization ?? ''));
      }
      if(path==='/research/configure' && method==='POST') {
        const owner=new OwnerCommandCoordinator({auth:input.auth,authorization:input.google??new RemoteGoogleAuthorization({auth:input.auth})});
        return response(200,await owner.configureResearch(body(),event.headers.authorization??''));
      }
      if ((path === '/commands' || path === '/emergency') && method === 'POST') {
        const principal = await input.auth.authenticate(event.headers.authorization, [path === '/emergency' ? 'emergency:stop' : 'commands:write']);
        const rawCommand = body();
        if (path === '/emergency' && (!rawCommand || typeof rawCommand !== 'object' || !['pause', 'revoke'].includes(String((rawCommand as { kind?: unknown }).kind)))) return response(403, { error: 'worker_scope_denied' });
        const command = path === '/emergency' ? await input.auth.emergencyCommand(principal, rawCommand) : delegationCommandSchema.parse(rawCommand);
        input.auth.store.workspace(command.workspaceId);
        if (path === '/emergency' && command.kind !== 'pause' && command.kind !== 'revoke') return response(403, { error: 'worker_scope_denied' });
        if (path === '/commands' && ownerCommandSchema.safeParse(command).success) {
          const owner = new OwnerCommandCoordinator({ auth: input.auth, authorization: input.google ?? new RemoteGoogleAuthorization({ auth: input.auth }) });
          return response(200, await owner.apply(command, event.headers.authorization!));
        }
        const repository = new DynamoExecutionRepository({ ...input.auth.options, dynamo: input.auth.fencedDynamo(principal) });
        return response(200, await repository.applyCommand(command));
      }
      if (path === '/events' && method === 'GET') {
        const principal = await input.auth.authenticate(event.headers.authorization, ['events:read']);
        const repository = new DynamoExecutionRepository({ ...input.auth.options, dynamo: input.auth.fencedDynamo(principal) });
        return response(200, await repository.eventsAfter(query.get('cursor')));
      }
      if (path === '/pairing/revoke' && method === 'POST') {
        const principal = await input.auth.authenticate(event.headers.authorization, ['pairing:revoke']);
        z.strictObject({}).parse(body()); await input.auth.revokePairing(principal.pairingId);
        return response(200, { state: 'revoked' });
      }
      if (['/google/begin', '/google/status', '/google/revoke', '/google/disclosure'].includes(path)) {
        const principal = await input.auth.authenticate(event.headers.authorization, ['google:grant']);
        const purpose = googleGrantPurposeSchema.parse(query.get('purpose') ?? 'permitted_correspondence');
        if (path === '/google/disclosure' && method === 'GET') return response(200, purpose === 'personal_availability' ? personalGoogleGrantDisclosure : googleGrantDisclosure);
        if (!input.google) return response(503, { error: 'google_unconfigured' });
        if (path === '/google/begin' && method === 'POST') {
          const parsed = remoteGoogleGrantBeginSchema.parse(body());
          return response(200, parsed.purpose === 'personal_availability'
            ? await input.google.beginGoogleGrant(principal.pairingId, parsed.capabilities, undefined, { purpose: parsed.purpose, availabilityCalendars: parsed.availabilityCalendars })
            : await input.google.beginGoogleGrant(principal.pairingId, parsed.capabilities, parsed.calendars, { purpose: 'permitted_correspondence', ...(parsed.expectedEmail ? { expectedEmail: parsed.expectedEmail } : {}) }));
        }
        if (path === '/google/status' && method === 'GET') return response(200, await input.google.status(principal.pairingId, purpose));
        if (path === '/google/revoke' && method === 'POST') { const selected = remoteGoogleGrantSelectorSchema.parse(body()); return response(200, await input.google.revokeGoogleGrant(principal.pairingId, selected.purpose ?? 'permitted_correspondence')); }
      }
      return response(404, { error: 'worker_route_unavailable' });
    } catch (error) {
      // Deliberately never interpolate exception, provider payload, URL or event.
      if (error instanceof DynamoReadUnavailable) return response(503, { error: 'worker_unavailable' });
      const code = error instanceof Error ? error.message : '';
      if (code === 'worker_unauthorized') return response(401, { error: 'worker_unauthorized' });
      if (code === 'worker_scope_denied') return response(403, { error: 'worker_scope_denied' });
      if (code === 'pairing_rate_limited') return response(429, { error: 'pairing_rate_limited' });
      return response(400, { error: 'worker_request_rejected' });
    }
  };
}
export type ProductionBoundaries = { dynamo?: DynamoAdapter; ssm?: { send(command: GetParameterCommand, options?: { abortSignal: AbortSignal }): Promise<GetParameterCommandOutput> }; fetch?: typeof globalThis.fetch; pageHttp?: PageHttp; resolve?: (hostname:string)=>Promise<string[]> };
/** Same factory serves Lambda and explicitly authorized operator bootstrap.
 * The default/partial environment is inert. Tests replace SDK/provider I/O only. */
export async function createProductionServices(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries = {}) {
  if (env.DELEGATED_WORKER_ENABLED !== 'true') return null;
  const config = z.object({ DELEGATED_WORKER_TABLE: z.string().min(1), DELEGATED_WORKSPACE_ID: z.string().min(1),
    DELEGATED_WORKER_HOST: z.string().regex(/^[a-zA-Z0-9.-]+$/), AWS_REGION: z.string().min(1) }).parse(env);
  const googleVars = [env.DELEGATED_GOOGLE_CLIENT_ID, env.DELEGATED_GOOGLE_SECRET_PARAMETER, env.DELEGATED_GOOGLE_KEY_PARAMETER];
  if (googleVars.some(Boolean) && !googleVars.every(Boolean)) throw new Error('google_unconfigured');
  const dynamo = boundaries.dynamo ?? new DynamoDBClient({ region: config.AWS_REGION, maxAttempts: 1 });
  const auth = new WorkerAuth({ dynamo, tableName: config.DELEGATED_WORKER_TABLE, workspaceId: config.DELEGATED_WORKSPACE_ID, clock: { now: () => new Date().toISOString() } });
  let googleConfig: RemoteGoogleConfig | undefined;
  if (googleVars.every(Boolean)) {
    const prefix = `/delegated-worker/${config.DELEGATED_WORKSPACE_ID}/`;
    const secretPath = z.string().startsWith(prefix).parse(env.DELEGATED_GOOGLE_SECRET_PARAMETER);
    const keyPath = z.string().startsWith(prefix).parse(env.DELEGATED_GOOGLE_KEY_PARAMETER);
    if (secretPath === keyPath) throw new Error('google_unconfigured');
    const ssm = boundaries.ssm ?? new SSMClient({ region: config.AWS_REGION, maxAttempts: 1 });
    const load = async (Name: string): Promise<string> => {
      const result = await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }));
      if (result.Parameter?.Type !== 'SecureString' || !result.Parameter.Value) throw new Error('google_unconfigured');
      return result.Parameter.Value;
    };
    const [clientSecret, encodedKey] = await Promise.all([load(secretPath), load(keyPath)]);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new Error('google_unconfigured');
    googleConfig = { clientId: env.DELEGATED_GOOGLE_CLIENT_ID!, clientSecret, encryptionKey: Buffer.from(encodedKey, 'base64'), redirectUri: `https://${config.DELEGATED_WORKER_HOST}/oauth/callback` };
  }
  const google = new RemoteGoogleAuthorization({ auth, config: googleConfig, fetch: boundaries.fetch });
  const researchSetupProfile = researchProfile(env);
  const source = createSourceCoordinator({ auth, authorization: google, researchSetupProfile, fetch: boundaries.fetch ?? globalThis.fetch,
    research: productionResearchBoundaries(env, boundaries) });
  return { auth, google, source, researchSetup: new ResearchSetupService({ auth, profile: researchSetupProfile }), handle: createWorkerHandler({ auth, google, researchSetupProfile, host: config.DELEGATED_WORKER_HOST }) };
}
export function createProductionHandler(env: NodeJS.ProcessEnv, boundaries: ProductionBoundaries = {}) {
  const invoke = async (event: unknown, context?: { getRemainingTimeInMillis(): number }): Promise<WorkerHttpResponse | ResearchOnceResult | ResearchOnceNextResult | ResearchCycleResult> => {
    // V2 shares the existing native-only IAM boundary and invocation deadline.
    if (event && typeof event === 'object' && 'kind' in event && typeof event.kind === 'string' && event.kind.startsWith('research.cycle')) {
      const started = Date.now(); const request = parseResearchCycle(event);
      const controller = new AbortController();
      const remaining = context ? context.getRemainingTimeInMillis() : 60000;
      const duration = Math.max(0, Math.min(45000, remaining - 5000) - (Date.now() - started));
      const timer = setTimeout(() => controller.abort(), duration);
      if (!duration) controller.abort();
      try { return await executeResearchCycle(env, boundaries, request, controller.signal); }
      catch { throw new Error('research_cycle_unavailable'); }
      finally { clearTimeout(timer); controller.abort(); }
    }
    // Native only. Never route a JSON HTTP body to internal execution.
    if (event && typeof event === 'object' && 'kind' in event && typeof event.kind === 'string' && event.kind.startsWith('research.once')) {
      const started = Date.now();
      const request = parseResearchOnce(event);
      const controller = new AbortController();
      const remaining = context ? context.getRemainingTimeInMillis() : 60000;
      const duration = Math.max(0, Math.min(45000, remaining - 5000) - (Date.now() - started));
      const timer = setTimeout(() => controller.abort(), duration);
      if (!duration) controller.abort();
      try { return await (request.kind === 'research.once.admit-next' || request.kind === 'research.once.admit-next.status'
        ? admitResearchOnceNext(env, boundaries, request, controller.signal) : executeResearchOnce(env, boundaries, request, controller.signal)); }
      catch { throw new Error('research_once_unavailable'); }
      finally { clearTimeout(timer); controller.abort(); }
    }
    let recognizedSchedule = false;
    try {
      const scheduled=z.object({source:z.literal('aws.events'),'detail-type':z.literal('Scheduled Event'),resources:z.array(z.string()).length(1)}).safeParse(event);
      if(scheduled.success && env.DELEGATED_WORKER_ENABLED==='true' && env.DELEGATED_WORKER_SCHEDULE_ARN && scheduled.data.resources[0]===env.DELEGATED_WORKER_SCHEDULE_ARN) {
        recognizedSchedule = true;
        const services=await createProductionServices(env,boundaries);
        if(!services) return response(503,{error:'worker_disabled'});
        return response(200,await services.source.tick(AbortSignal.timeout(45000)));
      }
      const parsed = eventSchema.safeParse(event);
      if (env.DELEGATED_WORKER_ENABLED !== 'true') return response(503, { error: 'worker_disabled' });
      if (!parsed.success) return response(400, { error: 'worker_invalid_request' });
      const needsGoogle = ['/google/begin', '/google/status', '/google/revoke', '/oauth/callback','/readiness'].includes(parsed.data.rawPath);
      // Pairing, emergency and event sync must not depend on Google/SSM health.
      const scopedEnv = needsGoogle ? env : { ...env, DELEGATED_GOOGLE_CLIENT_ID: '', DELEGATED_GOOGLE_SECRET_PARAMETER: '', DELEGATED_GOOGLE_KEY_PARAMETER: '' };
      const services = await createProductionServices(scopedEnv, boundaries);
      return services ? services.handle(event) : response(503, { error: 'worker_disabled' });
    } catch {
      // Async Lambda invocation must fail on thrown errors, not HTTP status codes.
      // Returned tick holds remain results. Never retain the exception or event.
      if (recognizedSchedule) throw new Error('worker_unavailable');
      return response(503, { error: 'worker_unavailable' });
    }
  };
  return invoke as {
    (event: ResearchCycleAdmission, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchCycleAdmissionResult>;
    (event: ResearchCycleStatusRequest | ResearchCycleExecuteRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchCycleStatusResult>;
    (event: ResearchOnceNextRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchOnceNextResult>;
    (event: ResearchOnceRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchOnceResult>;
    (event: unknown, context?: { getRemainingTimeInMillis(): number }): Promise<WorkerHttpResponse>;
  };
}
export function handler(event: ResearchCycleAdmission, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchCycleAdmissionResult>;
export function handler(event: ResearchCycleStatusRequest | ResearchCycleExecuteRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchCycleStatusResult>;
export function handler(event: ResearchOnceNextRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchOnceNextResult>;
export function handler(event: ResearchOnceRequest, context?: { getRemainingTimeInMillis(): number }): Promise<ResearchOnceResult>;
export function handler(event: unknown, context?: { getRemainingTimeInMillis(): number }): Promise<WorkerHttpResponse>;
export async function handler(event: unknown, context?: { getRemainingTimeInMillis(): number }): Promise<WorkerHttpResponse | ResearchOnceResult | ResearchOnceNextResult | ResearchCycleResult> {
  return createProductionHandler(process.env)(event, context);
}
