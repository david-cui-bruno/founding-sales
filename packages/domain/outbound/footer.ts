import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readWorkspacePostalAddress } from '../settings/postalAddress.ts';
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
 * ## Fences prepared before 0020
 *
 * A `prepared` or `held` fence created by the previous release carries the body its
 * template had, and its footer may be stale — the address may have been configured, or
 * changed, or cleared since. `reconcileFenceFooter` runs **under the claim lock**, inside
 * the claiming transaction, before the atomic `prepared → dispatching`: it recomposes the
 * stored body and rewrites it when the bytes differ, or refuses, and a refusal holds the
 * fence for repair. So no fence dispatches a body without exactly one final stop line,
 * and none dispatches one with yesterday's address.
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
}

/**
 * What a send would append right now: the sign-off of the named template version and the
 * workspace's configured address.
 *
 * The sign-off comes from `template_versions.footer_sign_off` rather than from the caller,
 * so a reconciliation and a first send read the same column.
 */
export async function footerSourceFor(
  context: RepositoryContext,
  templateVersionId: string | null,
): Promise<ComposedFooterSource | null> {
  if (templateVersionId === null) return null;
  const { rows } = await context.db.query<{ footer_sign_off: string }>(
    'SELECT footer_sign_off FROM template_versions WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, templateVersionId],
  );
  const signOff = rows[0]?.footer_sign_off;
  if (signOff === undefined) return null;
  return { signOff, postalAddress: await readWorkspacePostalAddress(context) };
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
  const postalAddress = await readWorkspacePostalAddress(context);
  return composeSendBody(
    input.body,
    { signOff: input.signOff, postalAddress },
    input.policy ?? SEND_FOOTER_POLICY,
  );
}

export type FenceFooterReconciliation =
  | { readonly reconciled: true; readonly fence: OutboundFenceRow; readonly rewritten: boolean }
  | { readonly reconciled: false; readonly reason: 'footer_not_composed' | 'postal_address_required'; readonly detail?: string | undefined };

/**
 * Bring one unclaimed fence's body up to the footer this workspace composes now.
 *
 * Called inside the claiming transaction, after the fence is locked `FOR UPDATE` and
 * before the claim. Three outcomes, and only the first lets a dispatch happen:
 *
 *   * the bytes already are what a send would compose — nothing is written
 *     (`rewritten: false`), which is every fence prepared after 0020;
 *   * they are not, and the recomposed body is lawful — the body and its hash are
 *     rewritten under the lock, and the ledger records it;
 *   * they cannot be composed — the caller holds the fence for repair.
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
    { signOff: source.signOff, postalAddress: source.postalAddress },
    options.policy ?? SEND_FOOTER_POLICY,
  );
  if (!decision.composed) {
    return {
      reconciled: false,
      reason: decision.reason === 'postal_address_required' ? 'postal_address_required' : 'footer_not_composed',
      ...(decision.detail === undefined ? { detail: decision.reason } : { detail: decision.detail }),
    };
  }
  if (!decision.changed) return { reconciled: true, fence, rewritten: false };

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
