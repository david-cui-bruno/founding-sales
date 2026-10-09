import { seedFirm } from './support/crmSeed.ts';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

it.each([
  ['deleted', '/crm/business/mail/read'],
  ['awaiting_recapture', '/crm/business/mail/evidence/read'],
  ['legacy', '/crm/business/mail/read'],
  ['legacy', '/crm/business/mail/evidence/read'],
  ['owned_admin_firm_exception', '/crm/business/mail/read'],
  ['owned_admin_firm_exception', '/crm/business/mail/evidence/read'],
  ['owned_admin_changed', '/crm/business/mail/read'],
  ['owned_admin_changed', '/crm/business/mail/evidence/read'],
])(
  'requires a committed content-free audit before an exceptional admin publishes %s through %s',
  async (state, path) => {
    const fixture = await createAuthFixture();
    try {
      const { workspaceId, salesperson, admin } = fixture.alpha;
      const grant = await issueSessionFor(fixture, fixture.alpha, admin);
      const sourceId = randomUUID();
      const mailbox = (
        await fixture.db.query<{ id: string }>(
          "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','google-owner','connected') RETURNING id",
          [
            workspaceId,
            state.startsWith('owned_admin') ? admin.userId : salesperson.userId,
          ],
        )
      ).rows[0]!;
      if (state === 'legacy') {
        await fixture.db.query(
          "INSERT INTO mail_messages(workspace_id,id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date) VALUES($1,$2,$3,'legacy-message','legacy-thread','incoming',now())",
          [workspaceId, sourceId, mailbox.id],
        );
      } else {
        const job = await enqueueJob(fixture.db, {
          workspaceId,
          kind: 'crm.mail_capture',
          idempotencyKey: 'opaque-audit-fixture',
          payload: {},
        });
        const identity = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,source_id,lease_fencing_token,job_id,state) VALUES($1,$2,$3,'opaque-message',$4,1,$5,'blocked') RETURNING id",
            [workspaceId, mailbox.id, 'a'.repeat(64), sourceId, job.jobId],
          )
        ).rows[0]!;
        if (state.startsWith('owned_admin')) {
          const firmId = await seedFirm(fixture, {
            name: 'Assignment exception firm',
            assignedUserId: salesperson.userId,
          });
          await fixture.db.query(
            "INSERT INTO mail_messages(workspace_id,id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date) VALUES($1,$2,$3,'opaque-message','opaque-thread','incoming',now())",
            [workspaceId, sourceId, mailbox.id],
          );
          const conversation = (
            await fixture.db.query<{ id: string }>(
              "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,repeat('a',64),'opaque-thread','', '[]',now(),'business','fixture','fixture',repeat('c',64)) RETURNING id",
              [workspaceId, mailbox.id, admin.userId],
            )
          ).rows[0]!;
          await fixture.db.query(
            "INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,provider_at) VALUES($1,$2,$3,1,repeat('b',64),$4,$5,'google-owner',repeat('a',64),1,1,1,$6,0,'fixture',repeat('c',64),'{}','fixture','plain_text','partial','[]','[]',now())",
            [
              workspaceId,
              sourceId,
              identity.id,
              admin.userId,
              mailbox.id,
              conversation.id,
            ],
          );
          await fixture.db.query(
            "INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,firm_id,context_kind) VALUES($1,$2,1,$3,'acquired')",
            [workspaceId, sourceId, firmId],
          );
        } else {
          await fixture.db.query(
            'INSERT INTO crm_mail_acquisition_tombstones(workspace_id,capture_identity_id,source_id,owner_user_id,source_revision,content_hash,availability) VALUES($1,$2,$3,$4,1,$5,$6)',
            [
              workspaceId,
              identity.id,
              sourceId,
              salesperson.userId,
              'b'.repeat(64),
              state,
            ],
          );
        }
      }
      const request = {
        method: 'POST',
        path,
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: (state === 'owned_admin_changed' ? 'a' : 'b').repeat(64),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${grant.accessToken}` },
      };
      const options = {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      };
      const expectedReason =
        state === 'legacy' ? 'provenance_unavailable' : state;
      expect((await dispatch(request, options)).body).toMatchObject(
        state === 'owned_admin_changed'
          ? { state: 'unavailable', reason: 'source_changed' }
          : state.startsWith('owned_admin')
            ? path.endsWith('evidence/read')
              ? { state: 'unavailable', reason: 'body_unavailable' }
              : { state: 'available' }
            : { state: 'unavailable', reason: expectedReason },
      );
      // A database fault is the external failure boundary; no audit collaborator is mocked.
      await fixture.db.query(
        "CREATE FUNCTION test_refuse_mail_status_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.mail_source_admin_read' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$",
      );
      await fixture.db.query(
        'CREATE TRIGGER test_refuse_mail_status_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_refuse_mail_status_audit()',
      );
      await expect(dispatch(request, options)).rejects.toThrow(
        'fixture audit unavailable',
      );
      await fixture.db.query(
        'DROP TRIGGER test_refuse_mail_status_audit ON audit_events',
      );
      // Reject copied content in the audit itself before allowing publication again.
      await fixture.db.query(
        "CREATE FUNCTION test_validate_mail_status_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.mail_source_admin_read' AND (NEW.subject_kind<>'mail_source' OR NEW.detail - 'sourceRevision' <> '{}'::jsonb OR NEW.detail->>'sourceRevision'<>'1') THEN RAISE EXCEPTION 'fixture content in status audit'; END IF; RETURN NEW; END $$",
      );
      await fixture.db.query(
        'CREATE TRIGGER test_validate_mail_status_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_validate_mail_status_audit()',
      );
      expect((await dispatch(request, options)).body).toMatchObject(
        state === 'owned_admin_changed'
          ? { state: 'unavailable', reason: 'source_changed' }
          : state.startsWith('owned_admin')
            ? path.endsWith('evidence/read')
              ? { state: 'unavailable', reason: 'body_unavailable' }
              : { state: 'available' }
            : { state: 'unavailable', reason: expectedReason },
      );
    } finally {
      await fixture.stop();
    }
  },
);
