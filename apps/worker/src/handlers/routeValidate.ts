import { Resolver } from 'node:dns/promises';
import {
  emailValidationSweep,
  parseRouteValidationPayload,
  runEmailRouteValidation,
  type MailDomainResolver,
} from '@fss/domain/crm/routeValidation.ts';
import { type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `route.validate` job and the sweep that retries it (specification 7.4, 13.1,
 * 13.2; lane g90).
 *
 * The rules — what `technical_validation = 'passed'` means for an address — are
 * `packages/domain/crm/routeValidation.ts`, beside the route they decide, for the reason
 * every other lane keeps its handler body in the domain: the at-least-once harness
 * registers it without importing `apps/worker`. This file is the composition: the
 * resolver the process asks, and what the one-minute pass materializes.
 *
 * ## When it runs
 *
 * * **When an address is added** (`addEmailRoute` enqueues round `new` in the command's
 *   own transaction: Add firm, an import row, the carry, `/contacts/routes/add`).
 * * **When a check got no answer** — a DNS timeout, SERVFAIL, a refused query — the
 *   route stays `unknown`, and the sweep below asks again ten minutes after its last
 *   change, then once an hour for its first day, then once a day.
 * * **When a person presses Check again** on the Firm page (one job per command).
 *
 * ## Why `business_uniqueness`
 *
 * The one write is a compare-and-set on the route (`recordEmailRouteValidation`): it
 * happens only while the route is the unchecked candidate at the version the job names,
 * and it bumps that version. The runner commits it with the completion, so a stolen
 * lease rolls it back, and a second run finds a route that has moved on and writes
 * nothing. `apps/worker/test/routeValidate.test.ts` runs the stolen-lease probe.
 *
 * ## A lookup inside the runner's transaction
 *
 * The runner opens the transaction before the handler runs, so DNS is asked inside it.
 * No row is locked while it is — the handler reads, asks, and only then takes the route's
 * lock — and each lookup is bounded (`DNS_LOOKUP_DEADLINE_MILLISECONDS`, and the
 * resolver's own two tries of two and a half seconds below), so the worst case is about
 * ten seconds of an open, lock-free transaction.
 */

/** A check that keeps throwing — a database error, not a DNS one — is dead after four. */
const ROUTE_VALIDATE_MAX_ATTEMPTS = 4;

/**
 * The resolver production asks: the process's own, from `/etc/resolv.conf`, which in the
 * VPC is the Amazon-provided resolver. No server is configured here and no third party
 * is asked; this is the same DNS every other outbound connection the worker makes uses.
 */
export function systemMailDomainResolver(
  options: { readonly timeoutMilliseconds?: number; readonly tries?: number } = {},
): MailDomainResolver {
  const resolver = new Resolver({ timeout: options.timeoutMilliseconds ?? 2_500, tries: options.tries ?? 2 });
  return {
    resolveMx: async domain => await resolver.resolveMx(domain),
    resolve4: async domain => await resolver.resolve4(domain),
    resolve6: async domain => await resolver.resolve6(domain),
  };
}

export class RouteValidateHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteValidateHandlerError';
  }
}

export function routeValidateJobHandler(options: {
  readonly resolver: MailDomainResolver;
  readonly deadlineMilliseconds?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
}): JobHandler {
  return {
    kind: 'route.validate',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? ROUTE_VALIDATE_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? 60,
    handle: async input => {
      const payload = parseRouteValidationPayload(input.job.payload);
      if (payload === null) {
        throw new RouteValidateHandlerError('a route.validate payload names an email route id and its version');
      }
      // Every answer — written, deferred, or nothing to do — completes the job. A DNS
      // failure is not a job failure: throwing would spend the retry ladder on a
      // resolver's bad minute and end in a dead job and a critical alarm about a route
      // the sweep is going to ask about again anyway.
      await runEmailRouteValidation(repositoryContext(input.scope, input.session), {
        payload,
        resolver: options.resolver,
        deadlineMilliseconds: options.deadlineMilliseconds,
      });
    },
  };
}

/**
 * The sweep (13.1): unchecked email routes, oldest first, at most
 * `EMAIL_VALIDATION_SWEEP_LIMIT` a pass, each at most once a round. It reads and
 * inserts; it asks DNS nothing.
 */
export function routeValidationSource(): DueWorkSource {
  return {
    name: 'route-validation',
    find: async (session: SessionQueryable, now: string): Promise<readonly JobSpecification[]> =>
      await emailValidationSweep(session, { now }),
  };
}
