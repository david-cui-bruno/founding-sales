import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {CHANNEL_ACTION_KINDS,composeEligibility} from '@fss/domain/sequences/eligibility.ts';
import {readEnrollment,nextUnfinishedExecution} from '@fss/domain/sequences/rows.ts';
import type {FixtureHandles} from './fixture.ts';
export interface SequenceUpgradeDecisions {eligibility:string;prospecting:string;followUp:string}
/** Existing upgraded-data eligibility probes, isolated from unrelated workflow orchestration. */
export async function runSequenceEligibilityUpgradeWorkflow(session:SessionQueryable,handles:FixtureHandles,now:string,expected:SequenceUpgradeDecisions):Promise<string>{
 const {eligibility:EXPECTED_ELIGIBILITY_DECISION,prospecting:EXPECTED_PROSPECTING_DECISION,followUp:EXPECTED_FOLLOW_UP_DECISION}=expected;
        // Any active enrollment with a step still to do, the fixture's own preferred.
        // A step with nothing pending would make this case assert nothing at all, so it
        // is looked for across the fixture rather than only in the bootstrapped
        // workspace — the shared two-workspace fixture has enrolments too.
        const candidates = await session.query<{ id: string; workspace_id: string }>(
          `SELECT e.id, e.workspace_id
             FROM sequence_enrollments e
             JOIN step_executions s ON s.enrollment_id = e.id AND s.state IN ('pending', 'held')
            WHERE e.state = 'active'
            ORDER BY (e.workspace_id = $1) DESC, (e.id = $2) DESC
            LIMIT 1`,
          [handles.workspaceId, handles.activeEnrollmentId],
        );
        const candidate = candidates.rows[0];
        if (candidate === undefined) {
          // A skip is a failure here (P1-3): an eligibility gate with nothing to decide
          // about asserts nothing, and the fixture is supposed to leave it work.
          throw new Error('no active enrolment has an unfinished step; the fixture should leave one');
        }
        // The scope the worker itself uses for a sequence job (`scopeForJob`): the
        // eligibility gate is evaluated by the worker, never by a person, and an
        // assignment source asked under the wrong actor would answer a different
        // question.
        const worker = repositoryContext(
          workspaceScope(candidate.workspace_id, { kind: 'system', component: 'worker' }),
          session,
        );
        const enrollment = await readEnrollment(worker, { enrollmentId: candidate.id });
        if (enrollment === null) throw new Error('the active enrollment disappeared');
        const execution = await nextUnfinishedExecution(worker, candidate.id);
        if (execution === null) throw new Error('the step that was there a statement ago is gone');
        // The decision itself is not asserted: what this step proves is that the gate
        // still evaluates on upgraded data rather than throwing. A refusal is a
        // decision, and it is printed.
        const outcome = await composeEligibility().evaluate(worker, {
          execution,
          opportunityId: enrollment.opportunityId,
          firmId: enrollment.firmId,
          contactId: enrollment.contactId,
          ownerUserId: enrollment.assignedUserId,
          channel: execution.channel,
          actionKind: CHANNEL_ACTION_KINDS[execution.channel],
          now,
        });
        // The expected decision, named. The fixture's active enrolment was written by
        // the deployed checkout, which has no `origin_kind` to write, so migration
        // 0025's DEFAULT makes it `cold_legacy` and `followUpPermissionSource` — the
        // first source after suppression — refuses it. A different answer means the gate
        // now decides something else about the same rows, which is exactly what an
        // upgrade could break.
        if (outcome.ok) {
          throw new Error(`expected the hold ${EXPECTED_ELIGIBILITY_DECISION}, and the step was eligible`);
        }
        if (outcome.reasonCode !== EXPECTED_ELIGIBILITY_DECISION) {
          throw new Error(
            `expected the hold ${EXPECTED_ELIGIBILITY_DECISION}, got ${outcome.reasonCode}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`,
          );
        }
        // And a row with a real origin written after the upgrade (P2-2 of the GPT-6 review
        // of PR 332). Since send-path v2 (slice S4) its answer is the cold-outreach rule,
        // not the pause: see `EXPECTED_PROSPECTING_DECISION`. `cold_legacy` is refused before every other
        // source, so the legacy enrollment above no longer proves that the workspace
        // switch still holds an otherwise-sendable step. This fixture is written *after*
        // the upgrade, by the new code, with an origin the deployed checkout could not
        // write: the same firm, the same person, an enrollment of its own that is
        // `prospecting` rather than legacy, and a step that is due.
        // Its own person, so the one-live-enrollment-per-contact rule is not the thing
        // this probe runs into, and its own usable address, because a step with no route
        // is refused for that instead.
        const probeContact = await session.query<{ id: string }>(
          `WITH person AS (
             INSERT INTO contacts (workspace_id, firm_id, full_name)
             SELECT e.workspace_id, e.firm_id, 'Upgrade Probe'
               FROM sequence_enrollments e WHERE e.workspace_id = $1 AND e.id = $2
             RETURNING id, workspace_id, firm_id
           ), route AS (
             INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                          association_confidence, technical_validation, eligibility,
                                          eligibility_policy_version)
             SELECT p.workspace_id, p.firm_id, p.id, 'upgrade.probe@example.test', 'research_provider', now(),
                    0.900, 'passed', 'usable', 'route-policy.1'
               FROM person p
             RETURNING contact_id
           )
           SELECT id FROM person`,
          [candidate.workspace_id, candidate.id],
        );
        const probeContactId = probeContact.rows[0]?.id;
        if (probeContactId === undefined) throw new Error('the post-upgrade probe contact was not written');
        const probe = await session.query<{ id: string }>(
          `WITH enrolled AS (
             INSERT INTO sequence_enrollments
               (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
                started_at, firm_time_zone, holiday_calendar_version, origin_kind)
             SELECT e.workspace_id, e.sequence_version_id, e.opportunity_id, e.firm_id, $3::uuid,
                    e.assigned_user_id, now(), e.firm_time_zone, e.holiday_calendar_version, 'prospecting'
               FROM sequence_enrollments e
              WHERE e.workspace_id = $1 AND e.id = $2
              RETURNING id, workspace_id, firm_id, contact_id, sequence_version_id
           )
           INSERT INTO step_executions
             (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
              due_at, not_before, original_due_at, source_zone, rule_version)
           SELECT n.workspace_id, n.id, s.id, n.firm_id, n.contact_id, s.channel, s.ordinal,
                  now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour',
                  'America/New_York', 'elapsed.1'
             FROM enrolled n
             JOIN sequence_steps s
               ON s.workspace_id = n.workspace_id AND s.sequence_version_id = n.sequence_version_id
            ORDER BY s.ordinal
            LIMIT 1
           RETURNING enrollment_id AS id`,
          [candidate.workspace_id, candidate.id, probeContactId],
        );
        const probeEnrollmentId = probe.rows[0]?.id;
        if (probeEnrollmentId === undefined) throw new Error('the post-upgrade probe enrolment was not written');
        const probeEnrollment = await readEnrollment(worker, { enrollmentId: probeEnrollmentId });
        const probeExecution = await nextUnfinishedExecution(worker, probeEnrollmentId);
        if (probeEnrollment === null || probeExecution === null) {
          throw new Error('the post-upgrade probe enrolment has no step');
        }
        const probeOutcome = await composeEligibility().evaluate(worker, {
          execution: probeExecution,
          opportunityId: probeEnrollment.opportunityId,
          firmId: probeEnrollment.firmId,
          contactId: probeEnrollment.contactId,
          ownerUserId: probeEnrollment.assignedUserId,
          channel: probeExecution.channel,
          actionKind: CHANNEL_ACTION_KINDS[probeExecution.channel],
          now,
        });
        if (probeOutcome.ok) {
          throw new Error(`expected ${EXPECTED_PROSPECTING_DECISION} on the post-upgrade probe, and it was eligible`);
        }
        if (probeOutcome.reasonCode !== EXPECTED_PROSPECTING_DECISION) {
          throw new Error(
            `expected ${EXPECTED_PROSPECTING_DECISION} on the post-upgrade probe, got ${probeOutcome.reasonCode}`,
          );
        }
        // The probe is a fixture, not a row the upgraded deployment should keep.
        await session.query(
          'DELETE FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2',
          [candidate.workspace_id, probeEnrollmentId],
        );
        await session.query('DELETE FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2', [
          candidate.workspace_id,
          probeEnrollmentId,
        ]);
        await session.query('DELETE FROM email_addresses WHERE workspace_id = $1 AND contact_id = $2', [
          candidate.workspace_id,
          probeContactId,
        ]);
        await session.query('DELETE FROM contacts WHERE workspace_id = $1 AND id = $2', [
          candidate.workspace_id,
          probeContactId,
        ]);

        // The evidenced follow-up probe (P1-b): written, asked and rolled back in one
        // transaction of its own, so nothing it writes outlives the question. The
        // workflows run on an autocommit session, so this BEGIN is the outermost one.
        let followUpOutcome: Awaited<ReturnType<ReturnType<typeof composeEligibility>['evaluate']>>;
        await session.query('BEGIN');
        try {
          const followUp = await session.query<{ enrollment_id: string }>(
            `WITH source AS (
               SELECT e.workspace_id, e.firm_id, e.opportunity_id, e.assigned_user_id, e.sequence_version_id,
                      e.firm_time_zone, e.holiday_calendar_version
                 FROM sequence_enrollments e WHERE e.workspace_id = $1 AND e.id = $2
             ), person AS (
               INSERT INTO contacts (workspace_id, firm_id, full_name)
               SELECT workspace_id, firm_id, 'Upgrade Follow-up Probe' FROM source
               RETURNING id, workspace_id, firm_id
             ), route AS (
               INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                            association_confidence, technical_validation, eligibility,
                                            eligibility_policy_version)
               SELECT p.workspace_id, p.firm_id, p.id, 'upgrade.follow-up.probe@example.test', 'research_provider',
                      now(), 0.900, 'passed', 'usable', 'route-policy.1'
                 FROM person p
               RETURNING contact_id
             ), call AS (
               INSERT INTO call_logs (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect,
                                      occurred_at, actor_user_id, agreed_follow_up, agreed_sequence_version_id)
               SELECT s.workspace_id, s.firm_id, p.id, s.opportunity_id, 'interested', 'none',
                      now() - interval '1 second', s.assigned_user_id, 'agreed_sequence', s.sequence_version_id
                 FROM source s CROSS JOIN person p
               RETURNING id
             ), permission AS (
               INSERT INTO follow_up_permissions (workspace_id, firm_id, contact_id, kind, scope, call_log_id,
                                                  sequence_version_id, max_steps, expires_at, granted_by_user_id, note)
               SELECT s.workspace_id, s.firm_id, p.id, 'agreed_sequence', 'agreed_sequence', c.id,
                      s.sequence_version_id,
                      (SELECT count(*) FROM sequence_steps st
                        WHERE st.workspace_id = s.workspace_id AND st.sequence_version_id = s.sequence_version_id),
                      now() + interval '365 days', s.assigned_user_id, 'upgrade test follow-up probe'
                 FROM source s CROSS JOIN person p CROSS JOIN call c
               RETURNING id
             ), enrolled AS (
               INSERT INTO sequence_enrollments
                 (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
                  started_at, firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
               SELECT s.workspace_id, s.sequence_version_id, s.opportunity_id, s.firm_id, p.id, s.assigned_user_id,
                      now(), s.firm_time_zone, s.holiday_calendar_version, 'follow_up', m.id
                 FROM source s CROSS JOIN person p CROSS JOIN permission m
               RETURNING id, workspace_id, firm_id, contact_id, sequence_version_id, permission_id
             )
             INSERT INTO step_executions
               (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
                due_at, not_before, original_due_at, source_zone, rule_version)
             SELECT n.workspace_id, n.id, st.id, n.firm_id, n.contact_id, st.channel, st.ordinal,
                    now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour',
                    'America/New_York', 'elapsed.1'
               FROM enrolled n
               JOIN sequence_steps st
                 ON st.workspace_id = n.workspace_id AND st.sequence_version_id = n.sequence_version_id
              ORDER BY st.ordinal
              LIMIT 1
             RETURNING enrollment_id`,
            [candidate.workspace_id, candidate.id],
          );
          const followUpEnrollmentId = followUp.rows[0]?.enrollment_id;
          if (followUpEnrollmentId === undefined) throw new Error('the post-upgrade follow-up probe was not written');
          // The permission buys this run (`bindFollowUpPermission`). A separate statement:
          // the data-modifying CTEs above cannot see each other's rows.
          const bound = await session.query(
            `UPDATE follow_up_permissions f SET enrollment_id = n.id
               FROM sequence_enrollments n
              WHERE n.workspace_id = $1 AND n.id = $2
                AND f.workspace_id = n.workspace_id AND f.id = n.permission_id AND f.enrollment_id IS NULL`,
            [candidate.workspace_id, followUpEnrollmentId],
          );
          if (bound.rowCount !== 1) throw new Error('the post-upgrade follow-up probe permission was not bound');
          const followUpEnrollment = await readEnrollment(worker, { enrollmentId: followUpEnrollmentId });
          const followUpExecution = await nextUnfinishedExecution(worker, followUpEnrollmentId);
          if (followUpEnrollment === null || followUpExecution === null) {
            throw new Error('the post-upgrade follow-up probe has no step');
          }
          followUpOutcome = await composeEligibility().evaluate(worker, {
            execution: followUpExecution,
            opportunityId: followUpEnrollment.opportunityId,
            firmId: followUpEnrollment.firmId,
            contactId: followUpEnrollment.contactId,
            ownerUserId: followUpEnrollment.assignedUserId,
            channel: followUpExecution.channel,
            actionKind: CHANNEL_ACTION_KINDS[followUpExecution.channel],
            now,
          });
        } finally {
          await session.query('ROLLBACK');
        }
        if (followUpOutcome.ok) {
          throw new Error(`expected ${EXPECTED_FOLLOW_UP_DECISION} on the post-upgrade follow-up probe, and it was eligible`);
        }
        if (followUpOutcome.reasonCode !== EXPECTED_FOLLOW_UP_DECISION) {
          throw new Error(
            `expected ${EXPECTED_FOLLOW_UP_DECISION} on the post-upgrade follow-up probe, got ${followUpOutcome.reasonCode}${followUpOutcome.detail === undefined ? '' : ` (${followUpOutcome.detail})`}`,
          );
        }

        return `held: ${outcome.reasonCode}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}; post-upgrade prospecting probe: ${probeOutcome.reasonCode}; post-upgrade follow-up probe: ${followUpOutcome.reasonCode}`;
}
