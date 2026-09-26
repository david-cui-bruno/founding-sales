// Release mutations that edit the wire contracts (`packages/contracts/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  // Lane g69: the sending section parses the API's recipients object, a renewal applies
  // the role the server gives, and Home says Attest when a number is saved.
  {
    name: 'the Administration window parses the personal-Gmail recipients as a number again',
    file: 'packages/contracts/src/outbound.ts',
    find: '  personalGmailRecipients: personalGmailRecipientsSchema,\n',
    replace: '  personalGmailRecipients: z.number(),\n',
    suite: ['run', 'test:release', '--', 'test/release/sendingSection.check.ts'],
    because:
      'This is desktop 1.0.2 and 1.0.3 in production: POST /outbound/status has always answered the recipients as { automated, direct, total }, a z.number() parser refused every answer as unreadable_answer, and the sending section never rendered, with nothing logged because the API had answered 200. The unit fixture carried the same wrong number, so only a check that feeds the real route’s answer to the real parser can see it. sendingSection.check.ts does, and has to go red.',
  },
  {
    name: 'the sequence step schema forbids sequenceVersionId again',
    file: 'packages/contracts/src/sequences.ts',
    find: 'export const currentSequenceStepDtoSchema = z.object({\n  id: uuid,\n  /** On every step, because the step table is keyed by it. D01 was a Mac that forbade it. */\n  sequenceVersionId: uuid,\n',
    replace: 'export const currentSequenceStepDtoSchema = z.strictObject({\n  id: uuid,\n',
    suite: ['run', 'test:release', '--', 'test/release/sequences.check.ts'],
    because:
      'This is desktop 1.0.4’s step schema: strict, and without the key toStep puts on every step, so every populated version was unreadable_answer and the editor drew a sequence with no versions (D01). The unit fixture agreed with it, so only the real route’s answer through the real bridge could see it. sequences.check.ts renders a published two-step version from the route and has to go red.',
  },
  {
    name: 'the enrollment schema drops one of the fields the route sends',
    file: 'packages/contracts/src/sequences.ts',
    find: '  opportunityId: uuid,\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/sequences.check.ts'],
    because:
      'Desktop 1.0.4 knew nine of the thirteen enrollment fields and refused every populated list (D02). With the contract stripping rather than refusing, a dropped field no longer fails the Mac’s parse at all — it silently disappears, which is the drift wireDrift exists to name. sequences.check.ts holds the route’s answer to the contract and reads the held enrollment’s opportunity, and has to go red.',
  },
  {
    name: 'the ceiling admits a build the policy lists as incompatible',
    file: 'packages/contracts/src/clientVersion.ts',
    find: "  if ('incompatible' in gate && gate.incompatible.includes(version)) {\n",
    replace: '  if (false) {\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/clientVersionCeiling.test.ts'],
    because:
      'Once the API admits a whole 1.x line (O04), the incompatible list is the only way to keep a known-bad build out, and it is never published — a 1.0.x Mac could not parse it — so nothing but the API enforces it. A policy that lists a version and still admits it passes every admits-a-build test. clientVersionCeiling.test.ts signs in, renews and commands as a listed build through the real dispatcher and has to go red.',
  },
  {
    name: 'the calling clock resolves a DST gap backwards again',
    file: 'packages/contracts/src/localClock.ts',
    find: '    result = Math.max(first, second);\n',
    replace: '    result = Math.min(first, second);\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/dial.test.ts'],
    because:
      'Audit item C18: the Mac’s own converter put New York’s 02:30 on 8 March 2026 at 01:30 EST, an hour before the wall clock the person confirmed, where docs/decisions/g0-dst-gap-resolution.md resolves a gap forward to 03:30 EDT. Lane g79 made the Mac and the server share one implementation in @fss/contracts; dial.test.ts expects the outcome form to resolve that gap to 2026-03-08T07:30:00.000Z, and with the gap resolved to the earlier candidate it reads 06:30 and has to go red.',
  },
  {
    name: 'an email address can be confirmed by hand',
    file: 'packages/contracts/src/crm.ts',
    find: "  routeKind: z.literal('phone'),\n",
    replace: '  routeKind: routeKindSchema,\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/founderGaps.test.ts'],
    because:
      'Lane g88: 7.4 makes an address usable only after a technical validation a person cannot supply, so /contacts/routes/confirm takes phone numbers only and refuses anything else at the door. founderGaps.test.ts (apps/api) requires a 400 for routeKind email and has to go red.',
  },
];
