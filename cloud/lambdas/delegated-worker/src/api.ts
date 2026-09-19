/**
 * The API Lambda entry point (FSS target design section 1; slice S3). One of the three entry points built from the
 * same artifact: `api.ts` serves the HTTP routes, `scheduler.ts` decides what is due, `runner.ts` does the work.
 *
 * Its behaviour is unchanged from before the queue existed: the same handler, the same routes, the same auth, the
 * same scheduled-tick path (which the deploy directive's `delegated_worker_legacy_email_enabled = false` narrows
 * to the research phases). Splitting the roles is the point of this file: after S3 only this function holds the
 * Google client secret, and only the runner reaches a mailbox.
 */
export { handler, createProductionHandler, createProductionServices, createWorkerHandler } from './handler';
export type { WorkerHttpResponse, ProductionBoundaries } from './handler';
