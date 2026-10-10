import {SOURCE_69_SEEDS} from './source69Seeds.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * Rows HEAD adds to the fixture at N, in N's own column list, before the snapshot.
 *
 * The fixture is written by the base checkout's own loader, so a row shape the base's
 * code never produced cannot come from there — yet the migration under test has to meet
 * it, because production can hold it. The case that made this file: schema 25 lets a
 * `follow_up_permissions` row be spent (`consumed_at` set) and 0026 adds a CHECK pairing
 * `consumed_at` with a new `consumed_reason`, so 0026 must backfill the reason first
 * (review of PR 335, P1-1). The base's fixture holds no spent permission, and a run
 * without one would pass whether the backfill existed or not.
 *
 * Each seed is plain SQL against schema N — never HEAD's domain code, which writes
 * schema M — and names the versions it applies to. After the upgrade its `verify` reads
 * the row back and says what is wrong, or null. A seed changes rows in a table the
 * snapshot then records, so step 6 sees the migration's effect on it like any other.
 */
export interface HeadSeed {
  readonly name: string;
  /** The base schemas this seed is written for: its SQL uses exactly their columns. */
  readonly fromVersions: readonly number[];
  readonly seed: (session: SessionQueryable) => Promise<string>;
  readonly verify: (session: SessionQueryable, seededId: string) => Promise<string | null>;
}

export const HEAD_SEEDS: readonly HeadSeed[] = Object.freeze([
  ...SOURCE_69_SEEDS,
  {
    name: 'existing disabled CRM controls retain revisions and budgets without invented authority or OAuth observations (0088)',
    fromVersions: [83, 87],
    seed: async session => {
      const member=(await session.query<{workspace_id:string;user_id:string}>("SELECT workspace_id,user_id FROM workspace_memberships WHERE role='admin' AND status='active' ORDER BY workspace_id,user_id LIMIT 1")).rows[0];
      if(!member)throw new Error('Upgrade fixture requires its existing administrator');
      await session.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,7,false,'upgrade-preserved-route','upgrade-preserved-model','upgrade-preserved-grant','upgrade-preserved-policy',13,113,1,5,$2) ON CONFLICT(workspace_id) DO UPDATE SET revision=7,enabled=false,endpoint_id='upgrade-preserved-route',model_version='upgrade-preserved-model',access_grant_version='upgrade-preserved-grant',data_handling_version='upgrade-preserved-policy',daily_ceiling_cents=13,monthly_ceiling_cents=113,input_token_price_micros=1,output_token_price_micros=5,approved_by=EXCLUDED.approved_by`,[member.workspace_id,member.user_id]);
      return member.workspace_id;
    },
    verify: async(session,id) => {
      const row=(await session.query<{revision:number;enabled:boolean;daily_ceiling_cents:number;monthly_ceiling_cents:number;authority_receipt_id:string|null;endpoint_id:string}>('SELECT revision,enabled,daily_ceiling_cents,monthly_ceiling_cents,authority_receipt_id,endpoint_id FROM crm_extraction_purposes WHERE workspace_id=$1',[id])).rows[0];
      if(!row||row.revision!==7||row.enabled||row.daily_ceiling_cents!==13||row.monthly_ceiling_cents!==113||row.endpoint_id!=='upgrade-preserved-route'||row.authority_receipt_id!==null)return 'Upgrade changed disabled CRM settings or invented capability authority';
      if((await session.query('SELECT id FROM crm_capability_authority_receipts')).rows.length||(await session.query('SELECT id FROM mailbox_oauth_grant_observations')).rows.length)return 'Upgrade invented authority or historical OAuth observations';
      return null;
    },
  },
  {
    name:'discovery approval versions preserve schedule, quotas and historical uncertainty (0051)',
    fromVersions:[50],
    seed:async session=>{
      const row=(await session.query<{id:string}>('SELECT id FROM workspaces ORDER BY id LIMIT 1')).rows[0];if(!row)throw new Error('workspace fixture missing');
      await session.query("INSERT INTO sourcing_discovery_settings(workspace_id,enabled,query_cursor,next_run_at) VALUES($1,false,7,'2026-10-10T12:00:00Z') ON CONFLICT(workspace_id) DO UPDATE SET enabled=false,query_cursor=7,next_run_at='2026-10-10T12:00:00Z'",[row.id]);
      await session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,day,query_id,query,state) VALUES($1,'2026-10-04','historical','Historical query','complete') ON CONFLICT DO NOTHING",[row.id]);
      return row.id;
    },
    verify:async(session,id)=>{
      const settings=(await session.query<{enabled:boolean;query_cursor:number;targeting_version:string;next_run_at:Date}>('SELECT enabled,query_cursor,targeting_version,next_run_at FROM sourcing_discovery_settings WHERE workspace_id=$1',[id])).rows[0];
      if(!settings||settings.enabled||settings.query_cursor!==7||settings.next_run_at.toISOString()!=='2026-10-10T12:00:00.000Z'||settings.targeting_version!=='targeting-v1')return 'discovery schedule or approval changed during upgrade';
      const version=(await session.query<{n:number}>('SELECT jsonb_array_length(queries) AS n FROM sourcing_targeting_versions WHERE workspace_id=$1 AND version=$2',[id,'targeting-v1'])).rows[0];if(version?.n!==12)return 'initial query policy was not preserved';
      const attempt=(await session.query<{policy_version:string|null}>("SELECT policy_version FROM sourcing_discovery_attempts WHERE workspace_id=$1 AND query_id='historical'",[id])).rows[0];if(!attempt||attempt.policy_version!==null)return 'historical attempt acquired an invented policy';
      return null;
    },
  },
  {
    name:'existing discovery candidates and quota remain review-only (0050)',
    fromVersions:[49],
    seed:async session=>{
      const w=(await session.query<{id:string}>('SELECT id FROM workspaces ORDER BY id LIMIT 1')).rows[0]!.id;
      await session.query('INSERT INTO sourcing_search_account(id,daily_used,monthly_used) VALUES(true,20,20) ON CONFLICT(id) DO UPDATE SET daily_used=20,monthly_used=20');
      await session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true',[w]);
      const row=(await session.query<{id:string}>(`INSERT INTO sourcing_candidates(workspace_id,identity_key,payload) VALUES($1,repeat('e',64),$2::jsonb) RETURNING id`,[w,JSON.stringify({firmName:'Upgrade PM',website:'https://upgrade.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://upgrade.example.test/',observedOn:'2026-10-01',preparedBy:'Upgrade fixture'})])).rows[0]!;
      return row.id;
    },
    verify:async(session,id)=>{
      const row=(await session.query<{qualification_blocked:boolean;revision:number;auto_admission_enabled:boolean;qualification_evaluation:unknown;owner_user_id:string|null;enabled:boolean}>(`SELECT c.qualification_blocked,c.revision,s.auto_admission_enabled,s.qualification_evaluation,s.owner_user_id,s.enabled FROM sourcing_candidates c JOIN sourcing_discovery_settings s USING(workspace_id) WHERE c.id=$1`,[id])).rows[0];
      if(!row||row.qualification_blocked||row.revision!==1||row.auto_admission_enabled||row.qualification_evaluation!==null||row.owner_user_id!==null||!row.enabled)return 'existing candidate changed or automatic admission was enabled';
      const quota=(await session.query<{daily_used:number;monthly_used:number}>('SELECT daily_used,monthly_used FROM sourcing_search_account')).rows[0];
      if(quota?.daily_used!==20||quota.monthly_used!==20)return 'search quota changed';
      const count=(await session.query('SELECT id FROM sourcing_qualification_runs UNION ALL SELECT candidate_id AS id FROM sourcing_admissions')).rows.length;
      return count===0?null:'upgrade invented qualification/admission';
    },
  },
  {
    name: 'existing claimed job gains no invented first claim (0045)',
    fromVersions: [44],
    seed: async session => {
      const {rows}=await session.query<{id:string}>(`INSERT INTO jobs(workspace_id,kind,idempotency_key,payload,state,attempt_count,max_attempts)
        SELECT id,'health.ping','upgrade0045-existing','{}','queued',1,4 FROM workspaces ORDER BY id LIMIT 1 RETURNING id`);
      if(!rows[0])throw new Error('fixture has no workspace');
      return rows[0].id;
    },
    verify: async(session,id)=>{
      const {rows}=await session.query<{first_claimed_at:Date|null;attempt_count:number}>('SELECT first_claimed_at,attempt_count FROM jobs WHERE id=$1',[id]);
      if(rows[0]?.first_claimed_at!==null||rows[0].attempt_count!==1)return 'existing job history changed';
      const settings=await session.query("SELECT 1 FROM workspace_settings WHERE setting_key='meeting_auto_recording'");
      const operations=await session.query('SELECT 1 FROM meeting_recording_setup');
      return settings.rows.length===0&&operations.rows.length===0?null:'upgrade must not enable or schedule demo recording';
    },
  },
  {
    name: 'spent follow-up permission (0026 backfills consumed_reason)',
    fromVersions: [25],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `INSERT INTO follow_up_permissions
           (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
            expires_at, granted_by_user_id, consumed_at)
         SELECT c.workspace_id, c.firm_id, c.id, 'request', 'contextual_reply', 'upgrade-spent-0026', 1,
                now() + interval '14 days', m.user_id, now()
           FROM contacts c
           JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
          ORDER BY c.created_at, c.id, m.user_id
          LIMIT 1
         RETURNING id`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no contact to hang a spent permission on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<{ consumed_reason: string | null; consumed_at: Date | null }>(
        'SELECT consumed_reason, consumed_at FROM follow_up_permissions WHERE id = $1',
        [seededId],
      );
      const row = rows[0];
      if (row === undefined) return 'the spent permission is gone';
      if (row.consumed_at === null) return 'the spent permission lost its consumed_at';
      if (row.consumed_reason !== 'sent') return `consumed_reason is ${String(row.consumed_reason)}, expected sent`;
      return null;
    },
  },
  {
    // Lane M1 (0039): production's held meetings all came from Cal.com's scheduled end, and
    // the base's fixture writes no meeting at all. A held meeting with its meeting.held fact,
    // and a no-show that remembers held, in schema 38's columns, so the run meets the rows the
    // correction rewrites: held → ended, the remembered held → ended, the fact withdrawn.
    name: 'held meetings and their meeting.held fact (0039 corrects them)',
    fromVersions: [38],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `WITH firm AS (
           SELECT workspace_id, id FROM firms WHERE status = 'active' ORDER BY created_at, id LIMIT 1
         ), held AS (
           INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
           SELECT workspace_id, 'upgrade0039held', 'upgrade0039held', id, 'held',
                  TIMESTAMPTZ '2026-09-29 15:00:00+00', TIMESTAMPTZ '2026-09-29 15:30:00+00', TIMESTAMPTZ '2026-09-29 15:30:00+00'
             FROM firm
           RETURNING workspace_id, id, firm_id
         ), absent AS (
           INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, state_before_no_show, starts_at, ends_at, last_event_at)
           SELECT workspace_id, 'upgrade0039absent', 'upgrade0039absent', id, 'no_show', 'held',
                  TIMESTAMPTZ '2026-09-28 15:00:00+00', TIMESTAMPTZ '2026-09-28 15:30:00+00', TIMESTAMPTZ '2026-09-28 16:00:00+00'
             FROM firm
           RETURNING id
         ), aliased AS (
           INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id)
           SELECT workspace_id, 'upgrade0039held', id FROM held
           RETURNING meeting_id
         ), fact AS (
           INSERT INTO funnel_facts (workspace_id, kind, firm_id, dedupe_key, source, actor_kind, occurred_at)
           SELECT workspace_id, 'meeting.held', firm_id, 'upgrade0039held', 'calendar', 'system', TIMESTAMPTZ '2026-09-29 15:31:00+00'
             FROM held
           RETURNING id
         )
         SELECT held.id FROM held, absent, aliased, fact`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no active firm to hang a held meeting on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<{
        booking_uid: string;
        state: string;
        state_before_no_show: string | null;
        attendance_source: string | null;
        calcom_absent_pending: boolean;
      }>(
        `SELECT booking_uid, state, state_before_no_show, attendance_source, calcom_absent_pending FROM meetings
          WHERE booking_uid IN ('upgrade0039held', 'upgrade0039absent') ORDER BY booking_uid`,
      );
      const absent = rows.find(row => row.booking_uid === 'upgrade0039absent');
      const held = rows.find(row => row.booking_uid === 'upgrade0039held');
      if (held === undefined || absent === undefined) return 'a seeded meeting is gone';
      if (held.state !== 'ended') return `the held meeting is ${held.state}, expected ended`;
      if (absent.state !== 'no_show' || absent.state_before_no_show !== 'ended') return `the no-show is ${absent.state} remembering ${String(absent.state_before_no_show)}`;
      if (absent.attendance_source !== 'calcom_no_show') return `the no-show's source is ${String(absent.attendance_source)}`;
      // 0039's new column: no stored meeting has a deferred Cal.com absence.
      if (held.calcom_absent_pending || absent.calcom_absent_pending) return 'a migrated meeting holds a deferred Cal.com absence';
      const facts = await session.query<{ withdrawn_reason: string | null; occurred_at: Date }>(
        "SELECT withdrawn_reason, occurred_at FROM funnel_facts WHERE kind = 'meeting.held' AND dedupe_key = 'upgrade0039held'",
      );
      const fact = facts.rows[0];
      if (fact === undefined) return 'the meeting.held fact is gone';
      if (fact.withdrawn_reason !== 'scheduled_end_not_attendance') return `the fact's withdrawal is ${String(fact.withdrawn_reason)}`;
      if (fact.occurred_at.toISOString() !== '2026-09-29T15:00:00.000Z') return `the fact is dated ${fact.occurred_at.toISOString()}, not the meeting's start`;
      const meeting = await session.query('SELECT 1 FROM meetings WHERE id = $1', [seededId]);
      return meeting.rows.length === 1 ? null : 'the seeded meeting id no longer resolves';
    },
  },
  {
    // Lane M2 (0040): a meeting stored at 39 has no booking details; the migration adds the
    // columns empty and rewrites nothing.
    name: 'a meeting at 39 gains empty booking details (0040)',
    fromVersions: [39],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
         SELECT workspace_id, 'upgrade0040booked', 'upgrade0040booked', id, 'booked',
                TIMESTAMPTZ '2026-10-08 15:00:00+00', TIMESTAMPTZ '2026-10-08 15:30:00+00', TIMESTAMPTZ '2026-10-01 12:00:00+00'
           FROM firms WHERE status = 'active' ORDER BY created_at, id LIMIT 1
         RETURNING id`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no active firm to hang a meeting on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<Record<string, unknown>>(
        `SELECT state, event_title, attendee_name, booking_notes, booking_answers, location_type, video_call_url, zoom_meeting_id, details_observed_at
           FROM meetings WHERE id = $1`,
        [seededId],
      );
      const row = rows[0];
      if (row === undefined) return 'the seeded meeting is gone';
      if (row['state'] !== 'booked') return `the meeting is ${String(row['state'])}, expected booked`;
      const filled = Object.entries(row).filter(([column, value]) => column !== 'state' && value !== null);
      return filled.length === 0 ? null : `0040 filled ${filled.map(([column]) => column).join(', ')}`;
    },
  },
]);

export function seedsFor(fromVersion: number): readonly HeadSeed[] {
  return HEAD_SEEDS.filter(seed => seed.fromVersions.includes(fromVersion));
}
