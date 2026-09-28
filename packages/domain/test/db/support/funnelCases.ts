import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';

/**
 * A failing insert for every constraint migration 0022 adds (`funnel_facts`).
 *
 * Same rules as the other case files: its own file so two lanes never edit the middle
 * of one array, each case inside a transaction the caller rolls back, and each row
 * breaking exactly one thing — a row that breaks two is reported under whichever
 * check PostgreSQL reaches first, and the case would be testing the wrong promise.
 *
 * A funnel fact carries no name, address or handle, so there is nothing here to make
 * fictional beyond the ids the fixture already owns.
 */

export interface FunnelCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
}

export interface FunnelCase {
  readonly constraint: string;
  readonly run: (fixture: FunnelCaseFixture) => Promise<unknown>;
}

const workspace = (f: FunnelCaseFixture): string => f.seeded.alpha.workspaceId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';

interface Row {
  readonly workspaceId?: string;
  readonly kind?: string;
  readonly firmId?: string | null;
  readonly contactId?: string | null;
  readonly opportunityId?: string | null;
  readonly dedupeKey?: string;
  readonly source?: string;
  readonly actorKind?: string;
  readonly actorUserId?: string | null;
  readonly detail?: string;
  readonly id?: string;
}

let sequence = 0;

async function insert(f: FunnelCaseFixture, row: Row): Promise<unknown> {
  sequence += 1;
  return await f.session.query(
    `INSERT INTO funnel_facts
       (id, workspace_id, kind, firm_id, contact_id, opportunity_id,
        dedupe_key, source, actor_kind, actor_user_id, detail)
     VALUES (COALESCE($11::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      row.workspaceId ?? workspace(f),
      row.kind ?? 'firm.created',
      row.firmId === undefined ? f.crm.alpha.firmId : row.firmId,
      row.contactId ?? null,
      row.opportunityId ?? null,
      row.dedupeKey ?? `case-${String(sequence)}`,
      row.source ?? 'crm',
      row.actorKind ?? 'system',
      row.actorUserId ?? null,
      row.detail ?? '{}',
      row.id ?? null,
    ],
  );
}

export const FUNNEL_CONSTRAINT_CASES: readonly FunnelCase[] = [
  {
    constraint: 'funnel_facts_pkey',
    run: async f => {
      const id = '11111111-1111-4111-8111-111111111111';
      await insert(f, { id });
      return await insert(f, { id });
    },
  },
  {
    constraint: 'funnel_facts_dedupe',
    run: async f => {
      await insert(f, { dedupeKey: 'the-same-key' });
      return await insert(f, { dedupeKey: 'the-same-key' });
    },
  },
  {
    constraint: 'funnel_facts_workspace_fkey',
    // A firm-less fact reaches no composite key, so this is the only thing standing
    // between a typo and a fact in a tenant that is not there.
    run: async f => await insert(f, { workspaceId: MISSING, firmId: null }),
  },
  {
    constraint: 'funnel_facts_firm_fkey',
    run: async f => await insert(f, { firmId: MISSING }),
  },
  {
    constraint: 'funnel_facts_contact_fkey',
    run: async f =>
      // A real firm, and a contact id that is not one of its contacts: the triple is
      // what the key is over, so naming another workspace's contact would fail here
      // too, and this is the narrower break.
      await insert(f, { contactId: MISSING }),
  },
  {
    constraint: 'funnel_facts_opportunity_fkey',
    run: async f => await insert(f, { opportunityId: MISSING }),
  },
  {
    constraint: 'funnel_facts_kind_shape',
    // One part, no dot. The shape wants two or three.
    run: async f => await insert(f, { kind: 'created' }),
  },
  {
    constraint: 'funnel_facts_firm_present_for_child',
    // A contact with no firm. The composite key is satisfied by a null, and this is
    // the CHECK that says a contact-level fact names the firm it belongs to.
    run: async f => await insert(f, { firmId: null, contactId: f.crm.alpha.contactId }),
  },
  {
    constraint: 'funnel_facts_one_child',
    // Both children. `crm/merges.ts` moves contacts before opportunities, so this
    // row would break the opportunity key inside a later merge rather than here.
    run: async f =>
      await insert(f, { contactId: f.crm.alpha.contactId, opportunityId: f.crm.alpha.opportunityId }),
  },
  {
    constraint: 'funnel_facts_dedupe_key_shape',
    // A space. The alphabet has none, which is what stops a name being a key.
    run: async f => await insert(f, { dedupeKey: 'Dana Placeholder' }),
  },
  {
    constraint: 'funnel_facts_source_shape',
    // A dotted source. A source is one flat lower-case word.
    run: async f => await insert(f, { source: 'crm.firms' }),
  },
  {
    constraint: 'funnel_facts_actor_kind_known',
    run: async f => await insert(f, { actorKind: 'robot', actorUserId: null }),
  },
  {
    constraint: 'funnel_facts_user_actor_identified',
    // An admin actor with nobody named. The equivalence goes both ways; this is the
    // half that would otherwise let a fact say "a person did this" and not say who.
    run: async f => await insert(f, { actorKind: 'admin', actorUserId: null }),
  },
  // `funnel_facts_detail_is_object` is one constraint over two rules — the coded
  // shape (`funnel_facts_detail_coded`) and the length bound — so it gets a case per
  // way of breaking it. The database has to refuse each of these on its own, because
  // `app_runtime` holds INSERT and `recordFunnelFact` is not the only way in.
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f => await insert(f, { detail: JSON.stringify(['not', 'an', 'object']) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f => await insert(f, { detail: JSON.stringify({ firm: { id: 'abc' } }) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f => await insert(f, { detail: JSON.stringify({ attempts: [1, 2] }) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    // A sentence. The whole reason the rule is in the database and not only in code.
    run: async f => await insert(f, { detail: JSON.stringify({ note: 'call back Friday' }) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f => await insert(f, { detail: JSON.stringify({ code: 'a'.repeat(65) }) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f => await insert(f, { detail: JSON.stringify({ '1st': 'yes' }) }),
  },
  {
    constraint: 'funnel_facts_detail_is_object',
    run: async f =>
      await insert(f, {
        detail: JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${String(i)}`, 1]))),
      }),
  },
];
