// Release mutations that edit the CRM (`packages/domain/crm/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'an imported row that is refused keeps the firm it created before the refusal',
    file: 'packages/domain/crm/import.ts',
    find: "  if (result.ok) await context.db.query(nested ? `RELEASE SAVEPOINT ${ROW_SAVEPOINT}` : 'COMMIT');\n  else await undo();\n",
    replace: "  await context.db.query(nested ? `RELEASE SAVEPOINT ${ROW_SAVEPOINT}` : 'COMMIT');\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/capture.test.ts'],
    because:
      'Audit item G02: a row is a firm, a contact and their routes, and a row refused after its firm was written left a firm with nobody at it and a receipt saying refused. capture.test.ts refuses a row at its contact after the firm was created, requires the firm gone, and has to go red.',
  },
  {
    name: 'a firm added or imported from the Mac is left unassigned',
    file: 'packages/domain/crm/import.ts',
    find: '      const owner = row.firm.ownerUserId ?? actorUserId(context);\n',
    replace: '      const owner = row.firm.ownerUserId;\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/capture.test.ts'],
    because:
      'Audit item G02: dialing requires the firm to be assigned to the caller (dial/authorize.ts step 4, even for an admin), so an unassigned captured firm could never be called by anyone. capture.test.ts requires the importing admin and the adding salesperson as the assignee and has to go red.',
  },
  {
    name: 'a person confirms a number that changed since the page showed it',
    file: 'packages/domain/crm/routes.ts',
    find: "  if (Number(loaded.version) !== input.routeVersion) return refuse('route_version_stale');\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/routeConfirm.test.ts'],
    because:
      'Lane g88: “Confirm this number” vouches for the number on screen. Without the version check a number replaced since the page was drawn would be made callable on the strength of a confirmation of a different one. routeConfirm.test.ts requires route_version_stale for version 3 of a version-1 route and has to go red.',
  },
  // Lane g90: email technical validation (release-records.md 8.0aw).
  {
    name: 'an address added unchecked is never enqueued for its check',
    file: 'packages/domain/crm/routes.ts',
    find: "  if (kind === 'email' && created.eligibility === 'candidate' && created.technical_validation === 'unknown') {\n",
    replace: '  if (false) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/routeValidation.test.ts'],
    because:
      'This is the gap lanes g84 and g88 found: an address from Add firm or Import was unknown and candidate for ever, and once sending opens every email step to it holds as route_candidate. routeValidation.test.ts requires the route-validate:{route}:1:new job with its payload in the same command; without the enqueue there is no job and the suite has to go red.',
  },
  {
    name: 'a provider address with no confidence is vouched for as if a member had typed it',
    file: 'packages/domain/crm/routeValidation.ts',
    find: '  return MEMBER_ENTERED_SOURCES.includes(source) ? MEMBER_VOUCHED_CONFIDENCE : null;\n',
    replace: '  return MEMBER_VOUCHED_CONFIDENCE;\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/routeValidation.test.ts'],
    because:
      'A passed check says mail reaches the domain, not that the address is this person’s. Only what a member entered themselves (salesperson, import) records the vouched confidence of 1; routeValidation.test.ts requires a research_provider address with none to stay a candidate with a null confidence after it passes, and vouching for everything makes it usable, so the suite has to go red.',
  },
  {
    name: 'a DNS timeout is read as a domain that does not exist',
    file: 'packages/domain/crm/routeValidation.ts',
    find: '  return deferredFor(mx.code);\n',
    replace: "  return { verdict: 'failed', reason: 'domain_not_found' };\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/routeValidate.test.ts'],
    because:
      'An invalid route is final for its association, so a resolver’s bad minute must leave an address unknown for the sweep, never invalid. routeValidate.test.ts times the MX lookup out and requires the route unknown at version 1, then usable after the sweep asks again; reading the timeout as NXDOMAIN makes it invalid and the suite has to go red.',
  },
  {
    name: 'a retired twin counts as a known-bad address',
    file: 'packages/domain/crm/routeValidation.ts',
    find: "      WHERE workspace_id = $1 AND address = $2 AND id <> $3 AND technical_validation = 'failed'\n",
    replace: "      WHERE workspace_id = $1 AND address = $2 AND id <> $3 AND (technical_validation = 'failed' OR eligibility = 'retired')\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/crm/routeValidation.test.ts'],
    because:
      'A retirement is an association fact (9.1’s wrong number), not a deliverability one: an address moved from Dana’s route to the firm’s is retired where it was. routeValidation.test.ts retires it and requires the firm-level twin to end usable; counting the retirement as a failure makes the twin invalid for ever, and the suite has to go red.',
  },
  {
    name: 'the sweep forgets which routes it already asked about this round',
    file: 'packages/domain/crm/routeValidation.ts',
    find: "                 AND (j.idempotency_key = 'route-validate:' || a.id::text || ':' || a.version::text || ':' || due.round\n",
    replace: '                 AND (false\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/routeValidate.test.ts'],
    because:
      'The sweep is bounded per pass, so it must spend the bound on routes it has not asked about yet. routeValidate.test.ts makes five more unchecked routes than one pass takes and requires the second pass to enqueue exactly those five; a sweep that re-selects the first twenty every pass inserts nothing the second time and the rest starve, so the suite has to go red.',
  },
];
