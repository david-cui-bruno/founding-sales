import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
import type { RawDatabase } from '../../src/main/db/sqliteDriver';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { DOMAIN_TIMESTAMP as at, insertOpenCycleWithAction, insertPerson, seedProspect } from '../fixtures/domainRows';

// Named historical19 columns, not current-schema SELECT * or counts. New fields
// belong to separate assertions below. Pin matches packagedFixtureDatabase's real19 manifest.
const projections = {
  persons: 'id,display_name,aliases_json,opted_out,opted_out_at,never_record,deleted_at,provenance_json,version,created_at,updated_at',
  organizations: 'id,canonical_name,source_record_json,created_at,updated_at',
  organization_aliases: 'id,organization_id,alias,created_at',
  prospects: 'id,person_id,original_source_event_id,segment,qualification_state,version,created_at,updated_at',
  source_events: 'id,person_id,prospect_id,sales_cycle_id,channel,observed_at,source_record_json,evidence_ref,referred_by_person_id,referrer_unknown_reason,created_at',
  source_intake_receipts: 'source_event_id,person_id,prospect_id,command_json,result_json,created_at',
  person_contact_methods: 'id,person_id,kind,normalized_value,raw_value,validation_state,reachability,is_primary,in_contacts,federal_status,compliance_tcpa_flag,covered_area_code,compliance_source,scrubbed_at,compliance_expires_at,created_at,updated_at',
  sales_cycles: 'id,person_id,prospect_id,entry_source_event_id,stage,workflow_status,current_next_action_id,stage_entered_at,version,created_at,updated_at',
  next_actions: 'id,sales_cycle_id,action_type,channel,status,timezone,work_intent,due_at,due_source,created_at',
  activities: 'id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,observed_outcome,adapter,provider_idempotency_key,provider_reference,metadata_json,created_at,note_text,call_outcome,callback_at',
  cadence_definitions: 'id,family,version,name,content_hash,attempt_cap,definition_json,created_at',
  cadence_steps: 'id,cadence_definition_id,sequence,day_offset,label,breakup,step_json,created_at',
  cadence_action_components: 'id,cadence_step_id,sequence,action_type,channel,condition_json,outcome_graph_json,template_json,created_at',
  email_drafts: 'id,person_id,sales_cycle_id,contact_method_id,recipient,contact_snapshot,account_email,sender_footer,subject,body,revision,status,generation,message_id,notice,superseded_at,created_at,updated_at',
  email_send_intents: 'command_id,draft_id,draft_revision,content_hash,reservation_json,created_at',
  email_send_results: 'command_id,status,result_json,created_at',
  opt_out_tombstones: 'id,person_id,requested_at,observed_channel,source_activity_id,evidence_ref,policy_version,created_at',
  opt_out_handles: 'id,tombstone_id,kind,normalized_value,created_at',
  opt_out_closure_receipts: 'source_activity_id,operation_kind,person_id,tombstone_id,source_tombstone_id,closed_cycle_id,terminal_stage_event_id,command_json,result_json,created_at',
  opt_out_closure_receipt_handles: 'source_activity_id,tombstone_id,handle_id,sequence',
  backup_receipts: 'id,backup_basename,kind,schema_version,sha256,size_bytes,created_at,verified_at',
  restore_drill_receipts: 'performed_at,backup_receipt_id,backup_sha256',
  identity_repair_events: 'id,manifest_sha256,candidate_id,canonical_person_id,created_person_ids_json,reassigned_source_event_ids_json,applied_at',
} as const;
function historicalRows(raw: RawDatabase) {
  return Object.fromEntries(Object.entries(projections).map(([table, columns]) => [table,
    raw.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${columns.split(',')[0]} COLLATE BINARY`).all()]));
}
function catalog(raw: RawDatabase) {
  return raw.prepare(`SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index','trigger')
    AND (type <> 'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY`).all() as { name: string; type: string; sql: string | null }[];
}

describe('genuine historical19 account migration preservation', () => {
  it('preserves exact named identities, catalogs, receipts, callbacks, drafts, unknown sends and opt-outs through registered migrations', async () => {
    const temp = createTempDatabase(); const key = createTestWorkspaceKey();
    let db = openDatabase({ path: temp.path, key });
    try {
      const options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
      await createMigrationRunner(productionMigrations.filter(m => m.schemaVersion <= 19))(db, options);
      expect(db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 19 });
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='pm_accounts'").get()).toBeUndefined();
      const originalCatalog = catalog(db.raw);
      const fingerprint = originalCatalog.map(r => [r.type, r.name, (r.sql ?? '').replace(/\s+/g, ' ').trim()])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
      expect(createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'))
        .toBe('a6108cfce2bc4242d0872e81cc2afc88634f6309c55605bd3fc995804fde9073');
      const prospect = seedProspect(db.raw, 'fictional-legacy');
      const { cycleId, actionId } = insertOpenCycleWithAction({ database: db.raw, prefix: 'fictional-legacy', prospect });
      db.raw.prepare("UPDATE next_actions SET due_at=?,due_source='recorded_callback' WHERE id=?")
        .run('2026-09-09T14:00:00.000Z', actionId);
      db.raw.prepare('INSERT INTO organizations(id,canonical_name,created_at,updated_at) VALUES(?,?,?,?)').run('legacy-org', 'Fictional historical PM', at, at);
      db.raw.prepare('INSERT INTO organization_aliases VALUES(?,?,?,?)').run('legacy-alias', 'legacy-org', 'Original fictional trading name', at);
      db.raw.prepare('INSERT INTO source_intake_receipts VALUES(?,?,?,?,?,?)')
        .run(prospect.sourceEventId, prospect.personId, prospect.prospectId, '{"legacy":"command"}', '{"legacy":"receipt"}', at);
      db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,raw_value,validation_state,reachability,created_at,updated_at)
        VALUES('legacy-email',?,'email','legacy@example.invalid','legacy@example.invalid','valid','direct',?,?)`).run(prospect.personId, at, at);
      db.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,note_text,callback_at)
        VALUES('legacy-callback',?,?,?,'call','outbound','phone',?,'{"original":true}',?,'Promised fictional callback','2026-09-09T14:00:00.000Z')`)
        .run(prospect.personId, prospect.prospectId, cycleId, at, at);
      for (const [id, status, superseded] of [['legacy-draft', 'draft', at], ['legacy-unknown', 'unknown', null]] as const) {
        db.raw.prepare(`INSERT INTO email_drafts(id,person_id,sales_cycle_id,contact_method_id,recipient,contact_snapshot,subject,body,revision,status,generation,superseded_at,created_at,updated_at)
          VALUES(?,?,?,'legacy-email','legacy@example.invalid',?,'Original subject','Original exact body',1,?,'edited',?,?,?)`)
          .run(id, prospect.personId, cycleId, 'a'.repeat(64), status, superseded, at, at);
      }
      db.raw.prepare('INSERT INTO email_send_intents VALUES(?,?,?,?,?,?)').run('legacy-send', 'legacy-unknown', 1, 'b'.repeat(64), '{"uncertain":true}', at);
      db.raw.prepare('INSERT INTO email_send_results VALUES(?,?,?,?)').run('legacy-send', 'unknown', '{"status":"unknown","providerReference":null}', at);
      insertPerson(db.raw, 'legacy-opted-person');
      db.raw.prepare(`INSERT INTO activities(id,person_id,kind,direction,channel,occurred_at,metadata_json,created_at)
        VALUES('legacy-optout-activity','legacy-opted-person','opt_out','inbound','manual',?,'{}',?)`).run(at, at);
      db.raw.prepare('INSERT INTO opt_out_tombstones VALUES(?,?,?,?,?,?,?,?)').run('legacy-optout', 'legacy-opted-person', at, 'manual', 'legacy-optout-activity', 'original-optout-evidence', 'legacy-policy', at);
      db.raw.prepare('UPDATE persons SET opted_out=1,opted_out_at=? WHERE id=?').run(at, 'legacy-opted-person');
      db.raw.prepare('INSERT INTO opt_out_handles VALUES(?,?,?,?,?)').run('legacy-handle', 'legacy-optout', 'email', 'opted@example.invalid', at);
      db.raw.prepare('INSERT INTO opt_out_closure_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run('legacy-optout-activity', 'apply', 'legacy-opted-person', 'legacy-optout', null, null, null, '{"legacy":"optout-command"}', '{"legacy":"closure","handles":[{"id":"legacy-handle","kind":"email","normalizedValue":"opted@example.invalid"}]}', at);
      db.raw.prepare('INSERT INTO opt_out_closure_receipt_handles VALUES(?,?,?,?)').run('legacy-optout-activity', 'legacy-optout', 'legacy-handle', 0);
      db.raw.prepare('INSERT INTO backup_receipts VALUES(?,?,?,?,?,?,?,?)').run('legacy-backup', 'fictional-daily.sqlite3', 'daily', 19, 'd'.repeat(64), 100, at, at);
      db.raw.prepare('INSERT INTO restore_drill_receipts VALUES(?,?,?)').run(at, 'legacy-backup', 'd'.repeat(64));
      db.raw.prepare('INSERT INTO identity_repair_events VALUES(?,?,?,?,?,?,?)')
        .run('legacy-repair', 'e'.repeat(64), 'legacy-candidate', prospect.personId, '[]', JSON.stringify([prospect.sourceEventId]), at);
      const unitOfWork = new DomainUnitOfWork(db);
      unitOfWork.immediate(() => new CadenceRepository({ database: db, unitOfWork, clock: { now: () => at } }).installBuiltins());
      const before = historicalRows(db.raw);
      expect(before.cadence_definitions.length).toBeGreaterThan(0);
      expect(before.cadence_steps.length).toBeGreaterThan(0);
      expect(before.cadence_action_components.length).toBeGreaterThan(0);
      expect(db.raw.pragma('foreign_key_check')).toEqual([]);
      closeDatabase(db); db = openDatabase({ path: temp.path, key });
      const result = await migrateToLatest(db, options);
      expect(result).toEqual({ fromVersion: 19, toVersion: 22,
        appliedMigrationIds: ['0020PmAccounts', '0021DelegatedWork', '0022MailPersistence'] });
      expect(db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 22 });
      expect(historicalRows(db.raw)).toEqual(before);
      // All original catalog objects retain their exact SQL. Added objects are checked separately.
      expect(catalog(db.raw).filter(row => originalCatalog.some(old => old.name === row.name))).toEqual(originalCatalog);
      expect(db.raw.prepare('SELECT id,status,message_id,notice FROM email_drafts WHERE id=?').get('legacy-unknown'))
        .toEqual({ id: 'legacy-unknown', status: 'unknown', message_id: null, notice: null });
      for (const table of ['pm_accounts', 'pm_account_sources', 'pm_account_routes', 'cadence_enrollments',
        'delegated_authorities', 'delegated_mail_cursors', 'delegated_reply_drafts']) {
        expect(db.raw.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(db.raw.prepare('SELECT new_call_slots,total_call_capacity FROM meeting_first_call_settings').get())
        .toEqual({ new_call_slots: null, total_call_capacity: null });
      expect(db.raw.pragma('foreign_key_check')).toEqual([]);
      expect(db.raw.pragma('integrity_check', { simple: true })).toBe('ok');
      closeDatabase(db); db = openDatabase({ path: temp.path, key });
      expect(historicalRows(db.raw)).toEqual(before);
      expect((await migrateToLatest(db, options)).appliedMigrationIds).toEqual([]);
    } finally { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); }
  });
});
