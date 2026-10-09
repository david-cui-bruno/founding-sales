import { CRM_COMMITMENT_CONSTRAINT_CASES } from "./support/crmCommitmentCases.ts";
import { CRM_BACKFILL_CONSTRAINT_CASES } from './support/crmBackfillCases.ts';
import { CRM_EVIDENCE_CONSTRAINT_CASES } from "./support/crmEvidenceCases.ts";
import {SELECTED_FILE_CONSTRAINT_CASES} from './support/selectedFileCases.ts';
import {CRM_PROGRESS_CONSTRAINT_CASES} from './support/crmProgressCases.ts';
import { MAIL_CAPTURE_CONSTRAINT_CASES } from './support/mailCaptureCases.ts';
import {BUSINESS_ACQUISITION_CONSTRAINT_CASES} from './support/businessAcquisitionCases.ts';
import {CRM_EXTRACTION_CONSTRAINT_CASES} from './support/crmExtractionCases.ts';
import { SOCIAL_CONSTRAINT_CASES } from './support/socialCases.ts';
import { OUTREACH_CONSTRAINT_CASES } from './support/outreachCases.ts';
import { SOURCING_CONSTRAINT_CASES } from './support/sourcingCases.ts';
import { MEETING_AUTO_RECORDING_CONSTRAINT_CASES } from './support/meetingAutoRecordingCases.ts';
import { MEETING_FOLLOW_THROUGH_CONSTRAINT_CASES } from './support/meetingFollowThroughCases.ts';
import { MEETING_OUTCOMES_CONSTRAINT_CASES } from './support/meetingOutcomesCases.ts';
import { MEETING_TRANSCRIPTION_CONSTRAINT_CASES } from './support/meetingTranscriptionCases.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { payloadHash, seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { IDENTITY_CONSTRAINT_CASES } from './support/identityCases.ts';
import { CRM_CONSTRAINT_CASES } from './support/crmCases.ts';
import { POLICY_CONSTRAINT_CASES } from './support/policyCases.ts';
import { MAIL_CONSTRAINT_CASES } from './support/mailCases.ts';
import { TODAY_CONSTRAINT_CASES } from './support/todayCases.ts';
import { SEQUENCE_CONSTRAINT_CASES } from './support/sequenceCases.ts';
import { CLASSIFICATION_CONSTRAINT_CASES } from './support/classificationCases.ts';
import { SETTINGS_CONSTRAINT_CASES } from './support/settingsCases.ts';
import { RETENTION_CONSTRAINT_CASES } from './support/retentionCases.ts';
import { RELEASE_CONSTRAINT_CASES } from './support/releaseCases.ts';
import { FUNNEL_CONSTRAINT_CASES } from './support/funnelCases.ts';
import { RESEARCH_CONSTRAINT_CASES } from './support/researchCases.ts';
import { FOLLOW_UP_CONSTRAINT_CASES } from './support/followUpCases.ts';
import { SEND_PATH_V2_CONSTRAINT_CASES } from './support/sendPathV2Cases.ts';
import { MAILBOX_ACCOUNTS_CONSTRAINT_CASES } from './support/mailboxAccountsCases.ts';
import { CALL_TO_BOOKING_CONSTRAINT_CASES } from './support/callToBookingCases.ts';
import { MEETING_BOOKING_UIDS_CONSTRAINT_CASES } from './support/meetingBookingUidsCases.ts';
import { CALL_TRANSCRIPTS_CONSTRAINT_CASES } from './support/callTranscriptsCases.ts';
import { CALL_SUMMARIES_CONSTRAINT_CASES } from './support/callSummariesCases.ts';
import { CALL_ANALYSES_CONSTRAINT_CASES } from './support/callAnalysesCases.ts';
import { CALL_PROPOSALS_CONSTRAINT_CASES } from './support/callProposalsCases.ts';
import { TRANSCRIPTION_PROVIDER_JOBS_CONSTRAINT_CASES } from './support/transcriptionProviderJobsCases.ts';
import { PREPARED_BRIEFS_CONSTRAINT_CASES } from './support/preparedBriefsCases.ts';
import { MEETING_ATTENDANCE_CONSTRAINT_CASES } from './support/meetingAttendanceCases.ts';
import { MEETING_BOOKING_DETAILS_CONSTRAINT_CASES } from './support/meetingBookingDetailsCases.ts';
import { MEETING_RECORDINGS_CONSTRAINT_CASES } from './support/meetingRecordingsCases.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';
import { seedMail, type SeededMail } from './support/mailFixtures.ts';
import { OUTBOUND_CONSTRAINT_CASES } from './support/outboundCases.ts';
import { SENDER_RECOVERY_CONSTRAINT_CASES } from './support/senderRecoveryCases.ts';
import { PROVIDER_INCIDENT_CONSTRAINT_CASES } from './support/providerIncidentCases.ts';
import { NOTIFICATION_CONSTRAINT_CASES } from './support/notificationCases.ts';
import { HUMAN_REPLY_CONSTRAINT_CASES } from './support/humanReplyCases.ts';
import { seedOutbound, type SeededOutbound } from './support/outboundFixtures.ts';

/**
 * A failing insert for every foundation constraint.
 *
 * The last test in this file is the one that keeps the rest honest: it asks the
 * database for every CHECK, UNIQUE, FOREIGN KEY, PRIMARY KEY, constraint trigger and
 * partial unique index it has, and fails if any of them has no case above. A future
 * migration that adds a constraint without a failing insert cannot pass the gate.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly holdId: string;
  readonly baseSuppressionEventId: string;
  /**
   * The CRM and mail rows lane G7's cases start from. Seeded once rather than per
   * case: a mailbox is unique per owner, so a case that created its own would
   * spend its first statement inventing a second salesperson.
   */
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
  readonly outbound: SeededOutbound;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** The constraint trigger raises restrict_violation rather than naming a constraint. */
const TRIGGER_CONSTRAINT = "workspace_memberships_last_active_admin";

const workspace = (fixture: Fixture): string =>
  fixture.seeded.alpha.workspaceId;
const admin = (fixture: Fixture): string => fixture.seeded.alpha.admin.userId;
const salesperson = (fixture: Fixture): string =>
  fixture.seeded.alpha.salesperson.userId;
const device = (fixture: Fixture): string =>
  fixture.seeded.alpha.salesperson.deviceId;

/** Valid starting rows for schema70's database-enforced identity/source cases. */
async function seedIndependentPerson(f: Fixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    "INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,'Constraint Person') RETURNING id",
    [workspace(f), admin(f)],
  );
  return rows[0]?.id ?? "";
}
async function seedSelectedSource(
  f: Fixture,
  personId: string,
): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    "INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,'Selected excerpt',$5,now()) RETURNING id",
    [
      workspace(f),
      personId,
      admin(f),
      payloadHash("selected-source-key"),
      payloadHash("selected-excerpt"),
    ],
  );
  return rows[0]?.id ?? "";
}
async function seedSelectedImport(f: Fixture): Promise<string> {
  const sourceId = await seedSelectedSource(f, await seedIndependentPerson(f));
  await f.session.query(
    "INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype,label,participants,attachments,direction,attribution,date_provenance) VALUES($1,$2,$3,$4,$5,'selected-v1','pasted_text','Selected import','[]','[]','unknown','unknown','unknown')",
    [
      workspace(f),
      sourceId,
      admin(f),
      payloadHash("import-key"),
      payloadHash("input"),
    ],
  );
  return sourceId;
}
const selectedImportConstraintCases: readonly Case[] = [
  ...[
    ["crm_selected_imports_import_key_hash_check", "import_key_hash='invalid'"],
    ["crm_selected_imports_input_hash_check", "input_hash='invalid'"],
    ["crm_selected_imports_parser_version_check", "parser_version='unknown'"],
    ["crm_selected_imports_revision_check", "revision=0"],
    ["crm_selected_imports_subtype_check", "subtype='mail'"],
    ["crm_selected_imports_label_check", "label='   '"],
    ["crm_selected_imports_participants_check", "participants='{}'::jsonb"],
    ["crm_selected_imports_attachments_check", "attachments='{}'::jsonb"],
    ["crm_selected_imports_direction_check", "direction='verified_sent'"],
    ["crm_selected_imports_attribution_check", "attribution='verified'"],
    ["crm_selected_imports_date_provenance_check", "date_provenance='guessed'"],
    [
      "crm_selected_imports_workspace_id_owner_user_id_fkey",
      "owner_user_id='00000000-0000-4000-8000-000000000000'",
    ],
    [
      "crm_selected_imports_workspace_id_source_id_fkey",
      "source_id='00000000-0000-4000-8000-000000000000'",
    ],
  ].map(([constraint, assignment]) => ({
    constraint: constraint ?? "",
    run: async (f: Fixture) => {
      const id = await seedSelectedImport(f);
      return f.session.query(
        `UPDATE crm_selected_imports SET ${assignment} WHERE workspace_id=$1 AND source_id=$2`,
        [workspace(f), id],
      );
    },
  })),
  {
    constraint: "crm_selected_imports_workspace_id_fkey",
    run: async (f) =>
      f.session.query(
        "INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype) VALUES('00000000-0000-4000-8000-000000000000',$1,$2,$3,$4,'selected-v1','pasted_text')",
        [
          f.crm.alpha.contactId,
          admin(f),
          payloadHash("key"),
          payloadHash("input"),
        ],
      ),
  },
  {
    constraint: "crm_selected_imports_pkey",
    run: async (f) => {
      const id = await seedSelectedImport(f);
      return f.session.query(
        "INSERT INTO crm_selected_imports SELECT * FROM crm_selected_imports WHERE workspace_id=$1 AND source_id=$2",
        [workspace(f), id],
      );
    },
  },
  {
    constraint:
      "crm_selected_imports_workspace_id_owner_user_id_import_key__key",
    run: async (f) => {
      await seedSelectedImport(f);
      const person = await seedIndependentPerson(f);
      const source = (
        await f.session.query<{ id: string }>(
          "INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash) VALUES($1,$2,$3,$4,'Second excerpt',$5) RETURNING id",
          [
            workspace(f),
            person,
            admin(f),
            payloadHash("other-source"),
            payloadHash("second"),
          ],
        )
      ).rows[0]?.id;
      return f.session.query(
        "INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype) VALUES($1,$2,$3,$4,$5,'selected-v1','pasted_text')",
        [
          workspace(f),
          source,
          admin(f),
          payloadHash("import-key"),
          payloadHash("input"),
        ],
      );
    },
  },
];
const peopleConstraintCases: readonly Case[] = [
  {
    constraint: "crm_people_pkey",
    run: async (f) => {
      const id = await seedIndependentPerson(f);
      return await f.session.query(
        "INSERT INTO crm_people(workspace_id,id,full_name) VALUES($1,$2,'Duplicate')",
        [workspace(f), id],
      );
    },
  },
  {
    constraint: "crm_people_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_people(workspace_id,full_name) VALUES('00000000-0000-4000-8000-000000000000','No workspace')",
      ),
  },
  {
    constraint: "crm_people_workspace_id_owner_user_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,'Other workspace owner')",
        [workspace(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "crm_people_full_name_check",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_people(workspace_id,full_name) VALUES($1,'   ')",
        [workspace(f)],
      ),
  },
  {
    constraint: "crm_people_revision_check",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_people(workspace_id,full_name,revision) VALUES($1,'Invalid revision',0)",
        [workspace(f)],
      ),
  },
  {
    constraint: "crm_legacy_contact_people_pkey",
    run: async (f) => {
      const first = await seedIndependentPerson(f);
      const second = await seedIndependentPerson(f);
      await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)",
        [workspace(f), f.crm.alpha.contactId, first],
      );
      return await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)",
        [workspace(f), f.crm.alpha.contactId, second],
      );
    },
  },
  {
    constraint: "crm_legacy_contact_people_workspace_id_person_id_key",
    run: async (f) => {
      const person = await seedIndependentPerson(f);
      const { rows } = await f.session.query<{ id: string }>(
        "INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,'Another Contact') RETURNING id",
        [workspace(f), f.crm.alpha.firmId],
      );
      await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)",
        [workspace(f), f.crm.alpha.contactId, person],
      );
      return await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)",
        [workspace(f), rows[0]?.id, person],
      );
    },
  },
  {
    constraint: "crm_legacy_contact_people_workspace_id_contact_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)",
        [workspace(f), f.crm.beta.contactId, await seedIndependentPerson(f)],
      ),
  },
  {
    constraint: "crm_legacy_contact_people_workspace_id_person_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,'00000000-0000-4000-8000-000000000000')",
        [workspace(f), f.crm.alpha.contactId],
      ),
  },
  {
    constraint: "crm_selected_sources_pkey",
    run: async (f) => {
      const person = await seedIndependentPerson(f);
      const id = await seedSelectedSource(f, person);
      return await f.session.query(
        "INSERT INTO crm_selected_sources(workspace_id,id,person_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,'Other excerpt',$6,now())",
        [
          workspace(f),
          id,
          person,
          admin(f),
          payloadHash("different-source-key"),
          payloadHash("other-excerpt"),
        ],
      );
    },
  },
  {
    constraint:
      "crm_selected_sources_workspace_id_owner_user_id_source_key__key",
    run: async (f) => {
      const person = await seedIndependentPerson(f);
      await seedSelectedSource(f, person);
      return await seedSelectedSource(f, person);
    },
  },
  ...(
    [
      [
        "crm_selected_sources_workspace_id_person_id_fkey",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_selected_sources_workspace_id_owner_user_id_fkey",
        "owner_user_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_selected_sources_source_key_hash_check",
        "source_key_hash='not-a-hash'",
      ],
      ["crm_selected_sources_revision_check", "revision=0"],
      [
        "crm_selected_sources_availability_check",
        "availability='unrecognized'",
      ],
      ["crm_selected_sources_check", "excerpt=NULL"],
      ["crm_selected_sources_check1", "content_hash=NULL"],
      [
        "crm_selected_sources_date_availability",
        "availability='deleted',excerpt=NULL,content_hash=NULL,occurred_at=now()",
      ],
      ["crm_selected_sources_excerpt_check", "excerpt='   '"],
      ["crm_selected_sources_content_hash_check", "content_hash='not-a-hash'"],
    ] as const
  ).map(([constraint, assignment]): Case => ({
    constraint,
    run: async (f) => {
      const id = await seedSelectedSource(f, await seedIndependentPerson(f));
      return await f.session.query(
        `UPDATE crm_selected_sources SET ${assignment} WHERE workspace_id=$1 AND id=$2`,
        [workspace(f), id],
      );
    },
  })),
];

/** Schema71 constraint fixtures; rows are rolled back independently for each case. */
async function seedRelationshipConstraintRows(f: Fixture) {
  const personId = await seedIndependentPerson(f);
  const sourceId = await seedSelectedSource(f, personId);
  const hash = payloadHash("relationship-source");
  const relationship = await f.session.query<{ id: string }>(
    "INSERT INTO crm_relationships(workspace_id,person_id,firm_id,status,source_id,source_revision,source_hash) VALUES($1,$2,$3,'current',$4,1,$5) RETURNING id",
    [workspace(f), personId, f.crm.alpha.firmId, sourceId, hash],
  );
  const relationshipId = relationship.rows[0]?.id ?? "";
  await f.session.query(
    `INSERT INTO crm_relationship_revisions(workspace_id,relationship_id,revision,person_id,firm_id,status,source_id,source_revision,source_hash,actor_user_id)
     SELECT workspace_id,id,revision,person_id,firm_id,status,source_id,source_revision,source_hash,$3 FROM crm_relationships WHERE workspace_id=$1 AND id=$2`,
    [workspace(f), relationshipId, admin(f)],
  );
  await f.session.query(
    "INSERT INTO crm_source_relationship_contexts(workspace_id,source_id,source_revision,source_hash,relationship_id,relationship_revision,person_id,firm_id) VALUES($1,$2,1,$3,$4,1,$5,$6)",
    [
      workspace(f),
      sourceId,
      hash,
      relationshipId,
      personId,
      f.crm.alpha.firmId,
    ],
  );
  const endpoint = await f.session.query<{ id: string }>(
    "INSERT INTO crm_identity_endpoints(workspace_id,kind,value,value_hash) VALUES($1,'email','shared@example.test',$2) RETURNING id",
    [workspace(f), payloadHash("endpoint-value")],
  );
  const endpointId = endpoint.rows[0]?.id ?? "";
  const claim = await f.session.query<{ id: string }>(
    "INSERT INTO crm_endpoint_claims(workspace_id,endpoint_id,person_id,shared,status,source_id,source_revision,source_hash) VALUES($1,$2,$3,false,'current',$4,1,$5) RETURNING id",
    [workspace(f), endpointId, personId, sourceId, hash],
  );
  const claimId = claim.rows[0]?.id ?? "";
  await f.session.query(
    `INSERT INTO crm_endpoint_claim_revisions(workspace_id,claim_id,revision,endpoint_id,person_id,shared,status,source_id,source_revision,source_hash,actor_user_id)
     SELECT workspace_id,id,revision,endpoint_id,person_id,shared,status,source_id,source_revision,source_hash,$3 FROM crm_endpoint_claims WHERE workspace_id=$1 AND id=$2`,
    [workspace(f), claimId, admin(f)],
  );
}

const relationshipConstraintCases: readonly Case[] = [
  ...(
    [
      ["crm_relationships_revision_check", "crm_relationships", "revision=0"],
      [
        "crm_relationships_source_revision_check",
        "crm_relationships",
        "source_revision=0",
      ],
      [
        "crm_relationships_source_hash_check",
        "crm_relationships",
        "source_hash='not-a-hash'",
      ],
      [
        "crm_relationships_status_check",
        "crm_relationships",
        "status='invalid'",
      ],
      [
        "crm_relationships_workspace_id_person_id_fkey",
        "crm_relationships",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationships_workspace_id_firm_id_fkey",
        "crm_relationships",
        "firm_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationships_workspace_id_source_id_fkey",
        "crm_relationships",
        "source_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationships_check",
        "crm_relationships",
        "start_date=DATE '2026-10-09',end_date=DATE '2026-10-08'",
      ],
      [
        "crm_relationship_revisions_revision_check",
        "crm_relationship_revisions",
        "revision=0",
      ],
      [
        "crm_relationship_revisions_source_revision_check",
        "crm_relationship_revisions",
        "source_revision=0",
      ],
      [
        "crm_relationship_revisions_source_hash_check",
        "crm_relationship_revisions",
        "source_hash='not-a-hash'",
      ],
      [
        "crm_relationship_revisions_status_check",
        "crm_relationship_revisions",
        "status='invalid'",
      ],
      [
        "crm_relationship_revisions_workspace_id_person_id_fkey",
        "crm_relationship_revisions",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationship_revisions_workspace_id_firm_id_fkey",
        "crm_relationship_revisions",
        "firm_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationship_revisions_workspace_id_source_id_fkey",
        "crm_relationship_revisions",
        "source_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationship_revisions_workspace_id_actor_user_id_fkey",
        "crm_relationship_revisions",
        "actor_user_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_relationship_revisions_check",
        "crm_relationship_revisions",
        "start_date=DATE '2026-10-09',end_date=DATE '2026-10-08'",
      ],
      [
        "crm_endpoint_claims_revision_check",
        "crm_endpoint_claims",
        "revision=0",
      ],
      [
        "crm_endpoint_claims_source_revision_check",
        "crm_endpoint_claims",
        "source_revision=0",
      ],
      [
        "crm_endpoint_claims_source_hash_check",
        "crm_endpoint_claims",
        "source_hash='not-a-hash'",
      ],
      [
        "crm_endpoint_claims_status_check",
        "crm_endpoint_claims",
        "status='invalid'",
      ],
      [
        "crm_endpoint_claims_workspace_id_person_id_fkey",
        "crm_endpoint_claims",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claims_workspace_id_firm_id_fkey",
        "crm_endpoint_claims",
        "firm_id='00000000-0000-4000-8000-000000000000' ,person_id=NULL,shared=true",
      ],
      [
        "crm_endpoint_claims_workspace_id_source_id_fkey",
        "crm_endpoint_claims",
        "source_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claims_workspace_id_endpoint_id_fkey",
        "crm_endpoint_claims",
        "endpoint_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claims_check1",
        "crm_endpoint_claims",
        "start_date=DATE '2026-10-09',end_date=DATE '2026-10-08'",
      ],
      [
        "crm_endpoint_claims_check",
        "crm_endpoint_claims",
        "person_id=NULL,firm_id=NULL",
      ],
      [
        "crm_endpoint_claim_revisions_revision_check",
        "crm_endpoint_claim_revisions",
        "revision=0",
      ],
      [
        "crm_endpoint_claim_revisions_source_revision_check",
        "crm_endpoint_claim_revisions",
        "source_revision=0",
      ],
      [
        "crm_endpoint_claim_revisions_source_hash_check",
        "crm_endpoint_claim_revisions",
        "source_hash='not-a-hash'",
      ],
      [
        "crm_endpoint_claim_revisions_status_check",
        "crm_endpoint_claim_revisions",
        "status='invalid'",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_person_id_fkey",
        "crm_endpoint_claim_revisions",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_firm_id_fkey",
        "crm_endpoint_claim_revisions",
        "firm_id='00000000-0000-4000-8000-000000000000' ,person_id=NULL,shared=true",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_source_id_fkey",
        "crm_endpoint_claim_revisions",
        "source_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_endpoint_id_fkey",
        "crm_endpoint_claim_revisions",
        "endpoint_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_claim_id_fkey",
        "crm_endpoint_claim_revisions",
        "claim_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claim_revisions_workspace_id_actor_user_id_fkey",
        "crm_endpoint_claim_revisions",
        "actor_user_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_endpoint_claim_revisions_check1",
        "crm_endpoint_claim_revisions",
        "start_date=DATE '2026-10-09',end_date=DATE '2026-10-08'",
      ],
      [
        "crm_endpoint_claim_revisions_check",
        "crm_endpoint_claim_revisions",
        "person_id=NULL,firm_id=NULL",
      ],
      [
        "crm_relationships_context_review_check",
        "crm_relationships",
        "context_review='invalid'",
      ],
      [
        "crm_identity_endpoints_kind_check",
        "crm_identity_endpoints",
        "kind='invalid'",
      ],
      [
        "crm_identity_endpoints_value_check",
        "crm_identity_endpoints",
        "value='   '",
      ],
      [
        "crm_identity_endpoints_value_hash_check",
        "crm_identity_endpoints",
        "value_hash='not-a-hash'",
      ],
      [
        "crm_selected_sources_firm_fk",
        "crm_selected_sources",
        "person_id=NULL,firm_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_selected_sources_subject_xor",
        "crm_selected_sources",
        "person_id=NULL,firm_id=NULL",
      ],
      [
        "crm_source_relationship_contexts_source_revision_check",
        "crm_source_relationship_contexts",
        "source_revision=0",
      ],
      [
        "crm_source_relationship_contexts_relationship_revision_check",
        "crm_source_relationship_contexts",
        "relationship_revision=0",
      ],
      [
        "crm_source_relationship_contexts_source_hash_check",
        "crm_source_relationship_contexts",
        "source_hash='not-a-hash'",
      ],
      [
        "crm_source_relationship_contexts_review_check",
        "crm_source_relationship_contexts",
        "review='invalid'",
      ],
      [
        "crm_source_relationship_contexts_workspace_id_person_id_fkey",
        "crm_source_relationship_contexts",
        "person_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_source_relationship_contexts_workspace_id_firm_id_fkey",
        "crm_source_relationship_contexts",
        "firm_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_source_relationship_contexts_workspace_id_source_id_fkey",
        "crm_source_relationship_contexts",
        "source_id='00000000-0000-4000-8000-000000000000'",
      ],
      [
        "crm_source_relationship_conte_workspace_id_relationship_id_fkey",
        "crm_source_relationship_contexts",
        "relationship_id='00000000-0000-4000-8000-000000000000'",
      ],
    ] as const
  ).map(([constraint, table, assignment]): Case => ({
    constraint,
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        `UPDATE ${table} SET ${assignment} WHERE workspace_id=$1`,
        [workspace(f)],
      );
    },
  })),
  {
    constraint: "crm_relationships_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_relationships SELECT * FROM crm_relationships WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_relationship_revisions_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_relationship_revisions SELECT * FROM crm_relationship_revisions WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_source_relationship_contexts_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_source_relationship_contexts SELECT * FROM crm_source_relationship_contexts WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_identity_endpoints_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_identity_endpoints SELECT * FROM crm_identity_endpoints WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_endpoint_claims_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_endpoint_claims SELECT * FROM crm_endpoint_claims WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_endpoint_claim_revisions_pkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_endpoint_claim_revisions SELECT * FROM crm_endpoint_claim_revisions WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_relationship_revisions_workspace_id_relationship_id_fkey",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_relationship_revisions(workspace_id,relationship_id,revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,actor_user_id) SELECT workspace_id,'00000000-0000-4000-8000-000000000000',revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,actor_user_id FROM crm_relationship_revisions WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint: "crm_identity_endpoints_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO crm_identity_endpoints(workspace_id,kind,value_hash) VALUES('00000000-0000-4000-8000-000000000000','email',$1)",
        [payloadHash("missing-workspace-endpoint")],
      ),
  },
  {
    constraint: "crm_identity_endpoints_workspace_id_kind_value_hash_key",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_identity_endpoints(workspace_id,kind,value,value_hash) SELECT workspace_id,kind,value,value_hash FROM crm_identity_endpoints WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
  {
    constraint:
      "crm_source_relationship_conte_workspace_id_source_id_relati_key",
    run: async (f) => {
      await seedRelationshipConstraintRows(f);
      return await f.session.query(
        "INSERT INTO crm_source_relationship_contexts(workspace_id,source_id,source_revision,source_hash,relationship_id,relationship_revision,person_id,firm_id,review) SELECT workspace_id,source_id,source_revision,source_hash,relationship_id,relationship_revision,person_id,firm_id,review FROM crm_source_relationship_contexts WHERE workspace_id=$1",
        [workspace(f)],
      );
    },
  },
];

const cases: readonly Case[] = [
  ...CRM_EVIDENCE_CONSTRAINT_CASES,
  ...CRM_COMMITMENT_CONSTRAINT_CASES,
  // ---------------------------------------------------------------- workspaces
  {
    constraint: "workspaces_pkey",
    run: async (f) => {
      const { rows } = await f.session.query<{ id: string }>(
        "SELECT id FROM workspaces LIMIT 1",
      );
      return await f.session.query(
        "INSERT INTO workspaces (id, slug, display_name) VALUES ($1, $2, $3)",
        [rows[0]?.id, "another-slug", "Another"],
      );
    },
  },
  {
    constraint: "workspaces_slug_unique",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Duplicate')",
      ),
  },
  {
    constraint: "workspaces_slug_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name) VALUES ('Not A Slug', 'x')",
      ),
  },
  {
    constraint: "workspaces_display_name_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name) VALUES ('blank-name', '   ')",
      ),
  },
  {
    constraint: "workspaces_business_time_zone_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('bad-zone', 'x', 'EST5EDT?')",
      ),
  },
  {
    constraint: "workspaces_updated_not_before_created",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name, created_at, updated_at) VALUES ('backdated', 'x', TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')",
      ),
  },

  // -------------------------------------------------------------------- users
  {
    constraint: "users_pkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO users (id, google_sub, email, display_name) VALUES ($1, $2, $3, $4)",
        [admin(f), "sub-clash", "clash@example.test", "Clash"],
      ),
  },
  {
    constraint: "users_google_sub_unique",
    run: async (f) => {
      const { rows } = await f.session.query<{ google_sub: string }>(
        "SELECT google_sub FROM users LIMIT 1",
      );
      return await f.session.query(
        "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3)",
        [rows[0]?.google_sub, "other@example.test", "Other"],
      );
    },
  },
  {
    constraint: "users_google_sub_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('  ', 'a@example.test', 'A')",
      ),
  },
  {
    constraint: "users_email_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-a', 'Mixed@Example.test', 'A')",
      ),
  },
  {
    constraint: "users_display_name_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-b', 'b@example.test', '')",
      ),
  },

  // ----------------------------------------------------- workspace_memberships
  {
    constraint: "workspace_memberships_pkey",
    run: async (f) => {
      const { rows } = await f.session.query<{ id: string }>(
        "SELECT id FROM workspace_memberships WHERE workspace_id = $1 LIMIT 1",
        [workspace(f)],
      );
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-pkey', 'pk@example.test', 'PK') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, id, user_id, role) VALUES ($1, $2, $3, 'salesperson')",
        [workspace(f), rows[0]?.id, created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "workspace_memberships_one_per_user",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: "workspace_memberships_role_known",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-role', 'role@example.test', 'Role') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'manager')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "workspace_memberships_status_known",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-status', 'status@example.test', 'S') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'suspended')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "workspace_memberships_deactivation_consistent",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-deact', 'd@example.test', 'D') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, deactivated_at) VALUES ($1, $2, 'salesperson', 'active', now())",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "workspace_memberships_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000000', $1, 'salesperson')",
        [admin(f)],
      ),
  },
  {
    constraint: "workspace_memberships_user_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, '00000000-0000-4000-8000-000000000000', 'salesperson')",
        [workspace(f)],
      ),
  },
  {
    constraint: TRIGGER_CONSTRAINT,
    run: async (f) =>
      await f.session.query(
        "UPDATE workspace_memberships SET status = 'inactive', deactivated_at = now() WHERE workspace_id = $1 AND role = 'admin'",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------------------------ devices
  {
    constraint: "devices_pkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4, $5)",
        [
          workspace(f),
          device(f),
          salesperson(f),
          "Second Mac",
          payloadHash("pkey"),
        ],
      ),
  },
  {
    constraint: "devices_membership_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)",
        [
          workspace(f),
          "00000000-0000-4000-8000-000000000000",
          "Stranger Mac",
          payloadHash("fk"),
        ],
      ),
  },
  {
    constraint: "devices_label_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)",
        [workspace(f), admin(f), "  ", payloadHash("label")],
      ),
  },
  {
    constraint: "devices_secret_hash_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)",
        [workspace(f), admin(f), "Plain Mac", "a-plaintext-device-secret"],
      ),
  },
  {
    constraint: "devices_status_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, status) VALUES ($1, $2, $3, $4, 'suspended')",
        [workspace(f), admin(f), "Odd Mac", payloadHash("status")],
      ),
  },
  {
    constraint: "devices_revocation_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, status, revoked_at) VALUES ($1, $2, $3, $4, 'active', now())",
        [workspace(f), admin(f), "Half Revoked Mac", payloadHash("revoke")],
      ),
  },
  {
    constraint: "devices_client_version_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, client_version) VALUES ($1, $2, $3, $4, 'latest')",
        [workspace(f), admin(f), "Unversioned Mac", payloadHash("version")],
      ),
  },

  // -------------------------------------------------------- calling_identities
  {
    constraint: "calling_identities_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550200') RETURNING id",
        [workspace(f), admin(f)],
      );
      return await f.session.query(
        "INSERT INTO calling_identities (workspace_id, id, owner_user_id, e164) VALUES ($1, $2, $3, '+14015550201')",
        [workspace(f), created.rows[0]?.id, admin(f)],
      );
    },
  },
  {
    constraint: "calling_identities_number_unique",
    run: async (f) => {
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",
        [workspace(f), admin(f)],
      );
      return await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",
        [workspace(f), salesperson(f)],
      );
    },
  },
  {
    constraint: "calling_identities_owner_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550203')",
        [workspace(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "calling_identities_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, e164) VALUES ('00000000-0000-4000-8000-000000000000', '+14015550204')",
      ),
  },
  {
    constraint: "calling_identities_e164_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '401-555-0205')",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: "calling_identities_verification_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status) VALUES ($1, $2, '+14015550206', 'probably')",
        [workspace(f), admin(f)],
      ),
  },
  {
    // The reserved shared line: a null-owner row may exist, but never enabled.
    constraint: "calling_identities_shared_line_disabled",
    run: async (f) =>
      await f.session.query(
        // With its attestation recorded (lane g60), so the missing owner is the only
        // thing this row gets wrong.
        `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                         verified_at, verified_by_user_id, verification_method)
         VALUES ($1, NULL, '+14015550207', 'verified', true, now(), $2, 'admin_attestation')`,
        [workspace(f), admin(f)],
      ),
  },
  // Migration 0016 (lane g60): who attested a number, how, and when it was retired.
  {
    constraint: "calling_identities_verification_method_known",
    run: async (f) =>
      await f.session.query(
        `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                         verified_at, verified_by_user_id, verification_method)
         VALUES ($1, $2, '+14015550210', 'verified', true, now(), $2, 'caller_id_looked_right')`,
        [workspace(f), admin(f)],
      ),
  },
  {
    // The attester is a member of this workspace, never of another.
    constraint: "calling_identities_verified_by_fkey",
    run: async (f) =>
      await f.session.query(
        `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled,
                                         verified_at, verified_by_user_id, verification_method)
         VALUES ($1, $2, '+14015550211', 'verified', true, now(), $3, 'admin_attestation')`,
        [workspace(f), admin(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "calling_identities_disabled_by_fkey",
    run: async (f) =>
      await f.session.query(
        `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, disabled_at, disabled_by_user_id)
         VALUES ($1, $2, '+14015550212', now(), $3)`,
        [workspace(f), admin(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    // A retirement names who and when, and a retired number is not enabled.
    constraint: "calling_identities_disable_recorded",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, disabled_at) VALUES ($1, $2, '+14015550213', now())",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: "calling_identities_label_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, label) VALUES ($1, $2, '+14015550214', '')",
        [workspace(f), admin(f)],
      ),
  },

  // --------------------------------------------------------- command_receipts
  {
    constraint: "command_receipts_pkey",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-pkey', 'firm.assign', $3, 'accepted')",
          [workspace(f), device(f), payloadHash("cmd")],
        );
      }
      return null;
    },
  },
  {
    constraint: "command_receipts_device_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-fk', 'firm.assign', $3, 'accepted')",
        [workspace(f), f.seeded.beta.salesperson.deviceId, payloadHash("cmd")],
      ),
  },
  {
    constraint: "command_receipts_command_id_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd with spaces', 'firm.assign', $3, 'accepted')",
        [workspace(f), device(f), payloadHash("cmd")],
      ),
  },
  {
    constraint: "command_receipts_kind_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-kind', '  ', $3, 'accepted')",
        [workspace(f), device(f), payloadHash("cmd")],
      ),
  },
  {
    constraint: "command_receipts_payload_hash_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-hash', 'firm.assign', 'not-a-hash', 'accepted')",
        [workspace(f), device(f)],
      ),
  },
  {
    constraint: "command_receipts_result_status_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-status', 'firm.assign', $3, 'maybe')",
        [workspace(f), device(f), payloadHash("cmd")],
      ),
  },
  {
    constraint: "command_receipts_dial_result_not_actionable",
    run: async (f) =>
      await f.session.query(
        `INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status, result)
         VALUES ($1, $2, 'cmd-dial', 'authorize_dial', $3, 'accepted', '{"ticket":"replayed"}'::jsonb)`,
        [workspace(f), device(f), payloadHash("cmd")],
      ),
  },

  // ------------------------------------------------------------- audit_events
  {
    constraint: "audit_events_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'a', 'workspace') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO audit_events (workspace_id, id, actor_kind, action, subject_kind) VALUES ($1, $2, 'system', 'b', 'workspace')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "audit_events_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ('00000000-0000-4000-8000-000000000000', 'system', 'a', 'workspace')",
      ),
  },
  {
    constraint: "audit_events_actor_user_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind) VALUES ($1, 'user', '00000000-0000-4000-8000-000000000000', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: "audit_events_actor_kind_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'robot', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: "audit_events_user_actor_identified",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'user', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: "audit_events_action_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', '   ', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: "audit_events_subject_kind_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'a', '')",
        [workspace(f)],
      ),
  },
  {
    constraint: "audit_events_detail_is_object",
    run: async (f) =>
      await f.session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind, detail) VALUES ($1, 'system', 'a', 'workspace', '"a string"'::jsonb)`,
        [workspace(f)],
      ),
  },

  // -------------------------------------------------------- suppression_events
  {
    constraint: "suppression_events_pkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, $2, 'handle', 'x@example.test', 'v1', 'import')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: "suppression_events_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ('00000000-0000-4000-8000-000000000000', 'e-ws', 'handle', 'x@example.test', 'v1', 'import')",
      ),
  },
  {
    constraint: "suppression_events_actor_user_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id) VALUES ($1, 'e-actor', 'handle', 'x@example.test', 'v1', 'salesperson_manual', '00000000-0000-4000-8000-000000000000')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_scope_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-scope', 'domain', 'example.test', 'v1', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_canonical_key_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-key', 'handle', 'Mixed@Example.test', 'v1', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_canonicalizer_version_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-canon', 'handle', 'x@example.test', 'Version One', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_source_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-source', 'handle', 'x@example.test', 'v1', 'a_hunch')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_supersession_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-cons', 'handle', 'x@example.test', 'v1', 'import', $2, 'correction')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: "suppression_events_supersession_reason_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-reason', 'handle', 'x@example.test', 'v1', 'admin_supersession', $2, 'changed_my_mind')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: "suppression_events_supersession_reason_required",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id) VALUES ($1, 'e-req', 'handle', 'x@example.test', 'v1', 'admin_supersession', $2)",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: "suppression_events_superseded_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-missing', 'handle', 'x@example.test', 'v1', 'admin_supersession', 'no-such-event', 'correction')",
        [workspace(f)],
      ),
  },
  {
    // Migration 0037 (DESIGN-S3X §2.3, P1-6).
    constraint: "suppression_events_channel_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, channel) VALUES ($1, 'e-channel', 'firm', 'firm-1', 'v1', 'import', 'sms')",
        [workspace(f)],
      ),
  },
  {
    // A phone-only stop on an address is a stop no reader would read.
    constraint: "suppression_events_channel_fits_key",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, channel) VALUES ($1, 'e-fits', 'handle', 'x@example.test', 'v1', 'import', 'phone')",
        [workspace(f)],
      ),
  },
  {
    constraint: "suppression_events_one_direct_supersession",
    run: async (f) => {
      // The canonical key matches the base event's on purpose: migration 0006's
      // `suppression_events_supersession_same_key` trigger refuses a supersession
      // that changes it, and would otherwise fire on the *first* insert here and
      // hide the unique index this case is about.
      for (const id of ["e-first-supersession", "e-second-supersession"]) {
        await f.session.query(
          "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, $2, 'handle', 'base@example.test', 'v1', 'admin_supersession', $3, 'correction')",
          [workspace(f), id, f.baseSuppressionEventId],
        );
      }
      return null;
    },
  },

  // -------------------------------------------------------------- active_holds
  {
    constraint: "active_holds_pkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, $2, 'firm', 'firm-2', 'uncertain_reply', ARRAY['email_send'], 'message')",
        [workspace(f), f.holdId],
      ),
  },
  {
    constraint: "active_holds_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ('00000000-0000-4000-8000-000000000000', 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message')",
      ),
  },
  {
    constraint: "active_holds_reason_code_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'a_bad_feeling', ARRAY['email_send'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_scope_kind_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'universe', 'x', 'uncertain_reply', ARRAY['email_send'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_workspace_scope_has_no_key",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'workspace', 'firm-1', 'scoped_pause', ARRAY['email_send'], 'pause')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_blocked_action_kinds_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['send_a_pigeon'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_source_event_kind_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], '  ')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_release_not_before_start",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, started_at, released_at) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message', TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-02-01 00:00:00+00')",
        [workspace(f)],
      ),
  },
  {
    constraint: "active_holds_recovery_action_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message', 'just_send_it')",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------------ administrative_pauses
  {
    constraint: "administrative_pauses_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3) RETURNING id",
        [workspace(f), f.holdId, admin(f)],
      );
      return await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, $2, 'workspace', 'scoped_pause', $3, $4)",
        [workspace(f), created.rows[0]?.id, f.holdId, admin(f)],
      );
    },
  },
  {
    constraint: "administrative_pauses_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ('00000000-0000-4000-8000-000000000000', 'workspace', 'scoped_pause', $1, $2)",
        [f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_reason_code_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'because_i_said_so', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_hold_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', '00000000-0000-4000-8000-000000000000', $2)",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_creator_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "administrative_pauses_releaser_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, released_by_user_id, released_at) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, $4, now())",
        [workspace(f), f.holdId, admin(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "administrative_pauses_scope_kind_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, reason_code, hold_id, created_by_user_id) VALUES ($1, 'galaxy', 'x', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_scope_key_required",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'owner', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_channel_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id) VALUES ($1, 'channel', 'all', 'carrier_pigeon', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_channel_scope_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id) VALUES ($1, 'owner', $4, 'email', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f), admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_reason_note_bounded",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, reason_note, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $4, $2, $3)",
        [workspace(f), f.holdId, admin(f), "x".repeat(501)],
      ),
  },
  {
    constraint: "administrative_pauses_release_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, released_at) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, now())",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: "administrative_pauses_release_not_before_create",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, created_at, released_at, released_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-02-01 00:00:00+00', $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },

  // -------------------------------------------------------- retention_policies
  {
    constraint: "retention_policies_pkey",
    run: async (f) => {
      // Migration 0014 seeds all ten policy rows for every workspace, so without
      // this the first insert below breaks `retention_policies_one_per_kind` and the
      // case never reaches the key it is about. The delete is inside the case's
      // transaction and rolls back with it.
      await f.session.query(
        "DELETE FROM retention_policies WHERE workspace_id = $1",
        [workspace(f)],
      );
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'raw_mime', 'delete', INTERVAL '7 days', now()) RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO retention_policies (workspace_id, id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, $2, 'operational_logs', 'delete', INTERVAL '90 days', now())",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "retention_policies_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ('00000000-0000-4000-8000-000000000000', 'raw_mime', 'delete', INTERVAL '7 days', now())",
      ),
  },
  {
    constraint: "retention_policies_one_per_kind",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'canceled_drafts', 'delete', INTERVAL '30 days', now())",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: "retention_policies_data_kind_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'everything', 'delete', INTERVAL '1 day', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "retention_policies_disposition_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'raw_mime', 'shred', INTERVAL '1 day', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "retention_policies_interval_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, effective_from) VALUES ($1, 'raw_mime', 'delete', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "retention_policies_interval_positive",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'unmatched_gmail_metadata', 'delete', INTERVAL '0', now())",
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------------------- jobs
  {
    constraint: "jobs_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '{}'::jsonb, 'today:a') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO jobs (workspace_id, id, kind, payload, idempotency_key) VALUES ($1, $2, 'today.build', '{}'::jsonb, 'today:b')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "jobs_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ('00000000-0000-4000-8000-000000000000', 'today.build', '{}'::jsonb, 'today:c')",
      ),
  },
  {
    constraint: "jobs_idempotent",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'mail.sync', '{}'::jsonb, 'mail-sync:same')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: "jobs_kind_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'Today Build', '{}'::jsonb, 'today:d')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_payload_is_object",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '[]'::jsonb, 'today:e')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_idempotency_key_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '{}'::jsonb, '   ')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_state_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'today.build', '{}'::jsonb, 'today:f', 'thinking')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_attempts_sane",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, attempt_count, max_attempts) VALUES ($1, 'today.build', '{}'::jsonb, 'today:g', 11, 10)",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_lease_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'today.build', '{}'::jsonb, 'today:h', 'running')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_lease_owner_bounded",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, lease_owner, lease_expires_at) VALUES ($1, 'today.build', '{}'::jsonb, 'today:i', 'running', '  ', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_error_detail_bounded",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, error_detail) VALUES ($1, 'today.build', '{}'::jsonb, 'today:j', $2)",
        [workspace(f), "e".repeat(2001)],
      ),
  },

  // ----------------------------------------------------------- daily_counters
  {
    constraint: "daily_counters_pkey",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: "daily_counters_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ('00000000-0000-4000-8000-000000000000', 'mailbox', 'mailbox-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
      ),
  },
  {
    constraint: "daily_counters_subject_kind_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'firm', 'firm-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: "daily_counters_subject_key_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', '  ', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: "daily_counters_counter_kind_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-2', 'Automated Sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: "daily_counters_count_nonnegative",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone, count) VALUES ($1, 'mailbox', 'mailbox-3', 'automated_sends', DATE '2026-09-19', 'America/New_York', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: "daily_counters_business_time_zone_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-4', 'automated_sends', DATE '2026-09-19', 'Eastern Time')",
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------------- heartbeats
  {
    constraint: "heartbeats_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('api', 'api-1', now()) RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO heartbeats (id, component, instance_key, observed_at) VALUES ($1, 'api', 'api-2', now())",
        [created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "heartbeats_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (workspace_id, component, instance_key, observed_at) VALUES ('00000000-0000-4000-8000-000000000000', 'mailbox', 'mailbox-1', now())",
      ),
  },
  {
    // NULLS NOT DISTINCT: two api heartbeats with no workspace still collide.
    constraint: "heartbeats_identity",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('scheduler', 'scheduler-1', now())",
        );
      }
      return null;
    },
  },
  {
    constraint: "heartbeats_component_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('desktop', 'mac-1', now())",
      ),
  },
  {
    constraint: "heartbeats_mailbox_is_workspace_scoped",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('mailbox', 'mailbox-9', now())",
      ),
  },
  {
    constraint: "heartbeats_instance_key_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('worker', '   ', now())",
      ),
  },
  {
    constraint: "heartbeats_detail_is_object",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at, detail) VALUES ('worker', 'worker-2', now(), '42'::jsonb)",
      ),
  },

  // --------------------------------------------------------- hold_reason_codes
  {
    constraint: "hold_reason_codes_pkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('daily_cap', 'duplicate', true)",
      ),
  },
  {
    constraint: "hold_reason_codes_code_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('Dead Job', 'x', true)",
      ),
  },
  {
    constraint: "hold_reason_codes_description_present",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('new_code', '   ', true)",
      ),
  },

  // ------------------------------------------------------- jobs (migration 0002)
  {
    constraint: "jobs_fencing_token_nonnegative",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, fencing_token) VALUES ($1, 'canary', '{}'::jsonb, 'canary:fence', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_requeued_count_nonnegative",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, requeued_count) VALUES ($1, 'canary', '{}'::jsonb, 'canary:requeued', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_error_code_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, error_code) VALUES ($1, 'canary', '{}'::jsonb, 'canary:code', 'Provider Refused')",
        [workspace(f)],
      ),
  },
  {
    // NOT VALID, so migration 0001's rows are untouched; every new write is checked.
    constraint: "jobs_completed_at_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'canary', '{}'::jsonb, 'canary:done', 'done')",
        [workspace(f)],
      ),
  },
  {
    constraint: "jobs_dead_at_consistent",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'canary', '{}'::jsonb, 'canary:dead', 'dead')",
        [workspace(f)],
      ),
  },
  {
    // A dead job keeps its payload: an audited admin requeue has to have one to run.
    constraint: "jobs_payload_archived_only_when_done",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, payload_archived_at) VALUES ($1, 'canary', '{}'::jsonb, 'canary:archived', now())",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------- heartbeats (migration 0002)
  {
    constraint: "heartbeats_expected_interval_positive",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at, expected_interval_seconds) VALUES ('worker', 'worker-interval', now(), 0)",
      ),
  },

  // ------------------------------------------------ canary_runs (migration 0002)
  {
    constraint: "canary_runs_pkey",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:00:00+00')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: "canary_runs_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ('00000000-0000-4000-8000-000000000000', TIMESTAMPTZ '2026-09-21 14:00:00+00')",
      ),
  },
  {
    constraint: "canary_runs_quarter_hour_aligned",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:07:00+00')",
        [workspace(f)],
      ),
  },
  {
    constraint: "canary_runs_completed_after_insert",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at, completed_by) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:15:00+00', now() - INTERVAL '1 day', 'worker-1')",
        [workspace(f)],
      ),
  },
  {
    constraint: "canary_runs_completion_attributed",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:30:00+00', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "canary_runs_completed_by_bounded",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at, completed_by) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:45:00+00', now(), '   ')",
        [workspace(f)],
      ),
  },

  // -------------------------------------------- critical_alerts (migration 0002)
  {
    constraint: "critical_alerts_pkey",
    run: async (f) => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'canary_stale') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, id, alert_key) VALUES ($1, $2, 'dead_job_unresolved')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: "critical_alerts_workspace_id_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ('00000000-0000-4000-8000-000000000000', 'canary_stale')",
      ),
  },
  {
    // The acknowledger must be a member of this workspace: the composite key is what
    // stops another workspace's admin silencing this one's alert.
    constraint: "critical_alerts_acknowledger_fkey",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at, acknowledged_by_user_id) VALUES ($1, 'canary_stale', now(), $2)",
        [workspace(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: "critical_alerts_key_shape",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'Canary Stale')",
        [workspace(f)],
      ),
  },
  {
    constraint: "critical_alerts_severity_known",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, severity) VALUES ($1, 'canary_stale', 'info')",
        [workspace(f)],
      ),
  },
  {
    constraint: "critical_alerts_detail_is_object",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, detail) VALUES ($1, 'canary_stale', '42'::jsonb)",
        [workspace(f)],
      ),
  },
  {
    constraint: "critical_alerts_acknowledgement_attributed",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at) VALUES ($1, 'canary_stale', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: "critical_alerts_acknowledged_after_raise",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at, acknowledged_by_user_id) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day', $2)",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: "critical_alerts_resolved_after_raise",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, resolved_at) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day')",
        [workspace(f)],
      ),
  },
  {
    constraint: "critical_alerts_observed_after_raise",
    run: async (f) =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, last_observed_at) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day')",
        [workspace(f)],
      ),
  },
  {
    // The partial unique index: one open alert per key, so a recurring condition
    // updates the open row rather than filling the table.
    constraint: "critical_alerts_one_open_per_key",
    run: async (f) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'canary_stale')",
          [workspace(f)],
        );
      }
      return null;
    },
  },

  // Later migrations bring their cases in from their own file, so two lanes adding a
  // migration at the same time never both edit the middle of this array.
  ...selectedImportConstraintCases,
  ...SELECTED_FILE_CONSTRAINT_CASES,
  ...BUSINESS_ACQUISITION_CONSTRAINT_CASES,
  ...MAIL_CAPTURE_CONSTRAINT_CASES,
  ...CRM_BACKFILL_CONSTRAINT_CASES,
  ...CRM_EXTRACTION_CONSTRAINT_CASES,
  ...CRM_PROGRESS_CONSTRAINT_CASES,
  ...peopleConstraintCases,
  ...relationshipConstraintCases,
  ...SOURCING_CONSTRAINT_CASES,
  ...OUTREACH_CONSTRAINT_CASES,
  ...SOCIAL_CONSTRAINT_CASES,
  ...IDENTITY_CONSTRAINT_CASES,
  ...CRM_CONSTRAINT_CASES,
  ...POLICY_CONSTRAINT_CASES,
  ...MAIL_CONSTRAINT_CASES,
  ...TODAY_CONSTRAINT_CASES,
  ...OUTBOUND_CONSTRAINT_CASES,
  ...SENDER_RECOVERY_CONSTRAINT_CASES,
  ...PROVIDER_INCIDENT_CONSTRAINT_CASES,
  ...NOTIFICATION_CONSTRAINT_CASES,
  ...HUMAN_REPLY_CONSTRAINT_CASES,
  ...CLASSIFICATION_CONSTRAINT_CASES,
  ...SEQUENCE_CONSTRAINT_CASES,
  ...SETTINGS_CONSTRAINT_CASES,
  ...RETENTION_CONSTRAINT_CASES,
  ...RELEASE_CONSTRAINT_CASES,
  ...FUNNEL_CONSTRAINT_CASES,
  ...RESEARCH_CONSTRAINT_CASES,
  ...FOLLOW_UP_CONSTRAINT_CASES,
  ...SEND_PATH_V2_CONSTRAINT_CASES,
  ...MAILBOX_ACCOUNTS_CONSTRAINT_CASES,
  ...CALL_TO_BOOKING_CONSTRAINT_CASES,
  ...MEETING_BOOKING_UIDS_CONSTRAINT_CASES,
  ...CALL_TRANSCRIPTS_CONSTRAINT_CASES,
  ...CALL_SUMMARIES_CONSTRAINT_CASES,
  ...CALL_ANALYSES_CONSTRAINT_CASES,
  ...CALL_PROPOSALS_CONSTRAINT_CASES,
  ...TRANSCRIPTION_PROVIDER_JOBS_CONSTRAINT_CASES,
  ...PREPARED_BRIEFS_CONSTRAINT_CASES,
  ...MEETING_ATTENDANCE_CONSTRAINT_CASES,
  ...MEETING_BOOKING_DETAILS_CONSTRAINT_CASES,
  ...MEETING_RECORDINGS_CONSTRAINT_CASES,
  ...MEETING_TRANSCRIPTION_CONSTRAINT_CASES,
  ...MEETING_OUTCOMES_CONSTRAINT_CASES,
  ...MEETING_FOLLOW_THROUGH_CONSTRAINT_CASES,
  ...MEETING_AUTO_RECORDING_CONSTRAINT_CASES,
];

describe("foundation constraints", () => {
  let database: TestDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    const hold = await database.session.query<{ id: string }>(
      "INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'workspace', 'scoped_pause', ARRAY['email_send'], 'pause') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    await database.session.query(
      "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'base-event', 'handle', 'base@example.test', 'v1', 'prospect_opt_out')",
      [seeded.alpha.workspaceId],
    );
    const crm = await seedCrm(database.session, seeded);
    const mail = await seedMail(database.session, seeded, crm);
    const outbound = await seedOutbound(database.session, seeded, crm, mail);
    fixture = {
      session: database.session,
      seeded,
      holdId: hold.rows[0]?.id ?? "",
      baseSuppressionEventId: "base-event",
      crm,
      mail,
      outbound,
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  it.each(cases.map((testCase) => [testCase.constraint, testCase] as const))(
    "refuses the insert that would break %s",
    async (name, testCase) => {
      await fixture.session.query("BEGIN");
      let thrown: unknown = null;
      try {
        await testCase.run(fixture);
      } catch (error) {
        thrown = error;
      } finally {
        await fixture.session.query("ROLLBACK");
      }
      expect(
        thrown,
        `${name} accepted a row it should have refused`,
      ).not.toBeNull();
      if (name === TRIGGER_CONSTRAINT) {
        // The constraint trigger raises restrict_violation; it names no constraint.
        expect(thrown).toMatchObject({ code: "23001" });
        expect(String((thrown as { message?: string }).message)).toContain(
          "without an active admin",
        );
        return;
      }
      expect(thrown).toMatchObject({
        constraint:
          name === "crm_mail_source_canonical_gate" ||
          name === "crm_mail_message_canonical_gate"
            ? "crm_mail_available_source_canonical"
            : name,
      });
    },
  );

  it.each(
    (
      ["crm_relationship_revisions", "crm_endpoint_claim_revisions"] as const
    ).flatMap((table) =>
      (["app_runtime", "migration"] as const).flatMap((role) =>
        (["UPDATE", "DELETE", "TRUNCATE"] as const).map((operation) => ({
          table,
          role,
          operation,
        })),
      ),
    ),
  )(
    "keeps $table append-only for $role against $operation",
    async ({ table, role, operation }) => {
      await fixture.session.query("BEGIN");
      try {
        await seedRelationshipConstraintRows(fixture);
        await fixture.session.query(`SET LOCAL ROLE ${role}`);
        const statement =
          operation === "UPDATE"
            ? `UPDATE ${table} SET status='historical'`
            : operation === "DELETE"
              ? `DELETE FROM ${table}`
              : `TRUNCATE ${table} CASCADE`;
        await expect(fixture.session.query(statement)).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await fixture.session.query("ROLLBACK");
      }
    },
  );

  it("has a case for every constraint the database enforces", async () => {
    const constraints = await database.session.query<{ name: string }>(`
      SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         -- 'x' is the exclusion constraint migration 0006 added for state postures.
         -- It was absent from this list until then, so nothing was uncovered by it;
         -- leaving it out now would have let an exclusion constraint ship untested.
         AND c.contype IN ('c', 'u', 'f', 'p', 't', 'x')
         AND t.relname <> 'schema_versions'
    `);
    const partialUniqueIndexes = await database.session.query<{
      name: string;
    }>(`
      SELECT ci.relname AS name
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE i.indisunique AND i.indpred IS NOT NULL AND n.nspname = 'public'
    `);

    const enforced = new Set([
      ...constraints.rows.map((row) => row.name),
      ...partialUniqueIndexes.rows.map((row) => row.name),
    ]);
    const covered = new Set(cases.map((testCase) => testCase.constraint));

    const uncovered = [...enforced].filter((name) => !covered.has(name)).sort();
    expect(
      uncovered,
      "every enforced constraint needs a failing insert above",
    ).toEqual([]);

    const stale = [...covered].filter((name) => !enforced.has(name)).sort();
    expect(
      stale,
      "a case names a constraint the database does not have",
    ).toEqual([]);
  });
});
