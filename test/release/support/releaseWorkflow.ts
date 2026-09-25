import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The credentialed rehearsal job, read as steps and stages.
 *
 * G12k gave `.github/workflows/greenfield-release.yml` a `stage` input — `plan`,
 * `create`, `deploy`, `full` — so that a real plan, a real create and a real deploy
 * can each be run alone. Three credentialed rehearsals had each stopped at the first
 * error of a class no offline check can see, and the workflow had one mode: the whole
 * thirteen-step gate, about an hour of David's attention for one error.
 *
 * The stages are only worth having if they nest: everything `plan` runs, `create`
 * runs too, and so on up to `full`. That is a property of the `if:` conditions, and
 * this module is what lets a test read them rather than a person.
 *
 * ## The fifth stage is not a fifth rung
 *
 * G16 added `teardown`, which is a dispatch choice and **not** a member of the nesting
 * ladder: it plans nothing, applies nothing and writes no record, and runs only the
 * steps before the plan plus the two that always run. So there are two lists.
 * `REHEARSAL_STAGES` is the ladder, and every monotonicity statement is about it;
 * `REHEARSAL_STAGE_CHOICES` is what `workflow_dispatch` offers, and `stagesForCondition`
 * returns sets over that. A check that iterates the ladder where it meant the choices
 * would silently stop asking about `teardown`, so both are exported and both are used.
 *
 * ## And two modes on the top rung (lane g97)
 *
 * `mode` — `schema` (the default) or `full` — says what a `full` run is for. A step only
 * the restore drill and the release gate need carries
 * `inputs.stage == 'full' && inputs.mode == 'full'`; every other condition ignores the
 * mode. `modesForCondition` reads that clause, `stagesForCondition` reads the stage half
 * of the same condition, and `stepsForStage` takes the mode as its third argument,
 * defaulting to `full` so that every statement written before g97 is still a statement
 * about the whole gate.
 *
 * ## Why a parser and not a YAML library
 *
 * `js-yaml` and `yaml` are both in `node_modules`, and neither is a declared
 * dependency of anything in this repository — they arrive underneath eslint and vite.
 * A release gate that imports a transitive dependency breaks on the day an unrelated
 * bump drops it. So this reads the file, and the floors below are what keep a reader
 * that silently found nothing from passing: `rehearsalJobSteps` throws when the job,
 * its steps, or a step's name is missing, and the checks assert a minimum count.
 *
 * ## The other vacuous pass
 *
 * A condition this module cannot read would otherwise be treated as "runs in every
 * stage", which is the permissive answer and the wrong one — a release-record step
 * whose condition had been rewritten into a shape unknown here would read as running
 * in `plan`, and the monotonicity check would go red for the wrong reason or, worse,
 * a narrowing rewrite would read as widening. `stagesForCondition` therefore refuses
 * anything outside the two grammars the workflow uses.
 */

const WORKFLOW_PATH = fileURLToPath(new URL('../../../.github/workflows/greenfield-release.yml', import.meta.url));

/** The stages, in the order in which each contains the one before it. */
export const REHEARSAL_STAGES = ['plan', 'create', 'deploy', 'full'] as const;

/**
 * Every value `workflow_dispatch` offers, in the order the input lists them.
 *
 * `teardown` is last and is outside the ladder above: it removes an environment some
 * earlier run created and left, so "everything the stage before it runs" is not a
 * property it has or should have.
 */
export const REHEARSAL_STAGE_CHOICES = [...REHEARSAL_STAGES, 'teardown'] as const;

export type RehearsalStage = (typeof REHEARSAL_STAGE_CHOICES)[number];

/** The two values of the `mode` input, the default first. */
export const REHEARSAL_MODES = ['schema', 'full'] as const;

export type RehearsalMode = (typeof REHEARSAL_MODES)[number];

/** The one mode clause the workflow uses, appended to a stage condition. */
const MODE_CLAUSE = / && inputs\.mode == '([a-z]+)'$/u;

function isMode(value: string): value is RehearsalMode {
  return (REHEARSAL_MODES as readonly string[]).includes(value);
}

/**
 * The modes a step runs in: both, unless its condition ends in
 * `&& inputs.mode == '<mode>'`. A condition that mentions the mode in any other shape
 * is refused, for the same reason `stagesForCondition` refuses one it cannot read.
 */
export function modesForCondition(condition: string | null): ReadonlySet<RehearsalMode> {
  if (condition === null || !condition.includes('inputs.mode')) return new Set(REHEARSAL_MODES);
  const clause = MODE_CLAUSE.exec(condition.trim());
  const mode = clause?.[1];
  if (mode === undefined || !condition.includes('inputs.stage')) {
    throw new Error(`the release workflow has a mode condition this check cannot read: ${condition.trim()}`);
  }
  if (!isMode(mode)) throw new Error(`\`${condition.trim()}\` names a mode that does not exist`);
  return new Set([mode]);
}

/** The ladder stages a condition admits, in ladder order, ignoring `teardown`. */
export function ladderStagesForCondition(condition: string | null): readonly RehearsalStage[] {
  const admitted = stagesForCondition(condition);
  return REHEARSAL_STAGES.filter(stage => admitted.has(stage));
}

export interface WorkflowStep {
  /** Position in the job, from 0, so that order can be asserted. */
  readonly index: number;
  /** `name:`, or `uses <action>` for the three steps that declare none. */
  readonly name: string;
  /** The step's own `if:`, verbatim, or null when it has none. */
  readonly condition: string | null;
  /** Every line of the step, as it appears in the file. */
  readonly text: string;
}

export function releaseWorkflowText(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function isStage(value: string): value is RehearsalStage {
  return (REHEARSAL_STAGE_CHOICES as readonly string[]).includes(value);
}

function stepFrom(lines: readonly string[], index: number): WorkflowStep {
  const text = lines.join('\n');
  const named = /^ {6}- name: (.+)$|^ {8}name: (.+)$/mu.exec(text);
  const uses = /^ {6}- uses: (\S+)$/mu.exec(text);
  const name = named?.[1] ?? named?.[2] ?? (uses?.[1] === undefined ? undefined : `uses ${uses[1]}`);
  if (name === undefined) {
    throw new Error(`a step of the rehearsal job has neither a name nor a uses:\n${text}`);
  }
  const condition = /^ {8}if: (.+)$/mu.exec(text)?.[1] ?? null;
  return { index, name: name.trim(), condition, text };
}

/** The steps of the credentialed `rehearsal` job, in file order. */
export function rehearsalJobSteps(): readonly WorkflowStep[] {
  const workflow = releaseWorkflowText();
  const jobAt = workflow.indexOf('\n  rehearsal:\n');
  if (jobAt < 0) throw new Error('the release workflow declares no `rehearsal` job');
  const job = workflow.slice(jobAt);
  const marker = '\n    steps:\n';
  const stepsAt = job.indexOf(marker);
  if (stepsAt < 0) throw new Error('the rehearsal job declares no `steps:`');

  const steps: WorkflowStep[] = [];
  let current: string[] | null = null;
  for (const line of job.slice(stepsAt + marker.length).split('\n')) {
    if (line.startsWith('      - ')) {
      if (current !== null) steps.push(stepFrom(current, steps.length));
      current = [line];
      continue;
    }
    if (current === null) continue;
    // A blank line, or anything indented at least as far as a step's own keys. A
    // line indented less than that is the end of the job.
    if (line.trim() === '' || line.startsWith('       ') || line.startsWith('      #')) {
      current.push(line);
      continue;
    }
    break;
  }
  if (current !== null) steps.push(stepFrom(current, steps.length));
  if (steps.length === 0) throw new Error('the rehearsal job was read as having no steps at all');
  return steps;
}

/**
 * The stages a step runs in.
 *
 * Two grammars, and nothing else: `inputs.stage == 'full'` for a step only the gate
 * runs, and `contains(fromJSON('["deploy","full"]'), inputs.stage)` for a step every
 * stage from one onwards runs. A condition that never mentions `inputs.stage` — the
 * teardown step's `always()`, the guard's — runs in all five.
 */
export function stagesForCondition(condition: string | null): ReadonlySet<RehearsalStage> {
  if (condition === null || !condition.includes('inputs.stage')) return new Set(REHEARSAL_STAGE_CHOICES);
  // The mode half is `modesForCondition`'s; what is left is one of the two grammars.
  const trimmed = condition.trim().replace(MODE_CLAUSE, '');

  const equality = /^inputs\.stage == '([a-z]+)'$/u.exec(trimmed);
  if (equality?.[1] !== undefined) {
    const stage = equality[1];
    if (!isStage(stage)) throw new Error(`\`${trimmed}\` names a stage that does not exist`);
    return new Set([stage]);
  }

  const membership = /^contains\(fromJSON\('(\[[^']*\])'\), inputs\.stage\)$/u.exec(trimmed);
  if (membership?.[1] !== undefined) {
    const parsed: unknown = JSON.parse(membership[1]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`\`${trimmed}\` lists no stage at all`);
    }
    const named = new Set<RehearsalStage>();
    for (const entry of parsed as readonly unknown[]) {
      if (typeof entry !== 'string' || !isStage(entry)) {
        throw new Error(`\`${trimmed}\` names a stage that does not exist`);
      }
      named.add(entry);
    }
    return named;
  }

  throw new Error(
    `the release workflow has a stage condition this check cannot read, which would be treated as “every stage”: ${trimmed}`,
  );
}

/** The steps a dispatch of `stage` would run in `mode` (`full` unless said), in order. */
export function stepsForStage(
  stage: RehearsalStage,
  steps?: readonly WorkflowStep[],
  mode: RehearsalMode = 'full',
): readonly WorkflowStep[] {
  return (steps ?? rehearsalJobSteps()).filter(
    step => stagesForCondition(step.condition).has(stage) && modesForCondition(step.condition).has(mode),
  );
}

/**
 * The shell script of a named step, as bash receives it: the YAML block scalar with
 * its block indentation removed, so a heredoc inside it can be extracted and run.
 */
export function stepScript(name: string, steps?: readonly WorkflowStep[]): string {
  const step = (steps ?? rehearsalJobSteps()).find(candidate => candidate.name === name);
  if (step === undefined) throw new Error(`the rehearsal job has no step named ${name}`);
  const lines = step.text.split('\n');
  const runAt = lines.findIndex(line => /^ {8}run: \|$/u.test(line));
  if (runAt < 0) throw new Error(`the step ${name} has no \`run: |\` block`);
  const body = lines.slice(runAt + 1);
  const indent = body.find(line => line.trim() !== '')?.match(/^ */u)?.[0]?.length ?? 0;
  if (indent === 0) throw new Error(`the step ${name} has an empty \`run: |\` block`);
  return body.map(line => (line.length >= indent ? line.slice(indent) : line.trimStart())).join('\n');
}

/**
 * A `python3 - <<'PY' … PY` program embedded in a step, by the sentinel comment on
 * its first line. The workflow is where these programs live, so a test that wants to
 * run one takes it from there rather than keeping a copy that can drift.
 */
export function embeddedPythonProgram(script: string, sentinel: string): string {
  const blocks = script.split("<<'PY'\n").slice(1);
  for (const block of blocks) {
    const end = block.indexOf('\nPY\n');
    const program = end < 0 ? block : block.slice(0, end + 1);
    if (program.includes(sentinel)) return program;
  }
  throw new Error(`no embedded python program carries the sentinel ${sentinel}`);
}
