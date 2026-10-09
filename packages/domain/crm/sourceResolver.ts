import type { CanonicalSourceReference } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockIdentityContext } from './identityAccess.ts';
import { recordCrmAuditEvent } from './audit.ts';

export interface SourceLookup {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly kind: CanonicalSourceReference['kind'];
  readonly revision: number;
  readonly contentHash: string | null;
  readonly locator: string | null;
}

/** Resolve allowed original text, never content or attribution supplied by a caller. */
export async function resolveCrmSource(context: RepositoryContext, input: SourceLookup) {
  if (input.workspaceId !== context.scope.workspaceId || input.kind !== 'selected_note'
    || !await lockIdentityContext(context, { sourceIds: [input.sourceId] })) return null;
  const source = (await context.db.query<{
    id: string; revision: number; availability: string; excerpt: string | null;
    content_hash: string | null; occurred_at: Date | null; observed_at: Date;
  }>('SELECT id,revision,availability,excerpt,content_hash,occurred_at,observed_at FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, input.sourceId])).rows[0];
  if (source === undefined || source.availability !== 'available' || source.excerpt === null
    || source.revision !== input.revision || source.content_hash !== input.contentHash) return null;
  const range = /^text:(0|[1-9]\d{0,7}):(0|[1-9]\d{0,7})$/u.exec(input.locator ?? '');
  if (input.locator !== null && range === null) return null;
  const start = Number(range?.[1] ?? '0');
  const end = Number(range?.[2] ?? '0');
  if (input.locator !== null && (start >= end || end > source.excerpt.length || end - start > 2000)) return null;
  const splitsCharacter = (offset: number) => offset > 0 && offset < source.excerpt!.length
    && source.excerpt!.charCodeAt(offset - 1) >= 0xd800 && source.excerpt!.charCodeAt(offset - 1) <= 0xdbff
    && source.excerpt!.charCodeAt(offset) >= 0xdc00 && source.excerpt!.charCodeAt(offset) <= 0xdfff;
  if (input.locator !== null && (splitsCharacter(start) || splitsCharacter(end))) return null;
  const reference: CanonicalSourceReference = {
    workspaceId: context.scope.workspaceId, sourceId: source.id, kind: 'selected_note', revision: source.revision,
    contentHash: source.content_hash, locator: input.locator, speaker: null,
    occurredAt: source.occurred_at?.toISOString() ?? null, observedAt: source.observed_at.toISOString(),
    completeness: 'selected_excerpt', availability: 'available',
  };
  if (context.scope.actor.kind === 'user' && context.scope.actor.role === 'admin') {
    await recordCrmAuditEvent(context, {
      action: 'crm.evidence_source_read', subjectKind: 'selected_source', subjectId: source.id,
      detail: { sourceRevision: source.revision, exceptionalAdminRead: true },
    });
  }
  return { state: 'available' as const, source: reference, extent: { unit: 'utf16' as const, length: source.excerpt.length },
    passage: input.locator === null ? null : { text: source.excerpt.slice(start, end), locator: input.locator, speaker: null } };
}
