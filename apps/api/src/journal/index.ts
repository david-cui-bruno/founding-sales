import {
  SuppressionJournalError,
  journalObjectBody,
  journalObjectKey,
  type SuppressionJournal,
  type SuppressionJournalRecord,
} from '@fss/domain/suppression';

/**
 * The S3 suppression journal, behind an interface (specification 10.2, 4.1,
 * Appendix E).
 *
 * "S3 suppression journal: append-only, object-locked objects keyed by deterministic
 * event ID." "Each event and supersession ... is written to the object-locked S3
 * journal before acknowledgement. A lost journal write fails the command."
 *
 * Three things are deliberate about the shape.
 *
 * **No SDK import.** `createS3SuppressionJournal` takes a `putObject` function. The
 * AWS SDK is loaded by the process that has credentials, in `bootstrap`, and this
 * lane makes no cloud call and adds no dependency. A test supplies a function; a
 * laptop supplies none.
 *
 * **The put is conditional.** `IfNoneMatch: '*'` means a replay of the same
 * deterministic id does not overwrite the object it already wrote, and a `412` is
 * success rather than failure — the event is already durable, which is the only
 * thing the caller needed to know. Object Lock would refuse the overwrite anyway;
 * this makes the intention explicit and keeps the bucket's retention settings from
 * being the only thing standing between a replay and a rewritten record.
 *
 * **The local no-op is loud in configuration and silent at runtime.** A development
 * machine has no bucket and must still be able to record a suppression, so
 * `localNoopSuppressionJournal` exists — but `describeJournal` says which one is in
 * use, the API's readiness report carries it, and `requireDurableJournal` is what a
 * production bootstrap calls so that "no bucket configured" is a refusal to start
 * rather than a silently discarded audit trail. See
 * `docs/decisions/g4-journal-port.md`.
 */

export interface JournalPutRequest {
  readonly bucket: string;
  readonly key: string;
  readonly body: string;
  readonly contentType: 'application/json';
  /** `'*'` — write only if the object is absent. A present object is already durable. */
  readonly ifNoneMatch: '*';
}

export type JournalPutOutcome = 'written' | 'already_present';

/** What the process with credentials supplies. Resolving means durable. */
export type JournalPutObject = (request: JournalPutRequest) => Promise<JournalPutOutcome>;

export interface S3JournalOptions {
  readonly bucket: string;
  readonly putObject: JournalPutObject;
}

export function createS3SuppressionJournal(options: S3JournalOptions): SuppressionJournal {
  return {
    async append(record: SuppressionJournalRecord): Promise<void> {
      try {
        await options.putObject({
          bucket: options.bucket,
          key: journalObjectKey(record),
          body: journalObjectBody(record),
          contentType: 'application/json',
          ifNoneMatch: '*',
        });
      } catch (error) {
        // Redacted on purpose: the bucket name and the key are operational detail,
        // and the command's caller learns only that the journal was unavailable.
        throw new SuppressionJournalError(
          'JOURNAL_UNAVAILABLE',
          `the suppression journal did not accept the record: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    },
  };
}

/**
 * The journal a machine with no bucket uses.
 *
 * It accepts everything and keeps nothing, which is correct for development and
 * wrong for production — so a production bootstrap calls `requireDurableJournal`
 * and refuses to start without a bucket rather than discovering the gap after the
 * first opt-out.
 */
export function localNoopSuppressionJournal(): SuppressionJournal {
  return {
    async append(): Promise<void> {
      return await Promise.resolve();
    },
  };
}

export interface JournalConfiguration {
  /** The bucket name. A public identifier; never a credential. */
  readonly bucket: string | null;
  readonly putObject: JournalPutObject | null;
}

export interface ResolvedJournal {
  readonly journal: SuppressionJournal;
  readonly durable: boolean;
  /** For the readiness report and the structured log. Names no secret. */
  readonly description: 's3' | 'local_noop';
}

export function resolveSuppressionJournal(configuration: JournalConfiguration): ResolvedJournal {
  if (configuration.bucket === null || configuration.putObject === null) {
    return { journal: localNoopSuppressionJournal(), durable: false, description: 'local_noop' };
  }
  return {
    journal: createS3SuppressionJournal({ bucket: configuration.bucket, putObject: configuration.putObject }),
    durable: true,
    description: 's3',
  };
}

export class JournalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalConfigurationError';
  }
}

/**
 * The journal a production deployment must have.
 *
 * Invariant 4 makes suppressions "effective immediately and database-enforced", and
 * Appendix E rebuilds them from the journal after a restore. A production API that
 * accepted opt-outs with nothing to replay from would satisfy the first sentence and
 * quietly break the second.
 */
export function requireDurableJournal(resolved: ResolvedJournal): SuppressionJournal {
  if (!resolved.durable) {
    throw new JournalConfigurationError('production requires an object-locked suppression journal bucket');
  }
  return resolved.journal;
}

export { SuppressionJournalError, journalObjectKey };
export type { SuppressionJournal, SuppressionJournalRecord };
