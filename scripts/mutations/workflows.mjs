// Release mutations that edit the GitHub workflows (`.github/workflows/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the rehearsal stops filling one of the six application entries',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '              session-signing-key|device-credential-pepper)\n',
    replace: '              session-signing-key)\n',
    suite: ['run', 'test:release'],
    because:
      'An ECS task whose secrets block names an empty entry does not start (run 35891175510, 23 September 2026, at fss verify). The step must know every name on the stack\u2019s list; an unknown one is a failure, and this mutation turns a known one into that failure path only if the test reads the arms.',
  },
  {
    name: 'the rehearsal registry apply stops running in the rehearsal environment',
    file: '.github/workflows/greenfield-rehearsal-registry.yml',
    kind: 'wiring',
    find: '    environment: rehearsal\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'fss-rh-deploy trusts only the OIDC subject repo:…:environment:rehearsal, so a job without the environment cannot assume it — and would fail at the role step rather than at review. The scenario 39 check has to notice the declaration leaving.',
  },
  {
    name: 'the rehearsal apply goes back to assuming the role it already holds',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '            -var="assume_deployment_role=false" \\\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'Without the flag the provider asks STS to assume fss-rh-deploy from a session that already is fss-rh-deploy, which needs the role to trust itself and is refused at provider configuration. The failure would only ever be seen inside a credentialed run, so the offline check is the only place it can be caught.',
  },
  {
    name: 'the rehearsal apply stops naming a variable the root requires',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '            -var="api_schema_range={min=${API_SCHEMA_MIN},max=${API_SCHEMA_MAX}}" \\\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'The second credentialed run initialised the backend and was refused at the apply because the workflow named six of the eight variables the rehearsal root requires. Scenario 22 now derives the list from variables.tf and reads the workflow for each; drop one line and it has to go red, or the next required variable a lane adds will be found the same way, in the cloud.',
  },
  {
    name: 'any stage can write a release record',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: "      - name: Write the release record, last\n        if: inputs.stage == 'full'\n",
    replace: '      - name: Write the release record, last\n',
    suite: ['run', 'test:release'],
    because:
      'The `plan`, `create` and `deploy` stages exist so that a plan-time error costs a minute instead of an hour, and none of them proves what 16.2 asks of a release. The one thing they must be unable to produce is the artifact an admin points at when enabling sending, and the whole of that impossibility is this `if:`. Appendix G 42 has to go red when it goes.',
  },
  {
    name: 'a plan run applies what it planned',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: "      - name: Create the rehearsal environment\n        if: contains(fromJSON('[\"create\",\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: '      - name: Create the rehearsal environment\n',
    suite: ['run', 'test:release'],
    because:
      'A `plan` stage that applied would be the opposite of the thing it was added for: the cheap, repeatable, creates-nothing run that David uses to find the next plan-time error. The condition is one line, its absence is invisible until a run creates an environment nobody asked for, and the monotonicity check is the only reader of it.',
  },
  {
    name: 'the plan summary guard stops looking for the values it holds',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '                  if len(text) >= 8 and text in summary:\n',
    replace: '                  if False:\n',
    suite: ['run', 'test:release'],
    because:
      'The plan summary goes to the job summary and to a ninety-day artifact, and `terraform show -json` carries every value the plan resolved — the two image references, the certificate ARN and the hostname, all assembled from repository secrets. The summariser prints addresses, and this guard is the second lock on the same door; scenario 39 runs it against a summary that leaks one and must go red when it stops refusing.',
  },
  {
    name: 'a teardown run also creates the environment',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: "        if: contains(fromJSON('[\"create\",\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: "        if: contains(fromJSON('[\"create\",\"deploy\",\"full\",\"teardown\"]'), inputs.stage)\n",
    suite: ['run', 'test:release'],
    because:
      'The `teardown` stage exists to remove the environment the fourth credentialed run left standing (fss-rh-202609211659), with `run_suffix` naming a prefix that already exists. A teardown that also applied would create a second environment under the orphan\'s own name and then destroy whichever of the two Terraform could see, which is the expensive mistake the stage was added to avoid. Appendix G 42 asserts that no step of a teardown run plans, applies, deploys, drills or records.',
  },
  {
    name: 'a deploy stage stops bootstrapping the first workspace',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find:
      "      - name: Bootstrap the rehearsal workspace and its admin\n        if: contains(fromJSON('[\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: "      - name: Bootstrap the rehearsal workspace and its admin\n        if: inputs.stage == 'teardown'\n",
    suite: ['run', 'test:release'],
    because:
      'Run 35919040315 (23 September 2026) passed create, fill, the deploy path and the schema-range refusals and then failed the smoke: no CanaryCompletionAgeSeconds datapoint in ten minutes, because the canary source is per workspace and a fresh database has none. A deploy that skips this step reproduces that failure exactly, and the step\u2019s stage condition is the whole of the difference.',
  },
  {
    name: 'the rehearsal smoke reads the canary age from the bare FSS namespace again',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '            age="$(aws cloudwatch get-metric-statistics --namespace "$namespace" \\\n',
    replace: '            age="$(aws cloudwatch get-metric-statistics --namespace FSS \\\n',
    suite: ['run', 'test:release', '--', 'test/release/metricNamespace.check.ts'],
    because:
      'This is the tenth full rehearsal exactly (run 35943001092, 23 September 2026): the smoke failed in two seconds on a canary age of 837.9 s that was production\u2019s, because every environment in the account published into the bare FSS namespace and the smoke read it. The step still reads the run\u2019s namespace from the root output and still checks it, so a check that only looked for the output would stay green; metricNamespace.check.ts reads the query itself and has to go red.',
  },
  {
    name: 'the pull-request gate runs the release mutation check again',
    file: '.github/workflows/greenfield.yml',
    kind: 'wiring',
    find: '        run: npm run gate:greenfield\n',
    replace: '        run: npm run gate:greenfield && npm run test:release:mutation\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationSchedule.check.ts'],
    because:
      'David moved this check off the pull-request path on 25 September 2026 (lane g62): it was about sixteen minutes of every pull request at 102 mutations, and it now runs nightly on main. Chaining it onto the gate step is the shortest way back, and a reader that found no steps would call the job clean. mutationSchedule.check.ts reads the gate step itself and every step\u2019s script, so it has to go red.',
  },
  {
    name: 'the nightly mutation check is allowed to fail quietly',
    file: '.github/workflows/greenfield-nightly.yml',
    kind: 'wiring',
    find: '      - name: Release mutation check\n',
    replace: '      - name: Release mutation check\n        continue-on-error: true\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationSchedule.check.ts'],
    because:
      'Off the pull-request path the check blocks nothing, so a failure is only worth what it tells somebody. With continue-on-error the step goes red, the job goes green, and nobody is told that a trap stopped closing. mutationSchedule.check.ts refuses continue-on-error anywhere in the nightly, so it has to go red.',
  },
  {
    name: 'the weekly caller stamps the images’ commit instead of its own',
    file: '.github/workflows/greenfield-weekly-rehearsal.yml',
    kind: 'wiring',
    find: '      desktop_commit_stamp: ${{ github.sha }}\n',
    replace: '      desktop_commit_stamp: ${{ needs.pin.outputs.images_commit }}\n',
    suite: ['run', 'test:release', '--', 'test/release/weeklyRehearsal.check.ts'],
    because:
      'The desktop commit stamp is a fact about the commit being released (g13b), and the weekly run pins all three artifacts to the commit it runs at. The images’ commit is often older — a documentation commit on top of the last image change — so a stamp taken from it names a desktop build of code the suite did not run. weeklyRehearsal.check.ts requires the stamp and the pin to be github.sha and has to go red.',
  },
  {
    name: 'a pinned rehearsal stops refusing a checkout that is not its pin',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: '            if [ "$GITHUB_SHA" != "$pinned" ]; then\n',
    replace: '            if false; then\n',
    suite: ['run', 'test:release', '--', 'test/release/weeklyRehearsal.check.ts'],
    because:
      'A called workflow runs from its caller’s commit, so today the pin and the checkout agree by construction; the refusal is what keeps that true when somebody later dispatches or calls the release workflow with a pin some other way. weeklyRehearsal.check.ts extracts the digest step, runs it with GITHUB_SHA different from pinned_commit, and has to go red.',
  },
  {
    name: 'the images workflow stops publishing when only the certificate bundle changed',
    file: '.github/workflows/greenfield-images.yml',
    kind: 'wiring',
    find: "      - 'certs/**'\n      - 'package.json'\n      - 'package-lock.json'\n      - '.github/workflows/greenfield-images.yml'\n\npermissions:\n",
    replace: "      - 'package.json'\n      - 'package-lock.json'\n      - '.github/workflows/greenfield-images.yml'\n\npermissions:\n",
    suite: ['run', 'test:release', '--', 'test/release/weeklyRehearsal.check.ts'],
    because:
      'Both images COPY certs/rds-global-bundle.pem, and before lane g74 the push paths missed it: a bundle refresh built nothing, and the next release rebuilt it by hand. Now a missing path is a main commit whose images nobody publishes and the weekly pin refuses. weeklyRehearsal.check.ts compares push.paths with release-images.sh inputs and has to go red.',
  },
  {
    name: 'the release manifest is written by a stage that is not full',
    file: '.github/workflows/greenfield-release.yml',
    kind: 'wiring',
    find: "      - name: Write the release manifest beside the record\n        if: inputs.stage == 'full'\n",
    replace: '      - name: Write the release manifest beside the record\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'Only full is the release gate (G12k), and the manifest is what the operator promotes and deploys from and what the freshness check counts as a passed rehearsal. A plan, create or deploy run that wrote one would be a rehearsal that proved nothing, filed as one that passed. releaseManifest.check.ts reads the step’s condition as a set of stages, requires exactly {full}, and has to go red.',
  },
];
