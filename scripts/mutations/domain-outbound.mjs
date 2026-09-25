// Release mutations that edit the send path (`packages/domain/outbound/` and its test support).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the outbound world stops attesting to a release gate',
    file: 'packages/domain/test/outbound/support/outboundWorld.ts',
    find: "VALUES ($1, 'sending_enabled', 1, $2::jsonb, 'fixture: the rehearsal gate this world stands for', $3)",
    replace: "VALUES ($1, 'sending_enabled', 1, $2::jsonb || '{\"enabled\":false}'::jsonb, 'fixture: the attestation withdrawn', $3)",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/'],
    because:
      'The fixture seeds 16.2 admin attestation so that cap, window and suppression scenarios refuse for their own reasons. Without it every send must hold, so a suite that still passed would not be reading the attestation at all. The replacement withdraws the attestation and keeps $2 in the statement: until lane g93 it seeded another setting and dropped $2, PostgreSQL refused the unused parameter ("could not determine data type of parameter $2") in every file\u2019s setup, and the run was broken, never killed (rehearsal at e220f468).',
  },
  {
    name: 'the send gate stops requiring the deployment flag',
    file: 'packages/domain/outbound/gate.ts',
    find: 'if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {',
    replace: 'if (false) {',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/attestation.test.ts'],
    because:
      'Appendix G 42 is four conditions ANDed, and the attestation test is the only place the dispatch path is asked about two of them. Removing the check must fail it.',
  },
  {
    name: 'registering a sending domain inserts nothing again',
    file: 'packages/domain/outbound/domainGuard.ts',
    find:
      '      `INSERT INTO sending_domains (workspace_id, domain, is_primary)\n       VALUES ($1::uuid, $2::text, NOT EXISTS (\n         SELECT 1 FROM sending_domains WHERE workspace_id = $1::uuid AND is_primary\n       ))\n       ON CONFLICT DO NOTHING\n       RETURNING ${DOMAIN_COLUMNS}`,\n',
    replace:
      '      `SELECT ${DOMAIN_COLUMNS} FROM sending_domains WHERE false AND workspace_id = $1::uuid AND domain = $2::text`,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingDomainRegistration.test.ts'],
    because:
      'This is production on 24 September 2026 (lane g57): the admin had verified SPF, DKIM, DMARC and Postmaster Tools for usecallie.com and Administration read "No sending domain is configured." because nothing in the tree inserted a sending_domains row, and recordAuthenticationChecklist is an UPDATE that answers domain_unknown without one. An idempotence test passes against a function that inserts nothing and reports what it finds, so sendingDomainRegistration.test.ts asserts `created`, reads the primary back and records the checklist on it, and has to go red.',
  },
  {
    name: 'the Sent-folder marker accepts an fss.<uuid> Message-ID at any domain',
    file: 'packages/domain/outbound/types.ts',
    find: '  return domain === sendingDomain ? fenceId : null;\n',
    replace: '  return fenceId;\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/restore/missingFences.test.ts'],
    because:
      'The marker is the whole deterministic Message-ID, <fss.{fence}@{the sending mailbox’s domain}>, because a tombstone stops a real step from ever sending. A check that took the fss.<uuid> shape alone would tombstone a copy or another system’s message onto a prospect’s pending step. missingFences.test.ts puts that shape at another domain in the Sent folder beside a pending step, expects it ignored, and has to go red.',
  },
  {
    name: 'the claim acts on the precheck’s answer instead of rechecking under the lock',
    file: 'packages/domain/outbound/send.ts',
    find: '    const gate = await decideSend(context, fence, deps);\n    if (!gate.ok) {\n',
    replace: '    const gate = { ok: true as const, value: precheck };\n    if (!gate.ok) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/dispatchRace.test.ts'],
    because:
      'This is audit S01 and T02: the gate read, OAuth ran, and a state-only UPDATE claimed on the earlier answer, so a reply that committed during the token refresh was never seen. dispatchRace.test.ts commits an uncertain reply through the real mail sync, a confirmed reply and an opt-out on another connection during the real dispatch’s token refresh, and a reply whose transaction is open when the claim begins; with the claim acting on the precheck, each of them sends, and the suite has to go red.',
  },
  {
    name: 'the cap is charged to the business date the fence was planned for, not the claim’s',
    file: 'packages/domain/outbound/gate.ts',
    find: '  const businessDate = await businessDateOf(context, now.toISOString());\n',
    replace: '  const businessDate = fence.businessDate ?? (await businessDateOf(context, now.toISOString()));\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/dispatchRecheck.test.ts'],
    because:
      'This is audit S05: a fence held overnight kept the date its placement planned, so today’s send spent yesterday’s allowance (or waited behind yesterday’s full cap) and today’s counter never moved. dispatchRecheck.test.ts plans a fence for Monday, holds it past Monday’s window and sends it Tuesday, and requires Tuesday’s counter to move, Monday’s not to, and the fence to record Tuesday; charged to the planned date it records Monday and has to go red.',
  },
  {
    name: 'the disconnected-mailbox gauge counts a mailbox its owner disconnected again',
    file: 'packages/domain/outbound/metrics.ts',
    find: "      WHERE m.status = 'revoked'\n",
    replace: "      WHERE m.status IN ('disconnected', 'revoked')\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/mailboxDisconnectedHours.test.ts'],
    because:
      'Audit O15: the disconnect command writes disconnected, and counting it made a salesperson who disconnected their own mailbox raise the critical mailbox-disconnected alarm two days later. mailboxDisconnectedHours.test.ts disconnects a recently sending mailbox on purpose and requires no datapoint, beside a revoked one that must read its 50 hours; counting both statuses the owner case reads 50 and the suite has to go red.',
  },
  {
    name: 'a stored ramp raise replaces the schedule again, whatever the mailbox has earned',
    file: 'packages/domain/outbound/ramp.ts',
    find: '  const base = ramp.raisedDailyCap === null ? scheduled : Math.min(ramp.raisedDailyCap, allowance);\n',
    replace: '  const base = ramp.raisedDailyCap ?? scheduled;\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'This is audit S06: a raise to 75 on a mailbox connected that morning replaced 12.7\u2019s schedule, so the six-week ramp was one admin click deep. sendingCeilings.test.ts writes a raise to a day-zero mailbox with five sends already today and requires the next to hold as daily_cap automated 5/5, and breaks the streak under an earned raise and requires the schedule\u2019s fifty; with the raise replacing the schedule both send and the suite has to go red.',
  },
  {
    name: 'the cap command accepts a raise without the sustained-health rule',
    file: 'packages/domain/outbound/ramp.ts',
    find: '    if (refusal !== null) return { ok: false, reason: refusal };\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'Audit S06 on the write side: 12.7 allows a raise to 75 only after sustained healthy results. sendingCeilings.test.ts asks for a raise on a mailbox twelve days into the schedule and on a settled one with nine healthy sending days since its last bad one, and requires ramp_not_settled and health_not_sustained with nothing written; accepting both, the suite has to go red.',
  },
  {
    name: 'the send gate stops enforcing the account headroom',
    file: 'packages/domain/outbound/gate.ts',
    find: '  if (!account.allowed) {\n',
    replace: '  if (false) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'This is audit S07: direct sends were counted and nothing read them, so an account a person had driven to Google\u2019s limit by hand still took FSS\u2019s whole cap. sendingCeilings.test.ts fills the mailbox\u2019s automated and direct counters for today and yesterday to the operational ceiling and requires daily_cap with detail account 1500/1500; without the check it sends and the suite has to go red.',
  },
  {
    name: 'the domain guard counts only sent fences again, not the ones in doubt',
    file: 'packages/domain/outbound/domainGuard.ts',
    find: '        AND state = ANY ($4::text[])\n',
    replace: "        AND state = ANY ($4::text[]) AND state = 'sent'\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'Audit S08: a fence in dispatching or reconciling may have been delivered, and counting only sent ones let the next claim see room under the 12.6 guard that was not there. sendingCeilings.test.ts puts a personal-Gmail send into reconciling, requires it in the automated count and the next send held at the guard, and has a second connection claim a fence mid-decision; counting sent fences only, both send and the suite has to go red.',
  },
  {
    name: 'a direct message counts once however many personal-Gmail recipients it names',
    file: 'packages/domain/outbound/domainGuard.ts',
    find: '         SELECT count(DISTINCT lower(recipient)) AS recipients\n',
    replace: '         SELECT least(count(DISTINCT lower(recipient)), 1) AS recipients\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'Audit S08: a mail merge sent as one message to forty Gmail addresses moved the guard by one. sendingCeilings.test.ts imports a direct message with three distinct personal-Gmail recipients across To and Cc and requires three, then one with two and requires the guard to hold at exactly that exposure; counting each message once, the suite has to go red.',
  },
  {
    name: 'the domain guard decides without its lock, beside a claim still in flight',
    file: 'packages/domain/outbound/domainGuard.ts',
    find: '  if (input.serialize === true) await lockDomainGuard(context);\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingCeilings.test.ts'],
    because:
      'Every claim holds the send gate shared, so two claims to personal Gmail can each count the other as unclaimed and both take the last place under the guard. sendingCeilings.test.ts has a second connection hold the guard lock and claim a fence without committing, requires the dispatch to wait on an advisory lock and then hold at the guard; without the lock it never waits, sends, and the suite has to go red.',
  },
];
