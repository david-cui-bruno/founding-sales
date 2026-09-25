// Release mutations that edit the API (`apps/api/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the production API accepts a journal that keeps nothing',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "const suppressionJournal = dependencies === 'live' ? requireDurableJournal(resolved) : resolved.journal;",
    replace: 'const suppressionJournal = resolved.journal;',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/deployment.test.ts'],
    because:
      '10.2 makes the journal write a precondition of acknowledging a suppression. A live API that silently used the local no-op would accept opt-outs with nothing to replay after a restore.',
  },
  {
    name: 'the production API stops requiring a sign-in client',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: '  const signInBundle = readGoogleClientBundle(required(environment, VARIABLES.oidcClient), VARIABLES.oidcClient);',
    replace: "  const signInBundle = { clientId: 'x', clientSecret: 'y', pushTopic: null, hostedDomain: null };",
    suite: ['run', 'test:release'],
    because:
      'G12 shipped the API with no identity at all, which from outside looks exactly like a working deployment that refuses every command. Appendix G 23\'s four replay refusals are dead code without sign-in, so the release suite must go red when a live deployment can start without it.',
  },
  {
    name: 'sign-in stops adopting the workspace the operator bootstrapped',
    file: 'apps/api/src/auth/signIn.ts',
    find: '      WHERE google_sub = $4 || $2\n',
    replace: '      WHERE google_sub = $1\n',
    suite: ['run', 'test:release'],
    because:
      '`fss admin workspace bootstrap` writes the first admin\u2019s users row with a sentinel google_sub, because the real Google sub cannot be known before that person signs in. This UPDATE is the only thing that turns it into a real account; without it the first sign-in inserts a *second* users row, the membership still hangs off the first, and the person is refused membership_required for ever \u2014 which from outside is indistinguishable from having no access. The release check reads the statement and its NOT EXISTS guard.',
  },
  {
    name: 'discovery goes back to requiring every endpoint at the issuer origin',
    file: 'apps/api/src/auth/googleClient.ts',
    find:
      "  if (url.origin === issuer.origin) return true;\n  if (url.protocol !== 'https:') return false;\n  return url.hostname === issuer.hostname || url.hostname.endsWith('.googleapis.com');\n",
    replace: '  return url.origin === issuer.origin;\n',
    suite: ['run', 'test:release'],
    because:
      'This is production\u2019s first real sign-in exactly (24 September 2026): four refusals `token_exchange_failed`, because Google\u2019s discovery document names its token endpoint on oauth2.googleapis.com and its key set on www.googleapis.com while the issuer is accounts.google.com, so the same-origin rule answered null and the exchange never ran. The rehearsal has no real Google and the lane tests\u2019 local provider serves every endpoint from one origin, so scenario23 asserts the rule against Google\u2019s real hosts and has to go red when it is put back.',
  },
  {
    name: 'discovery stops requiring HTTPS for a Google API host',
    file: 'apps/api/src/auth/googleClient.ts',
    find: "  if (url.protocol !== 'https:') return false;\n",
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'Widening the rule to Google\u2019s API hosts must not widen it to plain HTTP: a document naming http://oauth2.googleapis.com/token would send the code and the client secret in the clear to whoever is on the path. scenario23\u2019s refusal case includes exactly that endpoint and has to go red.',
  },
  {
    name: 'the id token accepts any issuer',
    file: 'apps/api/src/auth/idToken.ts',
    find: '  if (claimed === null) return false;\n  if (claimed === configured) return true;\n',
    replace: '  return true;\n',
    suite: ['run', 'test:release'],
    because:
      'Widening the issuer check to the two forms Google documents (`https://accounts.google.com` and `accounts.google.com`, 24 September 2026) must not widen it to everything: a validator that accepts any `iss` accepts a token some other issuer signed with a key that happens to be served. scenario23 validates otherwise-perfect tokens whose only fault is the issuer and has to go red.',
  },
  {
    name: 'the API stops admitting the desktop build that carries the Mailbox row',
    file: 'apps/api/src/bootstrap/main.ts',
    find: "  incompatible: [],\n",
    replace: "  incompatible: ['1.0.1'],\n",
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'Since lane g78 the container admits a policy rather than an exact maximum, and a build on its incompatible list is refused client_upgrade_required by runCommand, sign-in and renewal exactly as one below the minimum is. Desktop 1.0.1 is the build with Connect Gmail, so a policy that lists it refuses the fix outright; desktopMailbox.check.ts reads the policy the container serves and has to go red.',
  },
  {
    name: 'the Gmail callback stops registering the connected mailbox\u2019s domain',
    file: 'apps/api/src/routes/gmail.ts',
    find: '    await registerConnectedDomain(auth.db, scoped.context, outcome.value, options.log);\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/sendingDomain.test.ts'],
    because:
      'A connected mailbox\u2019s domain is the workspace\u2019s sending domain, and the callback is the only zero-step path to the row 12.7\u2019s checklist is recorded against (lane g57). Without the call the consent page still says "Gmail connected" and every status check still passes, so sendingDomain.test.ts reads sending_domains back after a real callback and has to go red when no row appears.',
  },
  // Lane g60: calling identities have a creator, the Mac has a control, and the drill's
  // dial probe has a subject.
  {
    name: 'the API stops admitting the desktop build that carries Your calling number',
    file: 'apps/api/src/bootstrap/main.ts',
    find: "  incompatible: [],\n",
    replace: "  incompatible: ['1.0.2'],\n",
    suite: ['run', 'test:release', '--', 'test/release/callingNumber.check.ts'],
    because:
      'Desktop 1.0.2 is the build with the Your calling number section, without which no salesperson has a verified number and Today offers no Call button; a policy that lists it as incompatible refuses it every sign-in, renewal and command (lane g78 replaced the exact maximum with that list). callingNumber.check.ts reads the policy the container serves and has to go red.',
  },
  {
    name: 'every API request is handed the same database connection again',
    file: 'apps/api/src/bootstrap/connections.ts',
    find: '  return {\n    checkout: async () => leaseOf(await checkoutClient(pool), log),\n',
    replace:
      '  let shared: pg.PoolClient | undefined;\n  return {\n    checkout: async () => ({ session: sessionOf((shared ??= await checkoutClient(pool))), release: () => undefined }),\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/connectionPerRequest.test.ts'],
    because:
      'This is the API until 25 September 2026: one pg.Client for every request, and withTransaction issuing BEGIN, the work and COMMIT as separate statements on it, so a request that rolled back discarded another\u2019s answered-200 write and a FOR UPDATE lock was already held by every other request. A shared connection still passes every sequential route test; connectionPerRequest.test.ts holds one request inside its transaction while a second runs, and has to go red.',
  },
  {
    name: 'the API stops giving a request\u2019s connection back when it finishes',
    file: 'apps/api/src/server.ts',
    find: '  } finally {\n    connection.release();\n  }\n',
    replace: '  } finally {\n  }\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/connectionPerRequest.test.ts'],
    because:
      'With eight connections in the pool, a handler that returns its connection only on the happy path loses one to every thrown request, and the ninth failure turns every request after it into database_busy until the task is replaced. connectionPerRequest.test.ts counts the pool back to its baseline after a request that throws, and has to go red.',
  },
  {
    name: 'the API journal put reads a 409 ConditionalRequestConflict as already present again',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "      if (name === 'PreconditionFailed') return 'already_present';\n",
    replace: "      if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict') return 'already_present';\n",
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/journalConflict.test.ts'],
    because:
      'This is audit S12 in the API: a conflicting conditional write was reported already_present, so POST /suppressions/record answered 200 for a suppression the journal never held. journalConflict.test.ts answers the put with a 409 through a fake S3 client and requires the 503 journal_unavailable, no suppression_events row and no receipt; with the conflict accepted the command succeeds and the suite has to go red.',
  },
  {
    name: 'the API journal put fails a write without logging the event its alarm counts',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "      log.log('error', 'suppression_journal_write_failed', { writer: 'api', error_name: name });\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/journalConflict.test.ts'],
    because:
      'Lane g81: the API refused a suppression with 503 journal_unavailable and logged nothing the SuppressionJournalWriteFailures filter counts, so the immediately-critical alarm never heard of it. journalConflict.test.ts requires one suppression_journal_write_failed line per refused put, 409 and denial alike, and none for a 412; without the call the suite has to go red.',
  },
  {
    name: 'the import commit takes the rows in the order they were asked, not the file’s',
    file: 'apps/api/src/routes/import.ts',
    find: '  const asked = [...parsed.data.rows].sort((left, right) => left.rowNumber - right.rowNumber);\n',
    replace: '  const asked = [...parsed.data.rows];\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/capture.test.ts'],
    because:
      'Audit item G02: a contact row that attaches to a firm created on an earlier row must run after it, or it creates a second firm from its own columns. capture.test.ts (apps/api) asks for the rows backwards, requires the file’s order and one firm, and has to go red.',
  },
  {
    name: 'a second posture for a state is answered 500 again',
    file: 'apps/api/src/routes/postures.ts',
    find: '  if (!result.ok) await context.db.query(`ROLLBACK TO SAVEPOINT ${RECORD_SAVEPOINT}`);\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/postureForm.test.ts'],
    because:
      'Lane g84: the exclusion constraint refuses an overlapping posture inside the command’s transaction, and without the savepoint the receipt insert after it failed and the route answered 500 where the domain meant posture_overlapping. The postures form is the first client that can send one. postureForm.test.ts requires a 409 with the reason and has to go red.',
  },
  {
    name: 'the API runs a route on a task whose own readiness check fails',
    file: 'apps/api/src/server.ts',
    find: '    const admission = await gate.admit(path, connection.session);\n',
    replace: '    const admission = { admitted: true } as { admitted: true } | { admitted: false; reason: string };\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/readinessGate.test.ts'],
    because:
      'Audit S14: the load balancer takes tens of seconds to drain a task whose /readyz fails, and until lane g86 every route ran meanwhile, including on a restored database whose generation is not the pinned one. readinessGate.test.ts starts a real server against such a database and requires 503 not_ready on /firms and on an admin command; with the gate bypassed they answer 404 and 401 and the suite has to go red.',
  },
  {
    name: 'the readiness gate asks the database on every request',
    file: 'apps/api/src/bootstrap/readinessGate.ts',
    find: '    return age >= 0 && age < ttl ? verdict : null;\n',
    replace: '    return age < 0 ? verdict : null;\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/readinessGate.test.ts'],
    because:
      'Lane g86: the gate must not add a database round trip per request. The verdict is kept for five seconds; readinessGate.test.ts counts the checks a fake clock allows and the checks a real server makes for five requests, and with the cache gone both count more than one.',
  },
  {
    name: 'the readiness gate caches a busy pool as a refusal',
    file: 'apps/api/src/bootstrap/readinessGate.ts',
    find: "        if (report.reason === 'database_busy') {\n",
    replace: "        if (report.reason === ('never' as string)) {\n",
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/readinessGate.test.ts'],
    because:
      'Lane g86: a check that could not get a connection proves nothing about the schema or the generation. Cached, it would refuse every request for five seconds after the pool freed up. readinessGate.test.ts requires DatabaseBusyError and a fresh check on the very next request.',
  },
  {
    name: 'an outdated Mac is refused the client-version notice while the task is not ready',
    file: 'apps/api/src/bootstrap/readinessGate.ts',
    find: "  '/auth/client-version',\n]);\n",
    replace: ']);\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/readinessGate.test.ts'],
    because:
      '5.3: the upgrade instruction is what an outdated client may always read. readinessGate.test.ts requires the four exempt paths by name, and requires /auth/client-version to answer 200 from a task that refuses every route.',
  },
  {
    name: 'a production API publishes the placeholder upgrade address when none is set',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: '    if (production) {\n      throw new DeploymentConfigError(\'MISSING\', `${name} is not set, and a production API does not publish the placeholder`);\n',
    replace: '    if (production && raw === \'never\') {\n      throw new DeploymentConfigError(\'MISSING\', `${name} is not set, and a production API does not publish the placeholder`);\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/deployment.test.ts'],
    because:
      'Lane g86: every API published https://callie.example/downloads/mac, production included. A production process does not reach a fallback by omission, and deployment.test.ts requires a live production deployment without FSS_DESKTOP_UPGRADE_URL to be refused MISSING.',
  },
  // Lane g90: email technical validation (release-records.md 8.0aw).
  {
    name: 'the Firm page sends technicalValidation to a desktop that did not ask for it',
    file: 'apps/api/src/routes/firmPage.ts',
    find: '    routeValidation: parsed.data.pageVersion === FIRM_PAGE_VERSION,\n',
    replace: '    routeValidation: true,\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/emailValidation.test.ts'],
    because:
      'The route DTO is a strict object and desktop 1.0.5 parses it with its own strict schema, so an unasked-for technicalValidation key breaks every Firm page on the installed build. emailValidation.test.ts parses the first version’s routes with 1.0.5’s schema and requires exactly its five keys; sending the key regardless, the suite has to go red.',
  },
];
