// Release mutations that edit the mailbox, sync and Gmail code (`packages/domain/mail/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the Gmail watch gauge goes back to a unit CloudWatch does not have',
    file: 'packages/domain/mail/metrics.ts',
    find: "value: Math.max(watchHours, 0), unit: 'None' });\n",
    replace: "value: Math.max(watchHours, 0), unit: 'Hours' as 'None' });\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/jobs/metricUnits.test.ts'],
    because:
      'This is production on 24 September 2026 from 18:11Z: the first connected mailbox added GmailWatchHoursToExpiry in Hours, PutMetricData rejected the whole batch every minute, and every FSS worker metric went dark. The cast defeats the type, which is exactly how a unit slips past the compiler, so metricUnits.test.ts reads every datum literal in the source against the CloudWatch set and has to go red.',
  },
  {
    name: 'the mailbox sweep skips a mailbox synced in the last five minutes again',
    file: 'packages/domain/mail/mailboxes.ts',
    find: "        AND sync_state = 'ready'\n      ORDER BY id`,\n",
    replace:
      "        AND sync_state = 'ready'\n        AND (last_synced_at IS NULL OR last_synced_at <= now() - interval '5 minutes')\n      ORDER BY id`,\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/mailHandlers.test.ts'],
    because:
      'This is production on 24 September 2026 exactly: with one mailbox and no new mail the sweep asked for a check every five minutes, the heartbeat promised sixty seconds, and fss-prod-mailbox-heartbeat-missed went ALARM and OK twice in an hour between healthy checks (lane g58). mailHandlers.test.ts syncs the mailbox for real before every pass and requires the pass to ask for another check, so it has to go red.',
  },
  {
    name: 'an opt-out is keyed on its database row id again',
    file: 'packages/domain/mail/effects.ts',
    find: '  const optOutCommand = `mail-message:${message.mailboxId}:${message.providerMessageId}`;\n',
    replace: '  const optOutCommand = `mail-message:${message.id}`;\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillRehearsal.test.ts'],
    because:
      'After a restore the recovered opt-out is a new mail_messages row with a new id, so a command id built from it mints a second event for a suppression step 2 already replayed, and has to append it to a journal the drill identity cannot write: step 4 cannot reapply the opt-out at all. drillRehearsal.test.ts gives the drill a read-only journal, as the drill task role has, and has to go red.',
  },
  {
    name: 'a restore recovery reuses the mailbox generation whose baseline is already complete',
    file: 'packages/domain/mail/recover.ts',
    find: '  const generation = await advanceGeneration(context, input.mailbox.id);\n',
    replace: '  const generation = input.mailbox.generation;\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillRehearsal.test.ts'],
    because:
      'mailbox_recoveries holds one recovery per generation, so a restore recovery started on the current one is the completed baseline, and fss admin mailbox recover reprocessed nothing while reporting a completed pass. drillRehearsal.test.ts reads the recovered opt-out and its effects back from the restored copy and has to go red when step 4 read no inbox.',
  },
  {
    name: 'a recorded Gmail built from a recording forgets its Sent folder',
    file: 'packages/domain/mail/gmailClientFake.ts',
    find: '  const sentFolder = new Set<string>(fixture.sentMessageIds ?? []);\n',
    replace: '  const sentFolder = new Set<string>();\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/rules.test.ts'],
    because:
      'The drill task is another process from the seed that sent, and its Sent search can find a delivered message only in the folder the recording hands it; an empty folder makes step 3 reconcile nothing. rules.test.ts builds a client from a recording and has to go red when the send is not found.',
  },
  // Lane g63: the push token's age bound is the hour Google gives the token.
  {
    name: 'the push webhook refuses a Google token after its first ten minutes again',
    file: 'packages/domain/mail/pushToken.ts',
    find: '  maximumAgeSeconds: 3600,\n',
    replace: '  maximumAgeSeconds: 600,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/rules.test.ts'],
    because:
      'Pub/Sub presents the same OIDC token for its whole hour, so a 600-second bound refused every push past a token\u2019s eleventh minute as too_old: 138 refusals in three hours in production on 24 and 25 September 2026. rules.test.ts decides a half-hour-old token under the shipped policy and has to go red.',
  },
  {
    name: 'the Gmail history parser reads a record’s historyId again and falls back to the start cursor',
    file: 'packages/domain/mail/gmailClientHttp.ts',
    find: "        const recordId = historyIdOf(item['id']);\n",
    replace: "        const recordId = historyIdOf(item['historyId']) ?? request.startHistoryId;\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/httpClient.test.ts'],
    because:
      'Audit item C06, lane g76: a Gmail History resource names its own id `id`; `historyId` is a field of Message. The adapter read `historyId`, found nothing, and stood every record on the start cursor, so a capped sync wrote back the cursor it began from and re-read the same first fifty messages every minute. The unit fixture carried the same wrong field. httpClient.test.ts now feeds the documented shape and has to go red.',
  },
  {
    name: 'a capped mail.sync slices inside a history record again',
    file: 'packages/domain/mail/sync.ts',
    find: "      if (change.kind === 'message_deleted' || held.has(change.messageId)) continue;\n",
    replace:
      "      if (held.size >= maxMessages) break;\n      if (change.kind === 'message_deleted' || held.has(change.messageId)) continue;\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/historyCursor.test.ts'],
    because:
      'Audit item C07, lane g76: startHistoryId returns only the records after an id, so a cursor standing on a record whose messages the cap cut off skips them for ever. historyCursor.test.ts puts the cap inside a three-message record and expects all three processed before the cursor stands on it, and has to go red.',
  },
  {
    name: 'Gmail history ids are compared through Number again',
    file: 'packages/domain/mail/historyIds.ts',
    find: '  const a = BigInt(left);\n  const b = BigInt(right);\n',
    replace: '  const a = Number(left);\n  const b = Number(right);\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/historyCursor.test.ts'],
    because:
      'Audit item C08, lane g76: Gmail history ids are uint64 decimal strings, and Number ties 9007199254740992 with 9007199254740993, so a cursor can stall on a record it read or stand past one it did not. historyCursor.test.ts orders, maxes and syncs across those ids and has to go red.',
  },
  {
    name: 'the send path trusts a ready mailbox whose coverage was proved an hour ago',
    file: 'packages/domain/mail/coverage.ts',
    find: '  if (!coverage.fresh) {\n',
    replace: '  if (false) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/dispatchRecheck.test.ts'],
    because:
      'This is audit S03: sync_state stays ready while every Gmail history read is rate limited, and recordSyncError moves last_synced_at forward as it fails, so a reply that arrived in that hour was unread and the next email to its author went anyway. dispatchRecheck.test.ts ages the watermark past COVERAGE_FRESHNESS_SECONDS, runs a rate-limited sync that moves the attempt time and not the watermark, and requires the fence held for coverage_incomplete until a real sync proves coverage; without the freshness arm it sends at once and has to go red.',
  },
  {
    name: 'the mailbox check heartbeat counts a disconnected or revoked mailbox again',
    file: 'packages/domain/mail/metrics.ts',
    find: "      WHERE m.status = 'connected'\n      ORDER BY m.id`,\n",
    replace: '      ORDER BY m.id`,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/mailboxCheckMetric.test.ts'],
    because:
      'This is audit O15: a mailbox its owner disconnected, or whose grant was revoked, left a heartbeat row that aged into a missed check, and the critical mailbox-heartbeat alarm, and with it the critical roll-up, sat in ALARM over a mailbox nothing was meant to check. mailboxCheckMetric.test.ts ages a real heartbeat row for a disconnected and a revoked mailbox and requires 1; counting every mailbox it reads 0 and the suite has to go red.',
  },
  {
    name: 'the coverage gauge reads a watermark the gate cannot credit as fresh',
    file: 'packages/domain/mail/metrics.ts',
    find: '    const reading = coverageIsFresh(age) ? Math.max(age ?? 0, 0) : Math.max(age ?? 0, COVERAGE_FRESHNESS_SECONDS + 1);\n',
    replace: '    const reading = Math.max(age ?? 0, 0);\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/mail/mailboxCoverageMetric.test.ts'],
    because:
      'Lane g81: the send gate holds an owner whose ready mailbox has no watermark, or one ten minutes in the future, and a gauge that read those as 0 would show a mailbox as healthy while every automated email for it waited. mailboxCoverageMetric.test.ts judges each case by the gauge and by readMailboxCoverage plus coverageRefusal on the same row and requires them to agree; reading the raw age puts those two cases under the window and the suite has to go red.',
  },
];
