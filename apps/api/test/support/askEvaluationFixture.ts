import { createHash, randomUUID } from "node:crypto";
import { crmResolvedSourceSchema } from "@fss/contracts";
import type { DevelopmentLabelTemplate } from "../../../../tools/ask-evaluation/labels.ts";
import type { AuthFixture } from "./authFixture.ts";
import { CURRENT_CLIENT_VERSION } from "./authFixture.ts";
import { seedFirm } from "./crmSeed.ts";
import type { dispatch } from "../../src/server.ts";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type EvaluationFixturePost = (
  path: string,
  body: unknown,
) => ReturnType<typeof dispatch>;
async function createCopy(
  fixture: AuthFixture,
  post: EvaluationFixturePost,
  label: DevelopmentLabelTemplate,
  index: number,
  firmId: string,
) {
  let sourceId: string, contentHash: string, locator: string;
  const text = label.originalText;
  if (label.sourceKind === "selected_note") {
    const person = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: label.identityName,
    });
    if (person.status !== 200)
      throw new Error("synthetic_fixture_setup_failed");
    const personId = (person.body as { result: { personId: string } }).result
      .personId;
    const selected = await post("/crm/people/source/add", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      personId,
      sourceKey: label.caseId,
      excerpt: text,
      occurredAt: "2026-10-01T14:00:00Z",
    });
    if (selected.status !== 200)
      throw new Error("synthetic_fixture_setup_failed");
    sourceId = (selected.body as { result: { sourceId: string } }).result
      .sourceId;
    contentHash = createHash("sha256").update(text).digest("hex");
    locator = `text:0:${text.length}`;
  } else if (label.sourceKind === "meeting_transcript") {
    const meetingId = randomUUID(),
      recordingId = randomUUID();
    sourceId = randomUUID();
    await fixture.db.query(
      "INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",
      [fixture.alpha.workspaceId, meetingId, firmId],
    );
    const recordingHash = createHash("sha256")
      .update(label.caseId)
      .digest("hex");
    await fixture.db.query(
      "INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status,crm_capture_owner_user_id) VALUES($1,$2,$3,1,'Synthetic meeting',$4,100,$5,'ready',$6)",
      [
        fixture.alpha.workspaceId,
        recordingId,
        meetingId,
        recordingHash,
        `meetings/${meetingId}/${recordingHash}.m4a`,
        fixture.alpha.salesperson.userId,
      ],
    );
    const utterances = [
      {
        startMs: 0,
        endMs: 5000,
        text,
        speaker: "Speaker 1",
        attribution: "unknown",
      },
    ];
    await fixture.db.query(
      "INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",
      [
        fixture.alpha.workspaceId,
        sourceId,
        recordingId,
        JSON.stringify(utterances),
      ],
    );
    contentHash = createHash("sha256")
      .update(JSON.stringify(utterances))
      .digest("hex");
    locator = `utterance:0:text:0:${text.length}`;
  } else if (label.sourceKind === "call_transcript") {
    const ws = fixture.alpha.workspaceId,
      user = fixture.alpha.salesperson.userId;
    sourceId = randomUUID();
    const phone = `+14015550${String(index + 100).padStart(3, "0")}`;
    const route = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,'research_provider',now(),0.9,'passed','usable','fixture.1') RETURNING id",
        [ws, firmId, phone],
      )
    ).rows[0]!.id;
    const identity = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,$3,'verified',false,now(),$2,'owner_attestation') RETURNING id",
        [ws, user, phone],
      )
    ).rows[0]!.id;
    const existing = (
      await fixture.db.query<{ id: string }>(
        "SELECT id FROM state_postures WHERE workspace_id=$1 AND state='RI'",
        [ws],
      )
    ).rows[0];
    const posture =
      existing?.id ??
      (
        await fixture.db.query<{ id: string }>(
          "INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",
          [ws, fixture.alpha.admin.userId],
        )
      ).rows[0]!.id;
    const device = (
      await fixture.db.query<{ id: string }>(
        "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
        [ws, user],
      )
    ).rows[0]!.id;
    const ticket = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,$2,$3,$4,1,$5,1,$6,$7,$8,$7,$9,'America/New_York',now()+interval '30 seconds') RETURNING id",
        [
          ws,
          label.caseId,
          firmId,
          route,
          posture,
          identity,
          user,
          device,
          phone,
        ],
      )
    ).rows[0]!.id;
    const reservation = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",
        [ws, sourceId],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",
      [ws, sourceId, ticket, firmId, user, reservation],
    );
    const utterances = [{ speaker: 1, start: 0, end: 5, text }];
    await fixture.db.query(
      "INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",
      [ws, sourceId, JSON.stringify(utterances)],
    );
    contentHash = createHash("sha256")
      .update(JSON.stringify(utterances))
      .digest("hex");
    locator = `utterance:0:text:0:${text.length}`;
  } else {
    const ws = fixture.alpha.workspaceId,
      user = fixture.alpha.salesperson.userId;
    const { businessAccountBinding } =
      await import("@fss/domain/business/acquisition.ts");
    const { enqueueJob, claimJobs } =
      await import("@fss/domain/jobs/jobStore.ts");
    const { businessMailCaptureHandler } =
      await import("@fss/domain/mail/crmSources.ts");
    const { workspaceScope } = await import("@fss/domain/db/workspaceScope.ts");
    const account = "synthetic-development-account";
    const existingMailbox = (
      await fixture.db.query<{ id: string }>(
        "SELECT id FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2",
        [ws, user],
      )
    ).rows[0];
    const mailbox =
      existingMailbox === undefined
        ? (
            await fixture.db.query<{
              id: string;
              owner_user_id: string;
              email_address: string;
              provider_account_id: string;
              generation: number;
              status: string;
            }>(
              "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'synthetic-dev@example.test',$3,'connected') RETURNING *",
              [ws, user, account],
            )
          ).rows[0]!
        : (
            await fixture.db.query<{
              id: string;
              owner_user_id: string;
              email_address: string;
              provider_account_id: string;
              generation: number;
              status: string;
            }>(
              "UPDATE mailboxes SET provider_account_id=$3,status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *",
              [ws, existingMailbox.id, account],
            )
          ).rows[0]!;
    const binding = businessAccountBinding(ws, mailbox)!;
    await fixture.db.query(
      "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false) ON CONFLICT DO NOTHING",
      [ws, mailbox.id, user, account, binding],
    );
    const conversationId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Synthetic','[]',now(),'business','fixture','fixture',$6) RETURNING id",
        [ws, mailbox.id, user, binding, label.caseId, hash(label.caseId)],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'fixture',$6,'fixture','fixture','fixture','fixture') ON CONFLICT DO NOTHING",
      [ws, mailbox.id, user, account, binding, hash("synthetic")],
    );
    // Controlled operational metadata binds this synthetic copy's original firm before acquisition.
    const lineage = await post("/opportunities/v2/open", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      name: `Synthetic closed acquisition ${label.caseId}`,
      stageKey: "new",
    });
    if (lineage.status !== 200)
      throw new Error("synthetic_fixture_setup_failed");
    const opportunityId = (
      lineage.body as { result: { opportunityId: string } }
    ).result.opportunityId;
    const closed = await post("/opportunities/stage", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      opportunityId,
      expectedStageKey: "new",
      toStageKey: "lost",
      reason: "Synthetic acquisition context only",
    });
    if (closed.status !== 200)
      throw new Error("synthetic_fixture_setup_failed");
    const messageId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,$3,$3,'incoming','2026-10-01T14:00:00Z',true) RETURNING id",
        [ws, mailbox.id, label.caseId],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread')",
      [ws, messageId, firmId, opportunityId],
    );
    await enqueueJob(fixture.db, {
      workspaceId: ws,
      kind: "crm.mail_capture",
      idempotencyKey: label.caseId,
      payload: {
        mailboxId: mailbox.id,
        providerMessageId: label.caseId,
        providerAccountId: account,
        generation: 1,
        conversationId,
        controlsRevision: 1,
        policyRevision: 1,
        decisionRevision: 0,
      },
    });
    const job = (
      await claimJobs(fixture.db, {
        owner: "synthetic-fixture",
        kinds: ["crm.mail_capture"],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0]!;
    const capture = await businessMailCaptureHandler({
      proofVerifier: { verify: async () => true },
      provider: {
        read: async () => ({
          providerAccountId: account,
          messageId: label.caseId,
          threadId: label.caseId,
          labels: ["INBOX"],
          providerAt: "2026-10-01T14:00:00Z",
          rawSenderDate: null,
          from: `sender-${label.caseId}@example.test`,
          to: [mailbox.email_address],
          cc: [],
          subject: "Synthetic",
          body: text,
          parserVersion: "fixture-v1",
          representation: "plain_text",
          completeness: "partial",
          ranges: [{ start: 0, end: text.length, kind: "unknown" }],
        }),
      },
    }).handle({
      session: fixture.db,
      scope: workspaceScope(ws, { kind: "system", component: "worker" }),
      job,
    });
    if (capture?.done !== true || capture.progress["outcome"] !== "captured")
      throw new Error("synthetic_fixture_setup_failed");
    sourceId = String(capture!.progress["sourceId"]);
    contentHash = createHash("sha256").update(text).digest("hex");
    locator = `text:0:${text.length}`;
  }
  const sourceRead = await post("/crm/processing/source/read", {
    workspaceId: fixture.alpha.workspaceId,
    sourceId,
    kind: label.sourceKind,
    revision: 1,
    contentHash,
    locator,
  });
  if (sourceRead.status !== 200)
    throw new Error("synthetic_fixture_setup_failed");
  const source = crmResolvedSourceSchema.parse(sourceRead.body).source;
  return { sourceId, contentHash, source, text };
}
/** Only approved synthetic fixture setup; no evaluation, gold binding or retrieval scoring. */
export async function setupEvaluationCase(
  fixture: AuthFixture,
  post: EvaluationFixturePost,
  label: DevelopmentLabelTemplate,
  index: number,
) {
  const firmId = await seedFirm(fixture, {
    name: label.identityName,
    regionCode: "RI",
    assignedUserId: fixture.alpha.salesperson.userId,
  });
  const copies = [];
  const scripts = label.sourceLabels ?? [
    { slot: "original", originalText: label.originalText },
  ];
  for (const [ordinal, script] of scripts.entries()) {
    const copied = await createCopy(
      fixture,
      post,
      {
        ...label,
        caseId: `${label.caseId}_copy_${ordinal}`,
        identityName: `${label.identityName} Copy ${ordinal}`,
        originalText: script.originalText,
      },
      index * 4 + ordinal,
      firmId,
    );
    copies.push({ ...copied, slot: script.slot, ordinal });
  }
  const opportunityRecords = [];
  for (
    let ordinal = 0;
    ordinal < (label.expectedOpenOpportunities ?? 0);
    ordinal++
  ) {
    const name = `Synthetic pilot ${ordinal + 1}`;
    const opened = await post("/opportunities/v2/open", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      name,
      stageKey: "new",
    });
    if (opened.status !== 200)
      throw new Error("synthetic_fixture_setup_failed");
    const opportunityId = (opened.body as { result: { opportunityId: string } })
      .result.opportunityId;
    const openedAt = `2026-10-0${ordinal + 1}T14:00:00.000Z`;
    await fixture.db.query(
      "UPDATE opportunities SET opened_at=$3 WHERE workspace_id=$1 AND id=$2",
      [fixture.alpha.workspaceId, opportunityId, openedAt],
    );
    opportunityRecords.push({
      opportunityId,
      firmId,
      name,
      status: "open",
      stageKey: "new",
      openedAt,
    });
  }
  return { firmId, copies, opportunityRecords };
}
export async function destroyEvaluationFixture(
  fixture: AuthFixture,
): Promise<void> {
  await fixture.stop();
}
