import { z } from 'zod';
import { seedFirm, seedContact } from './support/crmSeed.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createGmailMailCaptureProvider } from '@fss/domain/mail/crmGmailProvider.ts';
import { createApprovedBusinessMailObserver } from '@fss/domain/mail/crmSources.ts';
import { METADATA_REVIEW_DISCLOSURE } from '@fss/domain/business/acquisition.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import type { businessMailCaptureHandler } from '@fss/domain/mail/crmSources.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
function captureHandler(
  deps: Parameters<typeof businessMailCaptureHandler>[0],
) {
  const registry = registerHandlers(new HandlerRegistry(), {
    classifier: undefined,
    mail: undefined,
    send: undefined,
    research: undefined,
    crmMailCapture: deps,
  });
  const handler = registry.get('crm.mail_capture');
  if (!handler) throw new Error('CRM mail capture worker handler missing');
  return handler;
}

import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { createAuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { dispatch } from '../src/server.ts';

async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  ownerUserId = fixture.alpha.admin.userId,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",
      [workspaceId, ownerUserId],
    )
  ).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query(
    "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,false)",
    [workspaceId, mailbox.id, ownerUserId, binding],
  );
  const conversationId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'approved-thread','Business','[]',now(),'business','fixture','fixture',$5) RETURNING id",
      [workspaceId, mailbox.id, ownerUserId, binding, 'a'.repeat(64)],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'full-body-fixture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",
    [workspaceId, mailbox.id, ownerUserId, binding, 'b'.repeat(64)],
  );
  await enqueueJob(fixture.db, {
    workspaceId,
    kind: 'crm.mail_capture',
    idempotencyKey: 'approved-fixture',
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: 'approved-message',
      providerAccountId: 'google-business',
      generation: 1,
      conversationId,
      controlsRevision: 1,
      policyRevision: 1,
      decisionRevision: 0,
    },
  });
  const job = (
    await claimJobs(fixture.db, {
      owner: 'capture-fixture',
      kinds: ['crm.mail_capture'],
      limit: 1,
      leaseSeconds: 120,
    })
  )[0]!;
  return { workspaceId, ownerUserId, mailbox, binding, conversationId, job };
}

it('disabled acquisition calls no body adapter and creates no source, person or enrollment', async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const mailboxId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING id",
        [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
      )
    ).rows[0]!.id;
    expect(
      (await post('/crm/business/mail/controls/read', { mailboxId })).body,
    ).toMatchObject({
      enabled: false,
      ready: false,
      reason: 'acquisition_disabled',
      revision: 0,
    });
    const sourceId = randomUUID();
    let bodyReads = 0;
    const handler = captureHandler({
      provider: {
        async read() {
          bodyReads++;
          throw new Error(
            'Disabled acquisition must never read provider content',
          );
        },
      },
    });
    const result = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(fixture.alpha.workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job: {
        id: randomUUID(),
        workspaceId: fixture.alpha.workspaceId,
        kind: 'crm.mail_capture',
        idempotencyKey: 'disabled-fixture',
        payload: {
          mailboxId,
          providerMessageId: 'approved-message',
          providerAccountId: 'google-business',
          generation: 1,
        },
        attempt: 1,
        maxAttempts: 4,
        fencingToken: '1',
        leaseOwner: 'controlled-fixture',
        leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    expect(result).toMatchObject({
      done: true,
      progress: { outcome: 'acquisition_disabled' },
    });
    expect(bodyReads).toBe(0);
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 1,
          contentHash: null,
        })
      ).body,
    ).toMatchObject({
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    });
    expect((await post('/crm/people/list', {})).body).toMatchObject({
      people: [],
    });
    expect((await post('/enrollments', {})).body).toMatchObject({
      enrollments: [],
    });
  } finally {
    await fixture.stop();
  }
});

it('captures an approved unknown business message with immutable lineage and conserves replay', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, ownerUserId, mailbox, binding, job } =
      await approveCaptureFixture(fixture);
    const passage = 'Could we discuss maintenance next week?';
    let reads = 0;
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return (
            proof.grantReceipt === 'fixture-grant' &&
            proof.accountBinding === binding
          );
        },
      },
      provider: {
        async read() {
          reads++;
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: 'Thu, 08 Oct 2026 10:00:00 -0500',
            from: 'Unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: passage,
            parserVersion: 'fixture-mime-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: passage.length, kind: 'authored' }],
          };
        },
      },
    });
    const outcome = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job,
    });
    expect(outcome).toMatchObject({
      done: true,
      progress: { outcome: 'captured', sourceRevision: 1 },
    });
    const sourceId = outcome?.progress['sourceId'];
    expect(typeof sourceId).toBe('string');
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const read = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(read.body).toMatchObject({
      state: 'available',
      source: {
        sourceId,
        sourceRevision: 1,
        passage,
        ownerUserId,
        mailboxId: mailbox.id,
        accountBinding: binding,
        acquiredGeneration: 1,
        originalContexts: [],
        sentProof: false,
        participants: ['Unknown@business.test', 'business@example.test'],
      },
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({
      done: true,
      progress: { outcome: 'already_captured', sourceId },
    });
    const evidence = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/evidence/read',
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
          locator: 'text:0:12',
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(evidence.body).toMatchObject({
      state: 'available',
      source: { passage: passage.slice(0, 12), locator: 'text:0:12' },
    });
    await fixture.db.query(
      "UPDATE mailboxes SET status='disconnected',disconnected_at=now() WHERE workspace_id=$1 AND id=$2",
      [workspaceId, mailbox.id],
    );
    const disconnectedRead = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(disconnectedRead.body).toMatchObject({
      state: 'available',
      source: { passage },
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({
      done: true,
      progress: { outcome: 'authority_unavailable' },
    });
    await fixture.db.query(
      "UPDATE mailboxes SET status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2",
      [workspaceId, mailbox.id],
    );
    expect(reads).toBe(1);
    const deletion = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/delete',
        body: {
          sourceId,
          expectedRevision: 1,
          commandId: randomUUID(),
          clientVersion: '1.4.0',
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(deletion.status).toBe(200);
    expect(deletion.body).toMatchObject({
      status: 'accepted',
      result: { sourceId, availability: 'deleted', sourceRevision: 2 },
    });
    const deletedRead = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(deletedRead.body).toMatchObject({
      state: 'unavailable',
      reason: 'deleted',
      source: null,
    });
    expect(JSON.stringify(deletedRead.body)).not.toContain(passage);
    const copyState = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/state/read',
        body: { sourceId },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(copyState.body).toEqual({ revision: 2, availability: 'deleted' });

    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({ done: true, progress: { outcome: 'source_deleted' } });
    expect(reads).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it('revocation during provider wait cannot publish a source or successor intent', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, mailbox, binding, job } =
      await approveCaptureFixture(fixture);
    const body = 'Revoked message must remain unavailable';
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return proof.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          await fixture.db.query(
            "UPDATE mailboxes SET status='revoked',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",
            [workspaceId, mailbox.id],
          );
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'other@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body,
            parserVersion: 'fixture-mime-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: body.length, kind: 'authored' }],
          };
        },
      },
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({ done: true, progress: { outcome: 'authority_changed' } });
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const list = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/list',
        body: { mailboxId: mailbox.id },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(list.body).toMatchObject({ sources: [], nextAfterId: null });
  } finally {
    await fixture.stop();
  }
});

it('explicit person association preserves the original unresolved copy and advances context revision', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, mailbox, binding, job } =
      await approveCaptureFixture(fixture);
    const passage = 'An unknown business correspondent';
    const handler = captureHandler({
      proofVerifier: {
        async verify(p) {
          return p.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'Unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: passage,
            parserVersion: 'fixture-mime-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: passage.length, kind: 'authored' }],
          };
        },
      },
    });
    const outcome = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job,
    });
    const sourceId = outcome?.progress['sourceId'];
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const created = await post('/crm/people/create', {
      fullName: 'Observed business contact',
      commandId: randomUUID(),
      clientVersion: '1.4.0',
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    expect(
      (
        await post('/crm/business/mail/associate', {
          sourceId,
          expectedRevision: 1,
          personId,
          commandId: randomUUID(),
          clientVersion: '1.4.0',
        })
      ).body,
    ).toMatchObject({
      status: 'accepted',
      result: { sourceId, sourceRevision: 2 },
    });
    const hash = createHash('sha256').update(passage).digest('hex');
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 2,
          contentHash: hash,
        })
      ).body,
    ).toMatchObject({
      state: 'available',
      source: {
        originalContexts: [],
        reviewedContexts: [{ personId, firmId: null, sourceRevision: 2 }],
      },
    });
    expect(
      (
        await post('/crm/business/mail/list', {
          mailboxId: mailbox.id,
          personId,
        })
      ).body,
    ).toMatchObject({
      sources: [{ sourceId, sourceRevision: 2 }],
      nextAfterId: null,
    });
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 1,
          contentHash: hash,
        })
      ).body,
    ).toMatchObject({ state: 'unavailable', reason: 'source_changed' });
    expect((await post('/enrollments', {})).body).toMatchObject({
      enrollments: [],
    });
  } finally {
    await fixture.stop();
  }
});

it('legacy metadata without captured account lineage remains provenance unavailable', async () => {
  const fixture = await createAuthFixture();
  try {
    const mailboxId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id) VALUES($1,$2,'legacy@example.test','today-account') RETURNING id",
        [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
      )
    ).rows[0]!.id;
    const sourceId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date) VALUES($1,$2,'old-message','old-thread','incoming','2025-01-01T00:00:00Z') RETURNING id",
        [fixture.alpha.workspaceId, mailboxId],
      )
    ).rows[0]!.id;
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const result = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: { sourceId, sourceRevision: 1, contentHash: null },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(result.body).toMatchObject({
      state: 'unavailable',
      reason: 'provenance_unavailable',
      source: null,
    });
    expect(JSON.stringify(result.body)).not.toContain('today-account');
  } finally {
    await fixture.stop();
  }
});

it.each([
  {
    labels: ['SENT'],
    completeness: 'complete' as const,
    kind: 'authored' as const,
    origin: 'imported' as const,
    proof: false,
  },
  {
    labels: ['SENT'],
    completeness: 'complete' as const,
    kind: 'authored' as const,
    origin: 'unknown' as const,
    proof: false,
  },
  {
    labels: ['SENT'],
    completeness: 'complete' as const,
    kind: 'authored' as const,
    from: 'business@example.test',
    proof: true,
  },
  {
    labels: ['SENT'],
    completeness: 'complete' as const,
    kind: 'authored' as const,
    from: 'Business@example.test',
    proof: false,
  },
  {
    labels: ['SENT', 'DRAFT'],
    completeness: 'complete' as const,
    kind: 'authored' as const,
    proof: false,
  },
  {
    labels: ['SENT'],
    completeness: 'partial' as const,
    kind: 'authored' as const,
    proof: false,
  },
  {
    labels: ['SENT'],
    completeness: 'complete' as const,
    kind: 'forwarded' as const,
    proof: false,
  },
])(
  'retains truthful Sent proof for $labels / $completeness / $kind',
  async (example) => {
    const fixture = await createAuthFixture();
    try {
      const { workspaceId, binding, job } =
        await approveCaptureFixture(fixture);
      const passage = 'A manually sent business reply';
      const handler = captureHandler({
        proofVerifier: {
          async verify(p) {
            return p.accountBinding === binding;
          },
        },
        provider: {
          async read() {
            return {
              providerAccountId: 'google-business',
              messageId: 'approved-message',
              threadId: 'approved-thread',
              labels: example.labels,
              origin: 'origin' in example ? example.origin : 'sent',
              providerAt: '2026-10-08T15:00:00.000Z',
              rawSenderDate: null,
              from: 'from' in example ? example.from : 'business@example.test',
              to: ['Unknown@business.test'],
              cc: [],
              subject: 'Business',
              body: passage,
              parserVersion: 'fixture-mime-v1',
              representation: 'plain_text',
              completeness: example.completeness,
              ranges: [{ start: 0, end: passage.length, kind: example.kind }],
            };
          },
        },
      });
      const outcome = await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      });
      expect(outcome).toMatchObject({
        done: true,
        progress: { outcome: 'captured' },
      });
      const token = (
        await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
      ).accessToken;
      const response = await dispatch(
        {
          method: 'POST',
          path: '/crm/business/mail/read',
          body: {
            sourceId: outcome?.progress['sourceId'],
            sourceRevision: 1,
            contentHash: createHash('sha256').update(passage).digest('hex'),
          },
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
      expect(response.body).toMatchObject({
        state: 'available',
        source: {
          sentProof: example.proof,
          completeness: example.completeness,
          ranges: [{ kind: example.kind }],
        },
      });
    } finally {
      await fixture.stop();
    }
  },
);

it('snapshots an existing exact operational context without inventing a person', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, ownerUserId, mailbox, binding, job } =
      await approveCaptureFixture(fixture);
    const firmId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,'Original business firm',$2) RETURNING id",
        [workspaceId, ownerUserId],
      )
    ).rows[0]!.id;
    const opportunityId = (
      await fixture.db.query<{ id: string }>(
        'INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id',
        [workspaceId, firmId],
      )
    ).rows[0]!.id;
    const sourceId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,'approved-message','approved-thread','incoming','2026-10-08T15:00:00Z',true) RETURNING id",
        [workspaceId, mailbox.id],
      )
    ).rows[0]!.id;
    const matchId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread') RETURNING id",
        [workspaceId, sourceId, firmId, opportunityId],
      )
    ).rows[0]!.id;
    const passage = 'A known operational message';
    const handler = captureHandler({
      proofVerifier: {
        async verify(p) {
          return p.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'Unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: passage,
            parserVersion: 'fixture-mime-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: passage.length, kind: 'authored' }],
          };
        },
      },
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({
      done: true,
      progress: { outcome: 'captured', sourceId },
    });
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const response = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(response.body).toMatchObject({
      state: 'available',
      source: {
        originalContexts: [
          {
            personId: null,
            firmId,
            opportunityId,
            operationalMatchId: matchId,
            sourceRevision: 1,
          },
        ],
        reviewedContexts: [],
      },
    });
  } finally {
    await fixture.stop();
  }
});

it('registered retention preserves approved unmatched business copies beyond metadata horizons', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, mailbox, binding, job, conversationId } =
      await approveCaptureFixture(fixture);
    const passage = 'Approved unknown firm business correspondence';
    const handler = captureHandler({
      proofVerifier: {
        async verify(p) {
          return p.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'Unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: passage,
            parserVersion: 'fixture-mime-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: passage.length, kind: 'authored' }],
          };
        },
      },
    });
    const captured = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job,
    });
    const sourceId = captured?.progress['sourceId'];
    await fixture.db.query(
      "UPDATE mail_messages SET recorded_at=now()-interval '120 days' WHERE workspace_id=$1 AND id=$2",
      [workspaceId, sourceId],
    );
    await fixture.db.query(
      "UPDATE crm_business_conversations SET latest_provider_at=now()-interval '120 days' WHERE workspace_id=$1 AND id=$2",
      [workspaceId, conversationId],
    );
    const ordinarySourceId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,recorded_at) VALUES($1,$2,'ordinary-unmatched','ordinary-thread','incoming',now()-interval '120 days',now()-interval '120 days') RETURNING id",
        [workspaceId, mailbox.id],
      )
    ).rows[0]!.id;
    await enqueueJob(fixture.db, {
      workspaceId,
      kind: 'retention.batch',
      idempotencyKey: 'business-horizon-fixture',
      payload: {
        dataKind: 'unmatched_gmail_metadata',
        period: new Date().toISOString().slice(0, 10),
      },
    });
    const retentionJob = (
      await claimJobs(fixture.db, {
        owner: 'retention-fixture',
        kinds: ['retention.batch'],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0]!;
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
    });
    const retention = registry.get('retention.batch');
    if (!retention) throw new Error('Registered retention handler unavailable');
    await retention.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job: retentionJob,
    });
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const read = (id: unknown, hash: string | null) =>
      dispatch(
        {
          method: 'POST',
          path: '/crm/business/mail/read',
          body: { sourceId: id, sourceRevision: 1, contentHash: hash },
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    expect(
      (await read(sourceId, createHash('sha256').update(passage).digest('hex')))
        .body,
    ).toMatchObject({ state: 'available', source: { passage } });
    expect((await read(ordinarySourceId, null)).body).toMatchObject({
      state: 'unavailable',
      reason: 'source_unknown',
      source: null,
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({
      done: true,
      progress: { outcome: 'already_captured', sourceId },
    });
  } finally {
    await fixture.stop();
  }
});

it('registered sync stages approved metadata then capture through the pinned account-aware observer', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, ownerUserId, mailbox, binding } =
      await approveCaptureFixture(fixture);
    await fixture.db.query(
      'UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',
      [
        workspaceId,
        mailbox.id,
        METADATA_REVIEW_DISCLOSURE.version,
        METADATA_REVIEW_DISCLOSURE.sha256,
      ],
    );
    await fixture.db.query(
      "UPDATE mailboxes SET sync_state='ready',history_id='1',history_id_updated_at=now(),baseline_from_at=now()-interval '1 hour',baseline_completed_at=now() WHERE workspace_id=$1 AND id=$2",
      [workspaceId, mailbox.id],
    );
    const cipher = localEnvelopeCipher();
    await storeRefreshToken(
      {
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        db: fixture.db,
      },
      {
        mailboxId: mailbox.id,
        plaintext: randomBytes(24).toString('base64url'),
        cipher,
      },
    );
    const passage = 'Business correspondence found by normal sync';
    const gmail = recordedGmailClient({
      emailAddress: 'business@example.test',
      historyId: '2',
      messages: [
        {
          id: 'approved-message',
          threadId: 'approved-thread',
          historyId: '2',
          internalDateEpochMilliseconds: Date.now(),
          labelIds: ['INBOX'],
          headers: {
            From: 'Unknown@business.test',
            To: 'business@example.test',
            Subject: 'Business',
          },
          body: passage,
        },
      ],
    });
    const observer = createApprovedBusinessMailObserver({
      classify: () => ({
        category: 'business',
        reason: 'business_metadata',
        classifierVersion: 'fixture-metadata-v1',
      }),
    });
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      send: undefined,
      research: undefined,
      mail: {
        gmail,
        cipher,
        oauth: {
          clientId: 'fixture',
          clientSecret: randomBytes(24).toString('base64url'),
          redirectUri: 'https://example.test/callback',
          authorizationEndpoint: 'https://example.test/authorize',
          tokenEndpoint: 'https://example.test/token',
          revocationEndpoint: 'https://example.test/revoke',
          apiBaseUrl: 'https://example.test/mail',
        },
        journal: recordingSuppressionJournal(),
        replyPromoter: { async promoteReply() {} },
        pushTopicName: 'projects/example/topics/mail',
        businessMailObserver: observer,
      },
      crmMailCapture: {
        proofVerifier: {
          async verify(proof) {
            return proof.accountBinding === binding;
          },
        },
        provider: createGmailMailCaptureProvider({
          gmail,
          async resolveAccess(_request) {
            return {
              providerAccountId: 'google-business',
              generation: 1,
              mailboxId: mailbox.id,
              access: {
                accessToken: randomBytes(24).toString('base64url'),
                expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 60,
              },
            };
          },
        }),
      },
    });
    await enqueueJob(fixture.db, {
      workspaceId,
      kind: 'mail.sync',
      idempotencyKey: 'observer-sync-fixture',
      payload: { mailboxId: mailbox.id },
    });
    const syncJob = (
      await claimJobs(fixture.db, {
        owner: 'observer-sync',
        kinds: ['mail.sync'],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0]!;
    await registry.get('mail.sync')!.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job: syncJob,
    });
    expect(
      gmail.calls.filter((call) => call.method === 'getBody'),
    ).toHaveLength(0);
    const captureJob = (
      await claimJobs(fixture.db, {
        owner: 'observer-capture',
        kinds: ['crm.mail_capture'],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0];
    expect(captureJob).toBeDefined();
    if (!captureJob) throw new Error('Approved sync did not enqueue capture');
    const outcome = await registry.get('crm.mail_capture')!.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job: captureJob,
    });
    expect(outcome).toMatchObject({
      done: true,
      progress: { outcome: 'captured' },
    });
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const result = await dispatch(
      {
        method: 'POST',
        path: '/crm/business/mail/read',
        body: {
          sourceId: outcome?.progress['sourceId'],
          sourceRevision: 1,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(result.body).toMatchObject({
      state: 'available',
      source: {
        passage,
        ownerUserId,
        mailboxId: mailbox.id,
        accountBinding: binding,
        acquiredGeneration: 1,
        originalContexts: [],
      },
    });
  } finally {
    await fixture.stop();
  }
});

it('refuses a newly returned deleted participant after the provider wait even without original matches', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, binding, job } = await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          suppressionJournal: recordingSuppressionJournal(),
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: '1.4.0',
      ...fields,
    });
    const firmId = await seedFirm(fixture, {
      name: 'Deleted correspondent firm',
      assignedUserId: fixture.alpha.admin.userId,
    });
    const contactId = await seedContact(fixture, {
      firmId,
      fullName: 'Deleted correspondent',
    });
    expect(
      (
        await post(
          '/contacts/routes/add',
          command({
            firmId,
            contactId,
            routeKind: 'email',
            value: 'deleted@firm.example',
            source: 'salesperson',
            technicalValidation: 'passed',
            associationConfidence: 0.95,
          }),
        )
      ).status,
    ).toBe(200);
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return proof.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          const preview = await post(
            '/retention/deletions/preview',
            command({ targetKind: 'contact', firmId, contactId }),
          );
          const receipt = z
            .object({
              result: z.object({
                requestId: z.string(),
                previewHash: z.string(),
              }),
            })
            .parse(preview.body).result;
          expect(
            (await post('/retention/deletions/commit', command(receipt)))
              .status,
          ).toBe(200);
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'deleted@firm.example',
            to: ['business@example.test'],
            cc: [],
            subject: 'Private deleted correspondence',
            body: 'Deleted private passage',
            parserVersion: 'fixture-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: 23, kind: 'authored' }],
          };
        },
      },
    });
    expect(
      await handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job,
      }),
    ).toMatchObject({ done: true, progress: { outcome: 'source_deleted' } });
    expect(
      (await post('/crm/business/mail/list', { limit: 50 })).body,
    ).toMatchObject({ sources: [] });
  } finally {
    await fixture.stop();
  }
});

it('omits owner-private mail summaries when any reviewed firm assignment is no longer authorized', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, binding, job } = await approveCaptureFixture(
      fixture,
      fixture.alpha.salesperson.userId,
    );
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return proof.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Private firm topic',
            body: 'Private firm topic',
            parserVersion: 'fixture-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: 18, kind: 'authored' }],
          };
        },
      },
    });
    const result = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job,
    });
    const sourceId = z.string().parse(result?.progress['sourceId']);
    const firmId = await seedFirm(fixture, {
      name: 'Reviewed firm',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect(
      (
        await post('/crm/business/mail/associate', {
          commandId: randomUUID(),
          clientVersion: '1.4.0',
          sourceId,
          expectedRevision: 1,
          firmId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post('/crm/business/mail/list', { limit: 50 })).body,
    ).toMatchObject({ sources: [{ sourceId, sourceRevision: 2 }] });
    await fixture.db.query(
      'UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',
      [workspaceId, firmId, fixture.alpha.admin.userId],
    );
    expect(
      (await post('/crm/business/mail/list', { limit: 50 })).body,
    ).toMatchObject({ sources: [] });
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 2,
          contentHash: null,
        })
      ).body,
    ).toMatchObject({ state: 'unavailable' });
  } finally {
    await fixture.stop();
  }
});

it('captures a safe observed sender label as an unknown-firm person without any operational contact or enrollment', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, binding, job } = await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return proof.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'morgan@unknown.test',
            fromDisplayName: 'Morgan Avery',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: 'A business discussion',
            parserVersion: 'fixture-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: 21, kind: 'authored' }],
          };
        },
      },
    });
    const result = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: 'system',
        component: 'worker',
      }),
      job,
    });
    expect(result).toMatchObject({
      done: true,
      progress: { outcome: 'captured' },
    });
    const sourceId = z.string().parse(result?.progress['sourceId']);
    const source = (
      await post('/crm/business/mail/read', {
        sourceId,
        sourceRevision: 1,
        contentHash: createHash('sha256')
          .update('A business discussion')
          .digest('hex'),
      })
    ).body;
    expect(source).toMatchObject({
      state: 'available',
      source: {
        originalContexts: [
          {
            personId: expect.any(String),
            firmId: null,
            identityStatus: 'observed_label',
          },
        ],
      },
    });
    expect((await post('/crm/people/list', { limit: 50 })).body).toMatchObject({
      people: [{ fullName: 'Morgan Avery', firm: null }],
    });
    expect((await post('/enrollments', {})).body).toMatchObject({
      enrollments: [],
    });
    const nextMessage = async (messageId: string, label: string) => {
      await enqueueJob(fixture.db, {
        workspaceId,
        kind: 'crm.mail_capture',
        idempotencyKey: messageId,
        payload: { ...job.payload, providerMessageId: messageId },
      });
      const nextJob = (
        await claimJobs(fixture.db, {
          owner: 'continuity-fixture',
          kinds: ['crm.mail_capture'],
          limit: 1,
          leaseSeconds: 120,
        })
      )[0]!;
      const nextHandler = captureHandler({
        proofVerifier: {
          async verify(proof) {
            return proof.accountBinding === binding;
          },
        },
        provider: {
          async read() {
            return {
              providerAccountId: 'google-business',
              messageId,
              threadId: 'approved-thread',
              labels: ['INBOX'],
              providerAt: '2026-10-09T15:00:00.000Z',
              rawSenderDate: null,
              from: 'morgan@unknown.test',
              fromDisplayName: label,
              to: ['business@example.test'],
              cc: [],
              subject: 'Business',
              body: 'Another discussion',
              parserVersion: 'fixture-v1',
              representation: 'plain_text',
              completeness: 'complete',
              ranges: [{ start: 0, end: 18, kind: 'authored' }],
            };
          },
        },
      });
      const next = await nextHandler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job: nextJob,
      });
      expect(next).toMatchObject({
        done: true,
        progress: { outcome: 'captured' },
      });
      return (
        await post('/crm/business/mail/read', {
          sourceId: next?.progress['sourceId'],
          sourceRevision: 1,
          contentHash: createHash('sha256')
            .update('Another discussion')
            .digest('hex'),
        })
      ).body;
    };
    expect(
      await nextMessage('continuity-message', 'Morgan Avery'),
    ).toMatchObject({
      source: {
        originalContexts: [
          { personId: expect.any(String), identityStatus: 'observed_label' },
        ],
      },
    });
    expect(
      await nextMessage('conflicting-label-message', 'Taylor Jordan'),
    ).toMatchObject({ source: { originalContexts: [] } });
    const people = z
      .object({ people: z.array(z.object({ fullName: z.string() })) })
      .parse((await post('/crm/people/list', { limit: 50 })).body);
    expect(people.people).toEqual([{ fullName: 'Morgan Avery' }]);
    await fixture.db.query(
      'UPDATE mail_message_bodies SET body_text=$3 WHERE workspace_id=$1 AND mail_message_id=$2',
      [workspaceId, sourceId, 'A changed passage'],
    );
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256')
            .update('A business discussion')
            .digest('hex'),
        })
      ).body,
    ).toMatchObject({ state: 'unavailable', reason: 'source_changed' });
  } finally {
    await fixture.stop();
  }
});

it('requires an explicit revision-bound recapture after restore and preserves old reference vetoes', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, binding, job } = await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: 'POST',
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: '1.4.0',
      ...fields,
    });
    let passage = 'Original private copy';
    let reads = 0;
    const handler = captureHandler({
      proofVerifier: {
        async verify(proof) {
          return proof.accountBinding === binding;
        },
      },
      provider: {
        async read() {
          reads++;
          return {
            providerAccountId: 'google-business',
            messageId: 'approved-message',
            threadId: 'approved-thread',
            labels: ['INBOX'],
            providerAt: '2026-10-08T15:00:00.000Z',
            rawSenderDate: null,
            from: 'unknown@business.test',
            to: ['business@example.test'],
            cc: [],
            subject: 'Business',
            body: passage,
            parserVersion: 'fixture-v1',
            representation: 'plain_text',
            completeness: 'complete',
            ranges: [{ start: 0, end: passage.length, kind: 'authored' }],
          };
        },
      },
    });
    const worker = (claimed: typeof job) =>
      handler.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: 'system',
          component: 'worker',
        }),
        job: claimed,
      });
    const original = await worker(job);
    const sourceId = z.string().parse(original?.progress['sourceId']);
    expect(
      (
        await post(
          '/crm/business/mail/delete',
          command({ sourceId, expectedRevision: 1 }),
        )
      ).body,
    ).toMatchObject({ status: 'accepted', result: { sourceRevision: 2 } });
    expect(
      (
        await post(
          '/crm/business/mail/restore',
          command({ sourceId, expectedRevision: 2 }),
        )
      ).body,
    ).toMatchObject({
      status: 'accepted',
      result: { sourceRevision: 3, availability: 'awaiting_recapture' },
    });
    expect(await worker(job)).toMatchObject({
      progress: { outcome: 'source_deleted' },
    });
    expect(reads).toBe(1);
    const requested = await post(
      '/crm/business/mail/recapture',
      command({ sourceId, expectedRevision: 3 }),
    );
    expect(requested.body).toMatchObject({
      status: 'accepted',
      result: { sourceId, sourceRevision: 3, status: 'queued' },
    });
    passage = 'Fresh explicitly recaptured copy';
    const next = (
      await claimJobs(fixture.db, {
        owner: 'recapture-fixture',
        kinds: ['crm.mail_capture'],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0]!;
    expect(await worker(next)).toMatchObject({
      progress: { outcome: 'captured', sourceId, sourceRevision: 4 },
    });
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 4,
          contentHash: createHash('sha256').update(passage).digest('hex'),
        })
      ).body,
    ).toMatchObject({
      state: 'available',
      source: { passage, sourceRevision: 4 },
    });
    expect(
      (
        await post('/crm/business/mail/read', {
          sourceId,
          sourceRevision: 1,
          contentHash: createHash('sha256')
            .update('Original private copy')
            .digest('hex'),
        })
      ).body,
    ).toMatchObject({ state: 'unavailable' });
    expect(
      (await post('/crm/business/mail/state/read', { sourceId })).body,
    ).toEqual({ revision: 4, availability: 'available' });
    expect(await worker(job)).toMatchObject({
      progress: { outcome: 'source_deleted' },
    });
    expect(reads).toBe(2);
  } finally {
    await fixture.stop();
  }
});
