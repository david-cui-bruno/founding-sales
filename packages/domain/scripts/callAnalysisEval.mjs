/**
 * The post-call analysis evaluation (slice 3a, checks C1 and C2), against the live model.
 *
 * **It costs money** (Claude Haiku 4.5 on Amazon Bedrock, from credits) and is never run in
 * CI. A person runs it deliberately with AWS credentials that may call Bedrock in the
 * default chain; nothing here reads or prints a credential.
 *
 *   AWS_REGION=us-east-1 \
 *     node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *       packages/domain/scripts/callAnalysisEval.mjs --model claude-haiku-4-5-20251001 [--case 3] [--runs 3] [--max-cents 340] [--dry-run]
 *
 * For each case of `test/corpus/calls/cases.json` (or only `--case n`, repeatable) and each
 * run it builds the request with `buildCallAnalysisRequest`, checks the exact request's
 * schema with the structured-outputs walker (and refuses to send one that fails), sends it,
 * records the answer under `test/corpus/calls/answers/call_analysis.1/<case>.run<k>.json`,
 * reads it with `readCallAnalysisAnswer`, proposes with `proposeEffects`, and scores the
 * labels (`test/corpus/calls/evaluate.ts`).
 *
 * The pass rule: zero forbidden effects in any run of any case, and at least 90% agreement
 * on content that triggers no action. Case 2 (a bare pricing question) counts: David decided
 * product question Q3 on 2 October 2026, so a buying signal there is forbidden.
 *
 * `--dry-run` prints the first selected case's request and its walker result and sends
 * nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const CASES_URL = new URL('../test/corpus/calls/cases.json', import.meta.url);

function usage(message) {
  console.error(`${message}

  AWS_REGION=us-east-1 \\
    node --experimental-transform-types --disable-warning=ExperimentalWarning \\
      packages/domain/scripts/callAnalysisEval.mjs --model claude-haiku-4-5-20251001 [--case n]... [--runs 3] [--max-cents 340] [--dry-run]
`);
  return 2;
}

function ensureTransform() {
  if (process.execArgv.some(argument => argument.includes('experimental-transform-types'))) return null;
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', new URL(import.meta.url).pathname, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

function valuesOf(argv, flag) {
  const out = [];
  argv.forEach((argument, index) => {
    if (argument === flag && argv[index + 1] !== undefined) out.push(argv[index + 1]);
  });
  return out;
}

async function main() {
  const reexec = ensureTransform();
  if (reexec !== null) return reexec;

  const argv = process.argv.slice(2);
  const model = valuesOf(argv, '--model')[0];
  const dryRun = argv.includes('--dry-run');
  const runs = Number(valuesOf(argv, '--runs')[0] ?? '3');
  const maxCents = Number(valuesOf(argv, '--max-cents')[0] ?? '340');
  const only = new Set(valuesOf(argv, '--case').map(Number));

  const { CALL_ANALYSIS_MODELS, CALL_ANALYSIS_MODEL_TABLE, CALL_ANALYSIS_PROMPT_VERSION, buildCallAnalysisRequest, callAnalysisCeilingCents, callAnalysisCents, callAnalysisInputTokenBound } =
    await import('../calls/analysisModel.ts');
  const { schemaProblems } = await import('../test/support/structuredOutputsSchema.ts');
  const { scoreAnswer } = await import('../test/corpus/calls/evaluate.ts');

  if (model === undefined || !CALL_ANALYSIS_MODELS.includes(model)) return usage(`--model must be one of ${CALL_ANALYSIS_MODELS.join(', ')}.`);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) return usage('--runs is 1 to 5.');
  if (!Number.isFinite(maxCents) || maxCents <= 0 || maxCents > 500) return usage('--max-cents is above 0 and at most 500.');

  const corpus = JSON.parse(readFileSync(CASES_URL, 'utf8'));
  const cases = corpus.cases.filter(corpusCase => only.size === 0 || only.has(corpusCase.n));
  if (cases.length === 0) return usage('No case selected.');

  const maxOutputTokens = CALL_ANALYSIS_MODEL_TABLE[model].maxOutputTokens;
  const requestFor = corpusCase =>
    buildCallAnalysisRequest({
      model,
      maxOutputTokens,
      call: {
        firmName: corpusCase.firmName,
        contactName: corpusCase.contactName,
        callLocalTime: corpusCase.callLocalTime,
        utterances: corpusCase.utterances,
      },
    });

  for (const corpusCase of cases) {
    const problems = schemaProblems(requestFor(corpusCase).output_config.format.schema);
    if (problems.length > 0) {
      console.error(`The request schema fails the structured-outputs walker; nothing was sent:\n${problems.join('\n')}`);
      return 1;
    }
  }

  if (dryRun) {
    const request = requestFor(cases[0]);
    console.error(JSON.stringify(request, null, 2));
    console.error(`\nwalker: [] ; input bound ${String(callAnalysisInputTokenBound(request))} tokens ; ceiling ${String(callAnalysisCeilingCents(model, callAnalysisInputTokenBound(request), maxOutputTokens, 'bedrock'))} cents`);
    console.error(`${String(cases.length * runs)} requests would be sent. None was.`);
    return 0;
  }

  const { loadBedrockTransport } = await import('../classification/bedrockClient.ts');
  const transport = await loadBedrockTransport({ region: process.env.AWS_REGION ?? 'us-east-1', timeoutMilliseconds: 120_000 });

  const answersUrl = new URL(`../test/corpus/calls/answers/${CALL_ANALYSIS_PROMPT_VERSION}/`, import.meta.url);
  mkdirSync(answersUrl, { recursive: true });

  let spentCents = 0;
  let spentExact = 0;
  let forbiddenRuns = 0;
  let readFailures = 0;
  let agreed = 0;
  let compared = 0;
  const lines = [];
  for (const corpusCase of cases) {
    for (let run = 1; run <= runs; run += 1) {
      const request = requestFor(corpusCase);
      const ceiling = callAnalysisCeilingCents(model, callAnalysisInputTokenBound(request), maxOutputTokens, 'bedrock');
      if (spentCents + ceiling > maxCents) {
        console.error(`Stopping before ${corpusCase.id} run ${String(run)}: its ceiling would pass --max-cents ${String(maxCents)}.`);
        return finish();
      }
      let response;
      try {
        response = await transport.create(request);
      } catch (error) {
        console.error(`${corpusCase.id} run ${String(run)}: provider error status=${String(error?.status ?? null)} type=${String(error?.type ?? null)}`);
        spentCents += ceiling;
        readFailures += 1;
        continue;
      }
      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens: (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage?.output_tokens ?? 0,
      };
      spentCents += callAnalysisCents(model, usage, 'bedrock');
      // Bedrock's Haiku 4.5 rates are 110 and 550 cents per million tokens; /100 for dollars.
      spentExact += (usage.inputTokens * 110 + usage.outputTokens * 550) / 1_000_000 / 100;
      const text = (response.content ?? []).find(block => block.type === 'text')?.text;
      writeFileSync(
        new URL(`${corpusCase.id}.run${String(run)}.json`, answersUrl),
        `${JSON.stringify({ promptVersion: CALL_ANALYSIS_PROMPT_VERSION, model, transport: 'bedrock', recordedAt: new Date().toISOString().slice(0, 10), stopReason: response.stop_reason ?? null, usage, text: text ?? null }, null, 2)}\n`,
      );
      if (text === undefined || response.stop_reason === 'refusal') {
        readFailures += 1;
        lines.push(`${corpusCase.id} run ${String(run)}: no answer (stop_reason=${String(response.stop_reason)})`);
        continue;
      }
      const score = scoreAnswer(corpusCase, text);
      if (score.read !== 'ok') {
        readFailures += 1;
        lines.push(`${corpusCase.id} run ${String(run)}: ${score.read}`);
        continue;
      }
      agreed += score.content[0];
      compared += score.content[1];
      for (const verdict of score.verdicts) {
        if (verdict.forbidden.length > 0) forbiddenRuns += 1;
        lines.push(
          `${corpusCase.id} run ${String(run)} [${verdict.variant}]: labels=${verdict.labels.join(',') || '-'}` +
            (verdict.forbidden.length > 0 ? ` FORBIDDEN=${verdict.forbidden.join(',')}` : '') +
            (verdict.missing.length > 0 ? ` missing=${verdict.missing.join(',')}` : ''),
        );
      }
    }
  }
  return finish();

  function finish() {
    for (const line of lines) console.log(line);
    const share = compared === 0 ? 0 : agreed / compared;
    console.log(`\nforbidden-effect runs: ${String(forbiddenRuns)} ; unreadable answers: ${String(readFailures)} ; content agreement ${String(agreed)}/${String(compared)} = ${(share * 100).toFixed(1)}% ; spent ${String(spentCents)} cents rounded up per request (about $${spentExact.toFixed(4)} at Bedrock rates)`);
    console.log(forbiddenRuns === 0 && readFailures === 0 && share >= 0.9 ? 'PASS' : 'FAIL');
    return forbiddenRuns === 0 && readFailures === 0 && share >= 0.9 ? 0 : 1;
  }
}

process.exitCode = await main();
