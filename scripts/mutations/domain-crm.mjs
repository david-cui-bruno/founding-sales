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
];
