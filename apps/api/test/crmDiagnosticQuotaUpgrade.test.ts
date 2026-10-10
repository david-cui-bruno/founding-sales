import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  crmAcquisitionDiagnosticAuthorizationSchema,
  crmAcquisitionDiagnosticReadResultSchema,
} from "@fss/contracts";
import { applyMigrations } from "@fss/domain/db/migrationRunner.ts";
import { CRM_MAIL_CAPTURE_DISCLOSURE } from "@fss/domain/crm/capabilityAuthority.ts";
import {
  prepareCrmAcquisitionDiagnosticIsolation,
  verifyCrmAcquisitionDiagnostic,
  type CrmAcquisitionDiagnosticRuntime,
} from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import {
  repositoryContext,
  workspaceScope,
} from "@fss/domain/db/workspaceScope.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import {
  storeFixtureCiGateRecord,
  FIXTURE_CI_COMMIT,
  FIXTURE_API_DIGEST,
} from "@fss/domain/test/release/support/releaseRecords.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
it("retains schema89 recorded and ambiguous units through upgrade while current deployment permits only owned body-free reports", async () => {
  const fixture = await createAuthFixture({ throughVersion: 89, purpose: "acquisition_diagnostic" });
  try {
    const ws = fixture.alpha.workspaceId,
      owner = fixture.alpha.admin.userId,
      id = randomUUID(),
      environmentId = randomUUID();
    const mailbox = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'legacy@example.test','legacy@example.test','connected') RETURNING id",
        [ws, owner],
      )
    ).rows[0]!.id;
    const legacy = z
      .strictObject({
        ...crmAcquisitionDiagnosticAuthorizationSchema.shape,
        schemaVersion: z.literal(89),
        metadataUnits: z.literal(5),
        bodyUnits: z.literal(5),
        maxUnits: z.number().int().min(1).max(10000),
      })
      .parse({
        id,
        purpose: "acquisition_acceptance",
        workspaceId: ws,
        mailboxId: mailbox,
        ownerUserId: owner,
        providerAccountId: "legacy@example.test",
        accountBinding: "a".repeat(64),
        generation: 1,
        oauthGrantObservationId: randomUUID(),
        databaseInstanceArn: "legacy-rds",
        databaseSecretArn: "legacy-secret",
        databaseEndpoint: "legacy.invalid",
        ecsClusterArn: "legacy-cluster",
        deploymentIdentity: "old-api",
        workerDeploymentIdentity: "old-worker",
        environmentId,
        databaseName: fixture.database.name,
        implementationCommit: "a".repeat(40),
        apiImageDigest: "sha256:" + "a".repeat(64),
        workerImageDigest: "sha256:" + "b".repeat(64),
        schemaVersion: 89,
        releaseReference: "legacy-reviewed-release",
        disclosureVersion: CRM_MAIL_CAPTURE_DISCLOSURE.version,
        disclosureSha256: CRM_MAIL_CAPTURE_DISCLOSURE.sha256,
        consentReference: "legacyconsent",
        providerPolicyReference: "legacypolicy",
        reviewedBy: owner,
        reviewReference: "legacyreview",
        verifiedAt: new Date(Date.now() - 1000).toISOString(),
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        maxReads: 8,
        maxUnits: 24,
        metadataUnits: 5,
        bodyUnits: 5,
        messages: [
          {
            messageId: "legacy",
            threadId: "legacy-thread",
            origin: "received",
            fromAt: "2026-01-01T00:00:00Z",
            toAt: "2027-01-01T00:00:00Z",
          },
        ],
      });
    const hash = createHash("sha256")
      .update(JSON.stringify(legacy))
      .digest("hex");
    await fixture.db.query(
      "INSERT INTO crm_acquisition_diagnostic_authorizations(workspace_id,id,owner_user_id,mailbox_id,authorization_sha256,authorization_document,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ws,
        id,
        owner,
        mailbox,
        hash,
        JSON.stringify(legacy),
        legacy.verifiedAt,
        legacy.validUntil,
      ],
    );
    for (const [operation, state] of [
      ["metadata", "observed"],
      ["body", "unknown"],
    ] as const)
      await fixture.db.query(
        "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units) VALUES($1,$2,$3,$4,'controlled',$5,5)",
        [ws, id, "legacy", operation, state],
      );
    await fixture.db.query(
      "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units) VALUES($1,$2,'unfinished','body','controlled','calling',5)",
      [ws, id],
    );
    const snapshot = (
      await fixture.db.query(
        "SELECT authorization_sha256,authorization_document FROM crm_acquisition_diagnostic_authorizations WHERE id=$1",
        [id],
      )
    ).rows;
    await applyMigrations(fixture.db, { throughVersion: 90 });
    expect(
      (
        await fixture.db.query(
          "SELECT authorization_sha256,authorization_document FROM crm_acquisition_diagnostic_authorizations WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual(snapshot);
    const runtime: CrmAcquisitionDiagnosticRuntime = {
      environmentId,
      implementationCommit: "c".repeat(40),
      imageDigest: "sha256:" + "d".repeat(64),
      side: "api",
      schemaVersion: 90,
      verifyIsolation: async (binding) =>
        binding.environmentId === environmentId &&
        binding.databaseName === fixture.database.name &&
        binding.purpose === "progress_read",
    };
    const session = await fixture.database.appRuntimeSession();
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown, rt = runtime) =>
      dispatch(
        {
          method: "POST",
          path,
          headers: { authorization: `Bearer ${token}` },
          query: new URLSearchParams(),
          body,
        },
        {
          session,
          auth: { ...fixture.deps, db: session },
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          crmAcquisitionDiagnosticRuntime: rt,
        },
      );
    const response = await post("/crm/business/mail/diagnostic/read", {
      authorizationId: id,
    });
    expect(response.status).toBe(200);
    const report = crmAcquisitionDiagnosticReadResultSchema.parse(
      response.body,
    );
    expect(report).toMatchObject({
      authorizationSha256: hash,
      attemptedReads: 3,
      observedUnits: 5,
      conservedUnits: 10,
      accountingProvenance: "legacy_recorded_unverified",
      accountingBuckets: [
        {
          scheduleVersion: "legacy-v89-recorded-unverified",
          attemptedReads: 3,
          observedUnits: 5,
          conservedUnits: 10,
        },
      ],
      productionActivationAllowed: false,
    });
    expect(JSON.stringify(report)).not.toContain("legacy@example.test");
    expect(
      (
        await post("/crm/business/mail/diagnostic/request", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          authorizationId: id,
          expectedAuthorizationSha256: hash,
        })
      ).body,
    ).toMatchObject({
      status: "refused",
      reason: "diagnostic_authority_unavailable",
    });
    const context = repositoryContext(
      workspaceScope(ws, { kind: "user", userId: owner, role: "admin" }),
      session,
    );
    const readProof = await prepareCrmAcquisitionDiagnosticIsolation(
      context,
      { authorizationId: id },
      runtime,
      "progress_read",
    );
    expect(readProof).not.toBeNull();
    expect(
      await verifyCrmAcquisitionDiagnostic(
        context,
        id,
        runtime,
        true,
        readProof!,
      ),
    ).toBeNull();
    expect(
      (
        await post(
          "/crm/business/mail/diagnostic/read",
          { authorizationId: id },
          { ...runtime, environmentId: randomUUID() },
        )
      ).status,
    ).toBe(404);
    await session.query(
      "UPDATE crm_acquisition_diagnostic_reads SET state='observed' WHERE authorization_id=$1 AND message_id='unfinished'",
      [id],
    );
    expect(
      (
        await post("/crm/business/mail/diagnostic/read", {
          authorizationId: id,
        })
      ).body,
    ).toMatchObject({
      observedUnits: 10,
      conservedUnits: 5,
      accountingProvenance: "legacy_recorded_unverified",
    });
    await expect(
      session.query(
        "UPDATE crm_acquisition_diagnostic_reads SET units=20 WHERE authorization_id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      session.query(
        "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units,quota_schedule_version) VALUES($1,$2,'new','body','controlled','calling',5,'legacy-v89-recorded-unverified')",
        [ws, id],
      ),
    ).rejects.toMatchObject({ constraint: "crm_diagnostic_current_dispatch" });
    await expect(
      session.query(
        "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units) VALUES($1,$2,'new','body','controlled','calling',20)",
        [ws, id],
      ),
    ).rejects.toMatchObject({ constraint: "crm_diagnostic_current_dispatch" });
    // A current, fully valid authority proves that the refusal is the opaque proof purpose,
    // not a legacy parser or a missing OAuth/release fixture.
    const actualMailbox = (
      await fixture.db.query<{
        id: string;
        owner_user_id: string;
        email_address: string;
        provider_account_id: string;
        generation: number;
        status: "connected";
      }>("SELECT * FROM mailboxes WHERE id=$1", [mailbox])
    ).rows[0]!;
    const observation = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'legacy@example.test',1,$4) RETURNING id",
        [
          ws,
          mailbox,
          owner,
          ["https://www.googleapis.com/auth/gmail.readonly"],
        ],
      )
    ).rows[0]!;
    const release = await storeFixtureCiGateRecord(fixture.db, "105270");
    const current = crmAcquisitionDiagnosticAuthorizationSchema.parse({
      ...legacy,
      id: randomUUID(),
      schemaVersion: 90,
      metadataUnits: 20,
      bodyUnits: 20,
      maxUnits: 42,
      accountBinding: businessAccountBinding(ws, actualMailbox),
      oauthGrantObservationId: observation.id,
      implementationCommit: FIXTURE_CI_COMMIT,
      apiImageDigest: FIXTURE_API_DIGEST,
      releaseReference: release,
    });
    const currentHash = createHash("sha256")
      .update(JSON.stringify(current))
      .digest("hex");
    await fixture.db.query(
      "INSERT INTO crm_acquisition_diagnostic_authorizations(workspace_id,id,owner_user_id,mailbox_id,authorization_sha256,authorization_document,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ws,
        current.id,
        owner,
        mailbox,
        currentHash,
        JSON.stringify(current),
        current.verifiedAt,
        current.validUntil,
      ],
    );
    const currentRuntime: CrmAcquisitionDiagnosticRuntime = {
      ...runtime,
      implementationCommit: FIXTURE_CI_COMMIT,
      imageDigest: FIXTURE_API_DIGEST,
      verifyIsolation: async () => true,
    };
    const dispatchProof = await prepareCrmAcquisitionDiagnosticIsolation(
      context,
      { authorizationId: current.id },
      currentRuntime,
    );
    expect(dispatchProof).not.toBeNull();
    expect(
      await verifyCrmAcquisitionDiagnostic(
        context,
        current.id,
        currentRuntime,
        true,
        dispatchProof!,
      ),
    ).toEqual(current);
    const progressProof = await prepareCrmAcquisitionDiagnosticIsolation(
      context,
      { authorizationId: current.id },
      currentRuntime,
      "progress_read",
    );
    expect(progressProof).not.toBeNull();
    expect(
      await verifyCrmAcquisitionDiagnostic(
        context,
        current.id,
        currentRuntime,
        true,
        progressProof!,
      ),
    ).toBeNull();
    await expect(
      session.query(
        "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units) VALUES($1,$2,'wrong-cost','metadata','controlled','calling',5)",
        [ws, current.id],
      ),
    ).rejects.toMatchObject({ constraint: "crm_diagnostic_operation_units" });
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='crm.mail_capture'",
        )
      ).rows[0],
    ).toEqual({ n: 0 });
  } finally {
    await fixture.stop();
  }
});
