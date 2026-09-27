import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  lockPostalAddressForRead,
  readRecordedPostalAddresses,
  readWorkspacePostalAddress,
} from '../settings/postalAddress.ts';
import {
  composeSendBody,
  sendBodyIssue,
  SEND_FOOTER_POLICY,
  type ComposeSendBodyDecision,
  type SendFooterPolicy,
} from '../src/rules/templates.ts';
import { rewritePreparedBody, type OutboundFenceRow } from './fence.ts';

/**
 * The footer, composed at send (specification 12.6; lane W3-F, 27 September 2026).
 *
 * Until migration 0020 the footer was inside the approved body: the approval rule refused
 * a body that did not end with it, the fence stored that body, and the dispatch sent what
 * the fence stored. The postal address is a *setting* now, so the block is no longer a
 * property of the template — it is decided at send, from the workspace's sign-off and its
 * `postal_address`, and the order is the safety property:
 *
 *   1. render the template (`sequences/executions.ts`);
 *   2. **compose the footer** — here;
 *   3. store the body and its hash on the fence;
 *   4. dispatch the stored bytes.
 *
 * Composing before step 3 is what keeps the fence's promise: it freezes the exact bytes
 * that will be sent, hash included. Nothing in this file writes a fence that has been
 * claimed, and nothing here sends.
 *
 * ## The claim is the footer's decision instant
 *
 * The footer a fence carries is decided by the workspace's configuration **as it stands
 * inside the claiming transaction**, and not a moment earlier (review of PR 296, P1).
 * Both sources are held still for the length of that transaction: the `postal_address`
 * slice through its own advisory lock, taken SHARED
 * (`lockPostalAddressForRead`, the same name `updateSetting` takes EXCLUSIVE), and the
 * template version `FOR SHARE`, which `updateTemplateVersion`'s `FOR UPDATE` waits on. So
 * an admin's save either lands before the read — and the claim composes with it — or
 * waits for the claim to commit, and the next fence gets it. There is no interleaving in
 * which a claim sends a footer the workspace had already replaced, and none in which
 * clearing the address slips past a `postalAddressRequired` check.
 *
 * ## Fences prepared before 0020
 *
 * A `prepared` or `held` fence created by the previous release carries the body its
 * template had, and its footer may be stale — the address may have been configured, or
 * changed, or cleared since. `reconcileFenceFooter` runs under the claim lock, before the
 * atomic `prepared → dispatching`: it recomposes the stored body and rewrites it when the
 * bytes differ, or refuses, and a refusal holds the fence for repair. **Every** body it
 * lets through is checked first — including the one it did not have to change, which is
 * how a schema-19 fence that already carried two stop lines is held rather than sent
 * (review of PR 296, P0).
 *
 * In-flight fences — `dispatching`, `reconciling` — and `unknown_terminal` ones are not
 * touched here at all: their bytes may already have left, and Appendix B's reconciliation
 * rules for them are unchanged.
 */

export interface ComposedFooterSource {
  /** The workspace's sign-off, from the template version the fence names. */
  readonly signOff: string;
  /** The `postal_address` setting in force, or null. */
  readonly postalAddress: string | null;
  /** Every address the workspace has ever recorded: the composition's provenance. */
  readonly recordedAddresses: readonly string[];
}

/**
 * What a send would append right now: the sign-off of the named template version, the
 * workspace's configured address, and the addresses it has configured before.
 *
 * The sign-off comes from `template_versions.footer_sign_off` rather than from the
 * caller, so a reconciliation and a first send read the same column. Inside a claiming
 * transaction the row is taken `FOR SHARE` and the settings slice SHARED, which is what
 * makes the claim the decision instant; outside one — the step's own composition, which
 * the claim re-decides anyway — the locks are released with the statement and cost
 * nothing.
 */
export async function footerSourceFor(
  context: RepositoryContext,
  templateVersionId: string | null,
): Promise<ComposedFooterSource | null> {
  if (templateVersionId === null) return null;
  await lockPostalAddressForRead(context);
  const { rows } = await context.db.query<{ footer_sign_off: string }>(
    'SELECT footer_sign_off FROM template_versions WHERE workspace_id = $1 AND id = $2 FOR SHARE',
    [context.scope.workspaceId, templateVersionId],
  );
  const signOff = rows[0]?.footer_sign_off;
  if (signOff === undefined) return null;
  return {
    signOff,
    postalAddress: await readWorkspacePostalAddress(context),
    recordedAddresses: await readRecordedPostalAddresses(context),
  };
}

/** Compose one body against the workspace's configuration. A thin, named seam over the rule. */
export async function composeBodyForWorkspace(
  context: RepositoryContext,
  input: {
    readonly body: string;
    readonly signOff: string;
    readonly policy?: SendFooterPolicy | undefined;
  },
): Promise<ComposeSendBodyDecision> {
  await lockPostalAddressForRead(context);
  const postalAddress = await readWorkspacePostalAddress(context);
  const recordedAddresses = await readRecordedPostalAddresses(context);
  return composeSendBody(
    input.body,
    { signOff: input.signOff, postalAddress, recordedAddresses },
    input.policy ?? SEND_FOOTER_POLICY,
  );
}

export type FenceFooterRefusal = 'footer_not_composed' | 'postal_address_required';

export type FenceFooterReconciliation =
  | { readonly reconciled: true; readonly fence: OutboundFenceRow; readonly rewritten: boolean }
  | { readonly reconciled: false; readonly reason: FenceFooterRefusal; readonly detail?: string | undefined };

/**
 * Bring one unclaimed fence's body up to the footer this workspace composes now.
 *
 * Called inside the claiming transaction, after the fence is locked `FOR UPDATE` and
 * before the claim. Three outcomes, and only the first lets a dispatch happen:
 *
 *   * the bytes already are what a send would compose **and they are sendable** —
 *     nothing is written (`rewritten: false`), which is every fence prepared after 0020;
 *   * they are not, and the recomposed body is lawful — the body and its hash are
 *     rewritten under the lock, and the ledger records it;
 *   * they cannot be composed, or what they already carry is not sendable — the caller
 *     holds the fence for repair and nothing reaches Gmail.
 *
 * A fence whose template version is gone cannot have its sign-off read, so it is
 * reconciled only if its stored body is already sendable as it stands; otherwise it is
 * held rather than guessed at.
 */
export async function reconcileFenceFooter(
  context: RepositoryContext,
  fence: OutboundFenceRow,
  options: { readonly actor?: string | undefined; readonly policy?: SendFooterPolicy | undefined } = {},
): Promise<FenceFooterReconciliation> {
  const source = await footerSourceFor(context, fence.templateVersionId);
  if (source === null) {
    // No template version to read a sign-off from. The fence's own bytes are all there
    // is, and they are either already sendable as they stand or nobody may invent a
    // footer for them.
    const issue = sendBodyIssue(fence.body);
    if (issue === null) return { reconciled: true, fence, rewritten: false };
    return { reconciled: false, reason: 'footer_not_composed', detail: `template_version_unknown:${issue}` };
  }

  const decision = composeSendBody(
    fence.body,
    { signOff: source.signOff, postalAddress: source.postalAddress, recordedAddresses: source.recordedAddresses },
    options.policy ?? SEND_FOOTER_POLICY,
  );
  if (!decision.composed) {
    return {
      reconciled: false,
      reason: decision.reason === 'postal_address_required' ? 'postal_address_required' : 'footer_not_composed',
      detail: decision.detail ?? decision.reason,
    };
  }
  if (!decision.changed) {
    // The unchanged branch is checked too, and this is the P0 of the review of PR 296:
    // a fence prepared on schema 19 under a sign-off that itself ends with the stop
    // sentence composes to the same two-stop-line body it already stores, and nothing
    // else on this path would have looked at it.
    const issue = sendBodyIssue(fence.body);
    if (issue !== null) return { reconciled: false, reason: 'footer_not_composed', detail: issue };
    return { reconciled: true, fence, rewritten: false };
  }

  const rewritten = await rewritePreparedBody(context, {
    outboundMessageId: fence.id,
    body: decision.body,
    reason: 'footer_composed_at_send',
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  if (!rewritten.ok) {
    return { reconciled: false, reason: 'footer_not_composed', detail: rewritten.reason };
  }
  return { reconciled: true, fence: rewritten.value, rewritten: true };
}
