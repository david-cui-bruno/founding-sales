/**
 * Re-record the reply corpus against the live model.
 *
 * This is the one thing in the repository that reaches Anthropic, and it is a
 * developer tool a person runs deliberately. **It costs money.** CI never runs it,
 * no test imports it, and it refuses to start without both an API key and an
 * explicit `--model`, because a default model here would mean re-recording against
 * whichever one somebody last edited a constant to.
 *
 *   FSS_LLM_CLASSIFIER_API_KEY=… \
 *     node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *       packages/domain/scripts/recordReplyCorpus.mjs --model claude-opus-5
 *
 * Add `--dry-run` to print the request the first case would send and stop. That
 * costs nothing and is the right way to look at a prompt change before paying for
 * the rest.
 *
 * What it writes is `test/corpus/replies/recorded.json`: the raw answer text per
 * case id, plus the prompt version and the model, which `corpus.test.ts` pins
 * against `CLASSIFIER_PROMPT_VERSION`. Three cases are *not* re-recorded and never
 * can be — `malformed-output`, `refused-answer` and `provider-error` are fixtures of
 * failure modes rather than of the model's opinion, and asking the model to produce
 * them would be asking it to misbehave on demand. Their recorded entries are kept as
 * they are and the script says so.
 *
 * The key is read from the environment and handed to the SDK client. It is never
 * printed, never written to the file, and never in an error message.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const CORPUS_URL = new URL('../test/corpus/replies/recorded.json', import.meta.url);

/**
 * Cases whose recorded answer is a failure mode rather than an opinion.
 *
 * Re-recording these would destroy them: a live model asked the `fabricated-excerpt`
 * case would quote the message correctly, and the fixture for "a model that invents a
 * quotation" would silently become a fixture for "a model that does not". The other
 * four cannot be produced on demand at all without asking a model to misbehave.
 */
const NEVER_RECORDED = new Set([
  'malformed-output',
  'schema-invalid-output',
  'refused-answer',
  'fabricated-excerpt',
  'provider-error',
]);

function usage(message) {
  console.error(`${message}

  FSS_LLM_CLASSIFIER_API_KEY=… \\
    node --experimental-transform-types --disable-warning=ExperimentalWarning \\
      packages/domain/scripts/recordReplyCorpus.mjs --model <claude-opus-5|claude-haiku-4-5> [--dry-run]
`);
  return 2;
}

/**
 * `packages/domain` uses constructor parameter properties, which Node's default
 * type stripping refuses, so the transform flag is required. Re-exec once with it
 * rather than failing with a syntax error from a file the caller did not name.
 */
function ensureTransform() {
  if (process.execArgv.some(argument => argument.includes('experimental-transform-types'))) return null;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      new URL(import.meta.url).pathname,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

async function main() {
  const reexec = ensureTransform();
  if (reexec !== null) return reexec;

  const argv = process.argv.slice(2);
  const modelIndex = argv.indexOf('--model');
  const model = modelIndex === -1 ? undefined : argv[modelIndex + 1];
  const dryRun = argv.includes('--dry-run');

  const { CLASSIFIER_MODELS, CLASSIFIER_PROMPT_VERSION, buildClassifierRequest, loadAnthropicTransport,
    environmentClassifierSecrets } = await import('../classification/index.ts');
  const { REPLY_CORPUS } = await import('../test/corpus/replies/cases.ts');
  const { authoredText } = await import('../src/rules/replyClassification.ts');

  if (model === undefined || !CLASSIFIER_MODELS.includes(model)) {
    return usage(`--model must be one of ${CLASSIFIER_MODELS.join(', ')}.`);
  }
  const secrets = environmentClassifierSecrets(process.env);
  if (!dryRun && secrets.names().length === 0) {
    return usage('FSS_LLM_CLASSIFIER_API_KEY is not set. Nothing was sent.');
  }

  const existing = JSON.parse(readFileSync(CORPUS_URL, 'utf8'));
  const cases = REPLY_CORPUS.filter(
    corpusCase => corpusCase.expectedOutcome !== 'not_applicable' && !NEVER_RECORDED.has(corpusCase.id),
  );

  const requestFor = corpusCase =>
    buildClassifierRequest({
      model,
      effort: 'low',
      maxOutputTokens: 512,
      message: {
        subject: corpusCase.subject,
        from: corpusCase.from,
        bodyText: authoredText(corpusCase.body),
        truncated: corpusCase.truncated === true,
        deterministicSignals: [],
      },
    });

  if (dryRun) {
    console.error(JSON.stringify(requestFor(cases[0]), null, 2));
    console.error(`\n${String(cases.length)} cases would be sent. Nothing was.`);
    return 0;
  }

  const transport = await loadAnthropicTransport({ secrets });
  const answers = { ...existing.answers };
  for (const corpusCase of cases) {
    const response = await transport.create(requestFor(corpusCase));
    const text = (response.content ?? []).find(block => block.type === 'text')?.text;
    answers[corpusCase.id] = {
      ...(text === undefined ? {} : { text }),
      ...(response.stop_reason === 'refusal' ? { stopReason: 'refusal' } : {}),
      outputTokens: response.usage?.output_tokens ?? 0,
    };
    console.error(
      `${corpusCase.id}: stop_reason=${String(response.stop_reason)} cached=${String(
        response.usage?.cache_read_input_tokens ?? 0,
      )}`,
    );
  }

  writeFileSync(
    CORPUS_URL,
    `${JSON.stringify(
      {
        ...existing,
        recordedAt: new Date().toISOString().slice(0, 10),
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        model,
        answers,
      },
      null,
      2,
    )}\n`,
  );
  console.error(
    `\nWrote ${String(cases.length)} answers. ${[...NEVER_RECORDED].join(', ')} were left alone: they are failure-mode fixtures, not opinions.`,
  );
  return 0;
}

process.exitCode = await main();
