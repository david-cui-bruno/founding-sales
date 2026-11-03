import type { DataCollection, Envelope, ErrorEvent, EventEnvelopeHeaders, StackFrame, Transport } from '@sentry/core';

export type TechnicalErrorBoundary =
  | 'uncaught' | 'api_request' | 'worker_loop' | 'worker_handler'
  | 'browser_render' | 'browser_action' | 'startup' | 'shutdown';
export type ErrorConfiguration = {
  release: string;
  service: 'api' | 'worker' | 'browser';
  sourceFiles?: Readonly<Record<string, true | undefined>>;
  runtimeRoot?: string;
};

type TechnicalErrorEnvelope = [EventEnvelopeHeaders, Array<[{ type: 'event' }, ErrorEvent]>];

const boundaries: Record<string, true | undefined> = {
  uncaught: true, api_request: true, worker_loop: true, worker_handler: true,
  browser_render: true, browser_action: true, startup: true, shutdown: true,
};
const standardTypes: Record<string, true | undefined> = {
  Error: true, TypeError: true, RangeError: true, ReferenceError: true,
  SyntaxError: true, URIError: true, EvalError: true, AggregateError: true,
};
export const dataCollection = {
  userInfo: false, cookies: false, httpHeaders: { request: false, response: false },
  httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
  databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0,
} satisfies DataCollection;

export function isBoundary(value: unknown): value is TechnicalErrorBoundary {
  return typeof value === 'string' && Object.hasOwn(boundaries, value);
}
export function isRelease(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

// Restrict ingestion to Sentry's US SaaS; no tunnels, credentials, queries or arbitrary hosts.
export function isDsn(value: string): boolean {
  return /^https:\/\/[a-f0-9]{32}@o[0-9]+\.ingest(?:\.us)?\.sentry\.io\/[0-9]+$/.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
}

/** Code paths only: never copy a URL, query, local home directory or dynamic name. */
export function codeFilename(value: unknown, sourceFiles?: Readonly<Record<string, true | undefined>>, runtimeRoot?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  let filename = value;
  if (runtimeRoot) {
    const absolute = filename.startsWith('file://') ? filename.slice('file://'.length) : filename;
    if (absolute.startsWith(runtimeRoot)) filename = `app:///${absolute.slice(runtimeRoot.length)}`;
  }
  // Native Node runs tracked TypeScript directly from the image's /app root.
  const native = /^(?:file:\/\/)?(?:\/app\/|app:\/\/\/)((?:apps\/(?:api|worker|web)\/src|packages\/(?:contracts|telemetry)\/src|packages\/domain\/(?:crm|db|jobs|today|src|policy|suppression|classification|mail|outbound|dial|sequences|templates|settings|dashboard|funnel|research|social|sourcing|outreach|replies|notifications|retention|release|business|calls|calling|meetings|restore))\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts)$/.exec(filename);
  if (native?.[1] && sourceFiles && Object.hasOwn(sourceFiles, native[1])) return `app:///${native[1]}`;
  // The browser build has one fixed output; do not accept page or arbitrary asset paths.
  return /^(?:https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/|app:\/\/\/|\/)?renderer\.js$/.test(filename)
    ? 'app:///renderer.js' : undefined;
}

function frame(value: unknown, configuration: ErrorConfiguration): StackFrame | undefined {
  const input = record(value);
  if (!input) return undefined;
  const filename = codeFilename(input['filename'], configuration.sourceFiles, configuration.runtimeRoot);
  if (!filename || !coordinate(input['lineno'])) return undefined;
  if (configuration.service === 'browser') {
    if (filename !== 'app:///renderer.js') return undefined;
  } else if (!configuration.sourceFiles || !Object.hasOwn(configuration.sourceFiles, filename.slice('app:///'.length))) {
    return undefined;
  }
  return {
    filename, lineno: input['lineno'], in_app: true,
    ...(coordinate(input['colno']) ? { colno: input['colno'] } : {}),
  };
}

/** Build a new event. No arbitrary runtime strings survive, including exception names. */
export function sanitizeErrorEvent(value: unknown, configuration: ErrorConfiguration): ErrorEvent | null {
  try {
    if (!isRelease(configuration.release)) return null;
    const input = record(value);
    if (!input || input['type'] !== undefined) return null;
    const exception = record(input['exception']);
    const values = exception?.['values'];
    if (!Array.isArray(values)) return null;
    // Causes and aggregate children may contain arbitrary runtime data. Retain only the primary error.
    const primary = record(values[values.length - 1]);
    const stack = record(primary?.['stacktrace']);
    const rawFrames = stack?.['frames'];
    if (!primary || !Array.isArray(rawFrames)) return null;
    const frames = rawFrames.slice(-100).map((value: unknown) => frame(value, configuration)).filter((item): item is StackFrame => item !== undefined);
    if (frames.length === 0) return null;
    const tags = record(input['tags']);
    const boundary = isBoundary(tags?.['technical_boundary']) ? tags['technical_boundary'] : 'uncaught';
    const event: ErrorEvent = {
      type: undefined,
      level: input['level'] === 'fatal' ? 'fatal' : 'error',
      platform: configuration.service === 'browser' ? 'javascript' : 'node',
      release: configuration.release, environment: 'production',
      tags: { service: configuration.service, technical_boundary: boundary },
      exception: { values: [{
        type: typeof primary['type'] === 'string' && Object.hasOwn(standardTypes, primary['type']) ? primary['type'] : 'Error',
        value: 'Technical error', stacktrace: { frames },
      }] },
    };
    if (typeof input['event_id'] === 'string' && /^[a-f0-9]{32}$/.test(input['event_id'])) event.event_id = input['event_id'];
    if (typeof input['timestamp'] === 'number' && Number.isFinite(input['timestamp']) && input['timestamp'] >= 0 && input['timestamp'] < 100_000_000_000) event.timestamp = input['timestamp'];
    const debug = record(input['debug_meta']);
    const images = debug?.['images'];
    if (Array.isArray(images)) {
      const safeImages = images.flatMap((item: unknown) => {
        const image = record(item);
        const codeFile = codeFilename(image?.['code_file'], configuration.sourceFiles, configuration.runtimeRoot);
        const id = image?.['debug_id'];
        return image?.['type'] === 'sourcemap' && codeFile && frames.some((item) => item.filename === codeFile)
          && typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
          ? [{ type: 'sourcemap' as const, code_file: codeFile, debug_id: id.toLowerCase() }] : [];
      });
      if (safeImages.length) event.debug_meta = { images: safeImages };
    }
    return event;
  } catch {
    // Hostile getters/proxies and malformed SDK input must not affect the application.
    return null;
  }
}

/** Re-sanitize at the last structured boundary, after SDK envelope enrichment. */
export function sanitizeEnvelope(envelope: Envelope, configuration: ErrorConfiguration): TechnicalErrorEnvelope | null {
  try {
    const sentAt = envelope[0]['sent_at'];
    if (typeof sentAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sentAt)
      || !Number.isFinite(Date.parse(sentAt)) || new Date(sentAt).toISOString() !== sentAt) return null;
    const items: TechnicalErrorEnvelope[1] = [];
    let eventId: string | undefined;
    for (const [headers, payload] of envelope[1]) {
      if (headers.type !== 'event') continue;
      const event = sanitizeErrorEvent(payload, configuration);
      if (!event?.event_id) continue;
      // The maintained SDK creates one error per envelope. Refuse ambiguous event IDs.
      if (eventId !== undefined) return null;
      eventId = event.event_id;
      items.push([{ type: 'event' }, event]);
    }
    if (!eventId) return null;
    // Preserve only validated technical protocol fields, never sampling/SDK/attachment headers.
    return [{ event_id: eventId, sent_at: sentAt }, items];
  } catch {
    return null;
  }
}

export function errorOnlyTransport(delegate: Transport, configuration: ErrorConfiguration): Transport {
  return {
    send(envelope) {
      const safe = sanitizeEnvelope(envelope, configuration);
      // A local privacy rejection is not a successful provider acknowledgement.
      return safe ? delegate.send(safe) : Promise.reject(new Error('Telemetry envelope refused'));
    },
    flush: (timeout) => delegate.flush(timeout),
  };
}

export function errorOptions(configuration: ErrorConfiguration) {
  return {
    release: configuration.release, environment: 'production', debug: false,
    defaultIntegrations: false as const, sendDefaultPii: false,
    sendClientReports: false, maxBreadcrumbs: 0, attachStacktrace: false,
    tracesSampleRate: 0, tracePropagationTargets: [], spotlight: false,
    dataCollection,
    beforeSend: (event: ErrorEvent) => sanitizeErrorEvent(event, configuration),
  };
}
