/**
 * Enricher Lambda handler — the enrichment gate (EventBridge 15-min rule,
 * DISABLED by default like the other adapters).
 *
 * Flow per run:
 *   1. List upstream/enrichment-requests/*.ndjson in the inbox bucket. A
 *      per-FILE ledger (snapshots table key `enricher:<s3 key>`) skips files
 *      already fully processed; a per-REQUEST ledger
 *      (`enricher:req:<cloud_entity_id>:<requested_at>`) skips individual
 *      requests inside a partially-processed file so a resumed run never
 *      re-spends vendor credits on work that already completed.
 *   2. Per request (schema-validated; invalid lines are logged and skipped):
 *      a. SPEND CAP: read month-to-date credits (snapshots table item
 *         `enricher:__spend__:<YYYY-MM>`); at/over ENRICH_MONTHLY_CREDIT_CAP
 *         the request is skipped with a structured log and an SNS alarm is
 *         published exactly once per month (conditional alarm marker).
 *      b. Tracerfy Instant Trace Lookup (find_owner: true). 402/403 stop the
 *         whole run (founder problem -> the run THROWS after finalizing, so
 *         the existing Lambda-errors alarm fires). 429 backs off 60s once
 *         then stops gracefully (next 15-min tick resumes). 5xx retries once
 *         then stops + throws.
 *      c. Credits actually deducted are ADDed atomically to the month item.
 *      d. Person pick: property_owner flag first, else normalized-name match
 *         against owner_full_name, else vendor rank order.
 *      e. SUPPRESSION: every returned phone/email is HMAC'd (salt from SSM
 *         /callie-sourcing/membership-hmac-salt, same canonicalization as the
 *         app's contactHmac) and checked against the suppression table.
 *         Suppressed contacts are dropped and counted (never logged in
 *         cleartext); if every contact drops, the event goes out hit:false
 *         with person null — suppressed identities never reach the inbox.
 *   3. Events are emitted per request file via the shared emitEvents
 *      pipeline (validate -> idempotency claim -> one ndjson inbox file),
 *      then the request + file ledgers are written. A file is only marked
 *      done when every request in it was handled (cap-skips keep it open for
 *      a future run).
 *
 * Test payload: {"maxFiles": N, "maxRequests": N} bounds a live run.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  emitEvents,
  enrichmentRequestSchema,
  type CloudSourceEvent,
  type EnrichmentEmail,
  type EnrichmentPhone,
  type EnrichmentRequest,
} from "@callie-sourcing/shared";
import {
  ADAPTER_NAME,
  buildEnrichmentEvent,
  contactHmac,
  normalizeContacts,
  pickPerson,
} from "./enrich";
import { instantTraceLookup, type TracerfyLookupResult } from "./tracerfy";
import { log } from "./log";

export const REQUESTS_PREFIX = "upstream/enrichment-requests/";
const LEDGER_SNAPSHOT_DATE = "ledger";
const SPEND_SNAPSHOT_DATE = "spend";
const RATE_LIMIT_BACKOFF_MS = 60_000;

export interface EnricherEvent {
  /** Bound the number of request files read (live testing). */
  maxFiles?: number;
  /** Bound the number of requests processed (live testing). */
  maxRequests?: number;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  sns: Pick<SNSClient, "send">;
  fetchImpl: typeof fetch;
  /** Resolves the membership HMAC salt (SSM in prod, fixture in tests). */
  getHmacSalt: () => Promise<string>;
  env: {
    INBOX_BUCKET: string;
    IDEMPOTENCY_TABLE: string;
    SNAPSHOTS_TABLE: string;
    SUPPRESSION_TABLE: string;
    SNS_TOPIC_ARN: string;
    TRACERFY_BASE_URL: string;
    TRACERFY_API_KEY: string;
    ENRICH_MONTHLY_CREDIT_CAP: number;
  };
  now?: () => Date;
  /** Injectable delay for the 429 backoff. */
  sleep?: (ms: number) => Promise<void>;
}

function envOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function defaultDeps(): HandlerDeps {
  const ssm = new SSMClient({});
  const saltParam =
    process.env.HMAC_SALT_PARAM ?? "/callie-sourcing/membership-hmac-salt";
  return {
    s3: new S3Client({}),
    dynamo: new DynamoDBClient({}),
    sns: new SNSClient({}),
    fetchImpl: fetch,
    getHmacSalt: async () => {
      const result = await ssm.send(
        new GetParameterCommand({ Name: saltParam, WithDecryption: true }),
      );
      const salt = result.Parameter?.Value;
      if (!salt) throw new Error(`SSM parameter ${saltParam} has no value`);
      return salt;
    },
    env: {
      INBOX_BUCKET: envOrThrow("INBOX_BUCKET"),
      IDEMPOTENCY_TABLE: envOrThrow("IDEMPOTENCY_TABLE"),
      SNAPSHOTS_TABLE: envOrThrow("SNAPSHOTS_TABLE"),
      SUPPRESSION_TABLE: envOrThrow("SUPPRESSION_TABLE"),
      SNS_TOPIC_ARN: envOrThrow("SNS_TOPIC_ARN"),
      TRACERFY_BASE_URL: envOrThrow("TRACERFY_BASE_URL"),
      TRACERFY_API_KEY: envOrThrow("TRACERFY_API_KEY"),
      ENRICH_MONTHLY_CREDIT_CAP: Number(
        process.env.ENRICH_MONTHLY_CREDIT_CAP ?? "1000",
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Ledgers + spend (snapshots table)
// ---------------------------------------------------------------------------

function fileLedgerKey(s3Key: string): string {
  return `enricher:${s3Key}`;
}

function requestLedgerKey(request: EnrichmentRequest): string {
  return `enricher:req:${request.cloud_entity_id}:${request.requested_at}`;
}

function spendKey(monthKey: string): string {
  return `enricher:__spend__:${monthKey}`;
}

async function ledgerHas(
  deps: HandlerDeps,
  naturalKey: string,
): Promise<boolean> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: naturalKey },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
      },
    }),
  );
  return result.Item !== undefined;
}

async function ledgerMark(
  deps: HandlerDeps,
  naturalKey: string,
  nowIso: string,
): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: naturalKey },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
        processed_at: { S: nowIso },
      },
    }),
  );
}

async function readMonthSpend(
  deps: HandlerDeps,
  monthKey: string,
): Promise<number> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: spendKey(monthKey) },
        snapshot_date: { S: SPEND_SNAPSHOT_DATE },
      },
    }),
  );
  const credits = result.Item?.credits_used?.N;
  return credits ? Number(credits) : 0;
}

async function addMonthSpend(
  deps: HandlerDeps,
  monthKey: string,
  credits: number,
  nowIso: string,
): Promise<void> {
  if (credits <= 0) return;
  await deps.dynamo.send(
    new UpdateItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: spendKey(monthKey) },
        snapshot_date: { S: SPEND_SNAPSHOT_DATE },
      },
      UpdateExpression: "ADD credits_used :credits SET updated_at = :now",
      ExpressionAttributeValues: {
        ":credits": { N: String(credits) },
        ":now": { S: nowIso },
      },
    }),
  );
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "ConditionalCheckFailedException")
  );
}

/**
 * Publish the spend-cap SNS alarm exactly once per month: a conditional
 * SET on the month's spend item arbitrates which run sends it.
 */
async function alarmCapOnce(
  deps: HandlerDeps,
  monthKey: string,
  monthToDate: number,
  nowIso: string,
): Promise<boolean> {
  try {
    await deps.dynamo.send(
      new UpdateItemCommand({
        TableName: deps.env.SNAPSHOTS_TABLE,
        Key: {
          source_natural_key: { S: spendKey(monthKey) },
          snapshot_date: { S: SPEND_SNAPSHOT_DATE },
        },
        UpdateExpression: "SET cap_alarm_sent_at = :now",
        ConditionExpression: "attribute_not_exists(cap_alarm_sent_at)",
        ExpressionAttributeValues: { ":now": { S: nowIso } },
      }),
    );
  } catch (error) {
    if (isConditionalFailure(error)) return false; // already alarmed this month
    throw error;
  }
  await deps.sns.send(
    new PublishCommand({
      TopicArn: deps.env.SNS_TOPIC_ARN,
      Subject: `callie-sourcing enricher: monthly credit cap reached (${monthKey})`,
      Message:
        `Enrichment spend cap reached: ${monthToDate} credits used in ${monthKey} ` +
        `(cap ${deps.env.ENRICH_MONTHLY_CREDIT_CAP}). Further enrichment requests are ` +
        `being skipped until the cap is raised (ENRICH_MONTHLY_CREDIT_CAP) or the month rolls over.`,
    }),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Request file reading
// ---------------------------------------------------------------------------

async function listRequestFiles(deps: HandlerDeps): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.env.INBOX_BUCKET,
        Prefix: REQUESTS_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith(".ndjson")) keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
}

interface ParsedRequestFile {
  requests: EnrichmentRequest[];
  invalidLines: number;
}

async function readRequests(
  deps: HandlerDeps,
  key: string,
): Promise<ParsedRequestFile> {
  const raw = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.env.INBOX_BUCKET, Key: key }),
  );
  const body = raw.Body;
  if (!body) return { requests: [], invalidLines: 0 };
  const text = await (
    body as { transformToString(): Promise<string> }
  ).transformToString();

  const requests: EnrichmentRequest[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = enrichmentRequestSchema.safeParse(JSON.parse(line));
      if (parsed.success) requests.push(parsed.data);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { requests, invalidLines };
}

// ---------------------------------------------------------------------------
// Vendor call with retry policy (429 backoff once; 5xx retry once)
// ---------------------------------------------------------------------------

async function lookupWithRetry(
  deps: HandlerDeps,
  request: EnrichmentRequest,
): Promise<TracerfyLookupResult> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const input = {
    address: request.situs_address.line1,
    city: request.situs_address.locality,
    state: request.situs_address.region,
    zip: request.situs_address.postal_code,
  };
  const call = () =>
    instantTraceLookup(
      deps.fetchImpl,
      deps.env.TRACERFY_BASE_URL,
      deps.env.TRACERFY_API_KEY,
      input,
    );

  let result = await call();
  if (result.kind === "rate_limited") {
    log("warn", "tracerfy rate limited, backing off once", {
      backoff_ms: RATE_LIMIT_BACKOFF_MS,
    });
    await sleep(RATE_LIMIT_BACKOFF_MS);
    result = await call();
  } else if (result.kind === "server_error") {
    log("warn", "tracerfy server error, retrying once", { status: result.status });
    result = await call();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type StopReason =
  | "no_credits"
  | "suspended"
  | "rate_limited"
  | "server_error"
  | "unexpected_response";

/** Stop reasons that are founder/config problems: the run throws after
 * finalizing so the Lambda-errors alarm fires. */
const THROWING_STOPS: ReadonlySet<StopReason> = new Set([
  "no_credits",
  "suspended",
  "server_error",
  "unexpected_response",
]);

export interface RunResult {
  filesSeen: number;
  filesCompleted: number;
  filesSkippedLedger: number;
  requestsSeen: number;
  requestsHandled: number;
  requestsSkippedLedger: number;
  requestsCapSkipped: number;
  invalidLines: number;
  vendorHits: number;
  vendorMisses: number;
  creditsUsedRun: number;
  suppressedPhones: number;
  suppressedEmails: number;
  invalidContactsDropped: number;
  eventsWritten: number;
  idempotencySkips: number;
  inboxKeys: string[];
  stopped: StopReason | null;
}

interface HandledRequest {
  request: EnrichmentRequest;
  event: CloudSourceEvent;
}

export async function handlerWithDeps(
  event: EnricherEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  const startedAt = performance.now();
  const now = deps.now ?? (() => new Date());
  const maxFiles = event?.maxFiles;
  const maxRequests = event?.maxRequests;

  const result: RunResult = {
    filesSeen: 0,
    filesCompleted: 0,
    filesSkippedLedger: 0,
    requestsSeen: 0,
    requestsHandled: 0,
    requestsSkippedLedger: 0,
    requestsCapSkipped: 0,
    invalidLines: 0,
    vendorHits: 0,
    vendorMisses: 0,
    creditsUsedRun: 0,
    suppressedPhones: 0,
    suppressedEmails: 0,
    invalidContactsDropped: 0,
    eventsWritten: 0,
    idempotencySkips: 0,
    inboxKeys: [],
    stopped: null,
  };

  let files = await listRequestFiles(deps);
  if (maxFiles !== undefined) files = files.slice(0, maxFiles);
  result.filesSeen = files.length;

  // Salt is fetched lazily: a run with no requests never touches SSM.
  let salt: string | null = null;
  const getSalt = async (): Promise<string> =>
    (salt ??= await deps.getHmacSalt());

  // In-run dedupe on top of the persisted request ledger.
  const handledThisRun = new Set<string>();

  for (const fileKey of files) {
    if (result.stopped) break;
    if (await ledgerHas(deps, fileLedgerKey(fileKey))) {
      result.filesSkippedLedger += 1;
      continue;
    }

    const { requests, invalidLines } = await readRequests(deps, fileKey);
    result.invalidLines += invalidLines;
    if (invalidLines > 0) {
      log("warn", "invalid enrichment request lines skipped", {
        s3_key: fileKey,
        invalid_lines: invalidLines,
      });
    }

    const handled: HandledRequest[] = [];
    let fileComplete = true;

    for (const request of requests) {
      result.requestsSeen += 1;
      if (maxRequests !== undefined && result.requestsHandled >= maxRequests) {
        fileComplete = false;
        break;
      }

      const ledgerKey = requestLedgerKey(request);
      if (handledThisRun.has(ledgerKey) || (await ledgerHas(deps, ledgerKey))) {
        result.requestsSkippedLedger += 1;
        continue;
      }

      const nowDate = now();
      const monthKey = nowDate.toISOString().slice(0, 7);

      // SPEND CAP: month-to-date check BEFORE every lookup.
      const monthToDate = await readMonthSpend(deps, monthKey);
      if (monthToDate >= deps.env.ENRICH_MONTHLY_CREDIT_CAP) {
        const alarmed = await alarmCapOnce(
          deps,
          monthKey,
          monthToDate,
          nowDate.toISOString(),
        );
        log("warn", "monthly credit cap reached, skipping request", {
          cloud_entity_id: request.cloud_entity_id,
          month: monthKey,
          month_to_date_credits: monthToDate,
          cap: deps.env.ENRICH_MONTHLY_CREDIT_CAP,
          alarm_published: alarmed,
        });
        result.requestsCapSkipped += 1;
        fileComplete = false; // cap-skipped requests stay eligible for later
        continue;
      }

      const lookup = await lookupWithRetry(deps, request);
      if (lookup.kind !== "ok") {
        switch (lookup.kind) {
          case "no_credits":
            log("error", "tracerfy: insufficient credits, stopping run", {
              cloud_entity_id: request.cloud_entity_id,
            });
            result.stopped = "no_credits";
            break;
          case "suspended":
            log("error", "tracerfy: account suspended, stopping run", {
              cloud_entity_id: request.cloud_entity_id,
            });
            result.stopped = "suspended";
            break;
          case "rate_limited":
            log("warn", "tracerfy: still rate limited after backoff, stopping run", {
              cloud_entity_id: request.cloud_entity_id,
            });
            result.stopped = "rate_limited";
            break;
          case "server_error":
            log("error", "tracerfy: server error after retry, stopping run", {
              cloud_entity_id: request.cloud_entity_id,
              status: lookup.status,
            });
            result.stopped = "server_error";
            break;
          case "unexpected":
            log("error", "tracerfy: unexpected response, stopping run", {
              cloud_entity_id: request.cloud_entity_id,
              status: lookup.status,
              detail: lookup.detail,
            });
            result.stopped = "unexpected_response";
            break;
        }
        fileComplete = false;
        break;
      }

      // Record vendor spend the moment it is known (crash-safe: the cap
      // check is best-effort within the run, the ADD is atomic).
      const credits = lookup.response.credits_deducted;
      await addMonthSpend(deps, monthKey, credits, nowDate.toISOString());
      result.creditsUsedRun += credits;

      const picked = pickPerson(lookup.response.persons, request.owner_full_name);
      if (picked) result.vendorHits += 1;
      else result.vendorMisses += 1;

      // Normalize then SUPPRESSION-check every contact (CONTRACT invariant:
      // person contact data must be checked before it can reach the inbox).
      let phones: EnrichmentPhone[] = [];
      let emails: EnrichmentEmail[] = [];
      if (picked) {
        const contacts = normalizeContacts(picked.person);
        result.invalidContactsDropped += contacts.invalidDropped;

        for (const phone of contacts.phones) {
          const hmac = contactHmac(await getSalt(), "phone", phone.e164);
          if (await isSuppressed(deps, hmac)) result.suppressedPhones += 1;
          else phones.push(phone);
        }
        for (const email of contacts.emails) {
          const hmac = contactHmac(await getSalt(), "email", email.address);
          if (await isSuppressed(deps, hmac)) result.suppressedEmails += 1;
          else emails.push(email);
        }
        const dropped =
          contacts.phones.length - phones.length + contacts.emails.length - emails.length;
        if (dropped > 0) {
          log("info", "suppressed contacts dropped", {
            cloud_entity_id: request.cloud_entity_id,
            dropped,
            all_dropped: phones.length === 0 && emails.length === 0,
          });
        }
      }

      handled.push({
        request,
        event: buildEnrichmentEvent({
          request,
          picked,
          phones,
          emails,
          creditsUsed: credits,
          fetchedAt: nowDate,
        }),
      });
      handledThisRun.add(ledgerKey);
      result.requestsHandled += 1;
    }

    // Finalize the file: emit whatever completed, then write ledgers. On a
    // crash between vendor call and ledger the request re-runs (bounded
    // re-spend); the emit pipeline itself is idempotent.
    if (handled.length > 0) {
      const emitted = await emitEvents({
        s3: deps.s3,
        dynamo: deps.dynamo,
        inboxBucket: deps.env.INBOX_BUCKET,
        idempotencyTable: deps.env.IDEMPOTENCY_TABLE,
        adapterName: ADAPTER_NAME,
        events: handled.map((h) => h.event),
        now,
      });
      result.eventsWritten += emitted.written;
      result.idempotencySkips += emitted.idempotencySkips;
      if (emitted.inboxKey) result.inboxKeys.push(emitted.inboxKey);

      const nowIso = now().toISOString();
      for (const h of handled) {
        await ledgerMark(deps, requestLedgerKey(h.request), nowIso);
      }
    }
    if (fileComplete) {
      await ledgerMark(deps, fileLedgerKey(fileKey), now().toISOString());
      result.filesCompleted += 1;
    }
  }

  log(result.stopped ? "warn" : "info", "enricher run complete", {
    ...result,
    durationMs: Math.max(0, performance.now() - startedAt),
  });

  if (result.stopped && THROWING_STOPS.has(result.stopped)) {
    // Founder/config problem: surface through the Lambda-errors alarm. All
    // completed work was already emitted and ledgered above.
    throw new Error(`enricher stopped: ${result.stopped}`);
  }
  return result;
}

async function isSuppressed(deps: HandlerDeps, hmac: string): Promise<boolean> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SUPPRESSION_TABLE,
      Key: { contact_hash: { S: hmac } },
    }),
  );
  return result.Item !== undefined;
}

let cachedDeps: HandlerDeps | null = null;

export async function handler(
  event: EnricherEvent | null | undefined,
): Promise<RunResult> {
  cachedDeps ??= defaultDeps();
  return handlerWithDeps(event, cachedDeps);
}
