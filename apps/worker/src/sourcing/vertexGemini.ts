import {QUALIFICATION_MODEL_NAME} from '@fss/domain/sourcing/qualificationModel.ts';
import type {QualificationGeminiRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {vertexCredentialConfigSchema,loadAwsFederatedTokenSource,type AccessTokenSource,type VertexCredentialConfig} from './vertexCredentials.ts';

/** The part of a Vertex `generateContent` answer qualification reads. */
export interface GeminiResponse {
  readonly candidates?: readonly {
    readonly content?: {readonly parts?: readonly {readonly text?: string; readonly thought?: boolean}[]};
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: {readonly blockReason?: string};
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly totalTokenCount?: number;
  };
}

/** One model on Vertex AI: an exact prompt token count, and one non-streaming generation. */
export interface GeminiSurface {
  countTokens(request: Pick<QualificationGeminiRequest, 'systemInstruction' | 'contents'>): Promise<number>;
  generate(request: QualificationGeminiRequest): Promise<GeminiResponse>;
}

/**
 * A failed call. `status` is the HTTP status when Vertex answered and null when nobody can say
 * whether it ran (timeout, dropped connection, unreadable 200); `providerErrorOf` turns a 4xx
 * (not 408) into a refusal before generation, which Vertex does not bill, and anything else
 * into an estimated cost. `refusedBeforeGeneration` marks a failure before any request left
 * this process (no access token), which is settled at zero and never retried as a call.
 */
export class VertexRequestError extends Error {
  readonly status: number | null;
  readonly refusedBeforeGeneration?: boolean;
  constructor(status: number | null, refusedBeforeGeneration?: boolean) {
    super(status === null ? 'vertex_request_failed' : `vertex_http_${status}`);
    this.name = 'VertexRequestError';
    this.status = status;
    if (refusedBeforeGeneration !== undefined) this.refusedBeforeGeneration = refusedBeforeGeneration;
  }
}

/** Never retried: a second call is a second charge, and the run owns its one attempt. */
const COUNT_TIMEOUT_MILLISECONDS = 20_000;
const GENERATE_TIMEOUT_MILLISECONDS = 75_000;

export interface VertexSurfaceOptions {
  readonly project: string;
  readonly location: string;
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

export function vertexGeminiSurface(options: VertexSurfaceOptions): GeminiSurface {
  const host = options.location === 'global' ? 'aiplatform.googleapis.com' : `${options.location}.aiplatform.googleapis.com`;
  const model = `https://${host}/v1/projects/${options.project}/locations/${options.location}/publishers/google/models/${QUALIFICATION_MODEL_NAME}`;
  const send = options.fetch ?? fetch;
  async function post(method: 'countTokens' | 'generateContent', body: unknown, timeout: number): Promise<unknown> {
    let token: string;
    try {
      token = await options.accessToken();
    } catch {
      throw new VertexRequestError(null, true);
    }
    let response: Response;
    try {
      response = await send(`${model}:${method}`, {
        method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new VertexRequestError(null);
    }
    if (!response.ok) {
      // The body can echo the prompt, which is page text and candidate data: it is never read.
      await response.body?.cancel().catch(() => undefined);
      throw new VertexRequestError(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new VertexRequestError(null);
    }
  }
  return {
    countTokens: async request => {
      const answer = await post('countTokens', request, COUNT_TIMEOUT_MILLISECONDS);
      const total = typeof answer === 'object' && answer !== null && 'totalTokens' in answer ? answer.totalTokens : undefined;
      // Not a count, so not "it fits".
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new Error('countTokens returned no totalTokens');
      return total;
    },
    generate: async request => {
      const answer = await post('generateContent', request, GENERATE_TIMEOUT_MILLISECONDS);
      if (typeof answer !== 'object' || answer === null) throw new VertexRequestError(null);
      return answer as GeminiResponse;
    },
  };
}

export interface VertexConfig {
  readonly project: string;
  readonly location: string;
  readonly credential: VertexCredentialConfig;
  readonly awsRegion: string;
}

export const VERTEX_VARIABLES = ['FSS_VERTEX_PROJECT', 'FSS_VERTEX_LOCATION', 'FSS_VERTEX_CREDENTIAL_CONFIG'] as const;

/**
 * Qualification's Vertex configuration from the task environment, by variable name only.
 * Nothing set is a deployment that never chose Vertex (`problem: null`); a partial or invalid
 * set is a problem naming the variable. Either way there is no configuration, so qualification
 * finishes `credit_route_unavailable`: it never falls back to Bedrock or to a cash route.
 */
export function readVertexConfig(environment: Readonly<Record<string, string | undefined>>): {readonly config: VertexConfig | null; readonly problem: string | null} {
  const value = (name: string): string => (environment[name] ?? '').trim();
  const present = VERTEX_VARIABLES.filter(name => value(name) !== '');
  if (present.length === 0) return {config: null, problem: null};
  const missing = VERTEX_VARIABLES.find(name => value(name) === '');
  if (missing !== undefined) return {config: null, problem: missing};
  const project = value('FSS_VERTEX_PROJECT');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) return {config: null, problem: 'FSS_VERTEX_PROJECT'};
  const location = value('FSS_VERTEX_LOCATION');
  if (!/^(?:global|[a-z]+-[a-z]+\d+)$/u.test(location)) return {config: null, problem: 'FSS_VERTEX_LOCATION'};
  let decoded: unknown;
  try {
    decoded = JSON.parse(value('FSS_VERTEX_CREDENTIAL_CONFIG'));
  } catch {
    return {config: null, problem: 'FSS_VERTEX_CREDENTIAL_CONFIG'};
  }
  const credential = vertexCredentialConfigSchema.safeParse(decoded);
  const awsRegion = value('AWS_REGION');
  if (!credential.success) return {config: null, problem: 'FSS_VERTEX_CREDENTIAL_CONFIG'};
  if (awsRegion === '') return {config: null, problem: 'AWS_REGION'};
  return {config: {project, location, credential: credential.data, awsRegion}, problem: null};
}

/** The real surface: the only function that builds the federated token source. */
export async function loadVertexGeminiSurface(config: VertexConfig, tokens?: AccessTokenSource): Promise<GeminiSurface> {
  const source = tokens ?? (await loadAwsFederatedTokenSource(config.credential, config.awsRegion));
  return vertexGeminiSurface({project: config.project, location: config.location, accessToken: () => source.token()});
}
