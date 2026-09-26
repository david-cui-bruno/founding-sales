import { afterEach, describe, expect, it } from 'vitest';
import { readReplyCard } from '../../classification/cards.ts';
import { classifyReplyWithModel } from '../../classification/classify.ts';
import { cacheablePrefix } from '../../classification/recorded.ts';
import { listClassifications } from '../../classification/store.ts';
import { CLASSIFIER_PROMPT_VERSION } from '../../classification/types.ts';
import { DETERMINISTIC_CASES, MODEL_CASES, REPLY_CORPUS } from '../corpus/replies/cases.ts';
import {
  RECORDED_MODEL,
  RECORDED_PROMPT_VERSION,
  createClassifierWorld,
  type ClassifierWorld,
} from './support/classifierWorld.ts';

/**
 * The corpus harness in recorded mode (specification 16.1; the brief's acceptance
 * list).
 *
 * One world, one pass over the corpus, and then the assertions that only make sense
 * across the whole pass: the cache prefix never moved, the deterministic cases cost
 * nothing, and every failure mode ended as `uncertain`.
 */

let world: ClassifierWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

async function classifyEverything(w: ClassifierWorld): Promise<Map<string, string>> {
  const outcomes = new Map<string, string>();
  for (const corpusCase of REPLY_CORPUS) {
    const report = await classifyReplyWithModel(w.systemContext(), w.deps, {
      messageId: w.messageIdOf(corpusCase.id),
    });
    outcomes.set(corpusCase.id, report.outcome);
  }
  return outcomes;
}

describe('the labelled reply corpus, in recorded mode', () => {
  it('is pinned to the prompt and model versions it was recorded against', () => {
    // A corpus recorded under a different prompt is a corpus about a different
    // question. Bumping `CLASSIFIER_PROMPT_VERSION` without re-recording fails here.
    expect(RECORDED_PROMPT_VERSION).toBe(CLASSIFIER_PROMPT_VERSION);
    expect(RECORDED_MODEL).toBe('claude-opus-5');
  });

  it('gives every case the class and disposition its label expects', async () => {
    world = await createClassifierWorld();
    const w = world;
    const outcomes = await classifyEverything(w);

    for (const corpusCase of REPLY_CORPUS) {
      const messageId = w.messageIdOf(corpusCase.id);
      expect(outcomes.get(corpusCase.id), corpusCase.id).toBe(corpusCase.expectedOutcome);

      const rows = await listClassifications(w.systemContext(), messageId);
      const deterministic = rows.find(row => row.layer === 'deterministic');
      expect(deterministic?.class, `${corpusCase.id} deterministic`).toBe(corpusCase.expectedDeterministicClass);

      const card = await readReplyCard(w.context(), { messageId });
      expect(card, corpusCase.id).not.toBeNull();
      expect(card?.deterministicClass, `${corpusCase.id} card class`).toBe(corpusCase.expectedClass);
      expect(card?.proposedDisposition, `${corpusCase.id} disposition`).toBe(corpusCase.expectedDisposition);
      if (corpusCase.expectsCallbackProposal === true) {
        expect(card?.callbackProposal?.localDateTime, corpusCase.id).toContain('14th of January');
      }
    }
  });

  it('spends nothing on a message the deterministic layer already decided', async () => {
    world = await createClassifierWorld();
    const w = world;
    await classifyEverything(w);

    // Every request the transport saw is one of the model cases. The deterministic
    // ones never reach it, which is the cheapest half of the cost story.
    expect(w.transport.calls.length).toBe(MODEL_CASES.length);

    const { rows } = await w.mail.database.session.query<{ outcome: string; total: string }>(
      `SELECT outcome, count(*)::text AS total
         FROM mail_classification_calls
        WHERE workspace_id = $1 AND NOT request_sent
        GROUP BY outcome`,
      [w.mail.seeded.alpha.workspaceId],
    );
    const notApplicable = rows.find(row => row.outcome === 'not_applicable');
    expect(Number(notApplicable?.total ?? '0')).toBe(DETERMINISTIC_CASES.length);
  });

  it('proves the cache hit: one prefix across the whole corpus, and reads after the first', async () => {
    world = await createClassifierWorld();
    const w = world;
    await classifyEverything(w);

    // The prefix — model, `output_config` and the frozen system block — is identical
    // for every request, so the provider's prefix match holds across the run. One
    // changed byte anywhere in it and this is two.
    expect(w.transport.prefixCount()).toBe(1);
    const prefixes = new Set(w.transport.calls.map(call => cacheablePrefix(call.request)));
    expect(prefixes.size).toBe(1);

    // First call writes the cache, every later one reads it.
    expect(w.transport.calls[0]?.cacheRead).toBe(0);
    for (const call of w.transport.calls.slice(1)) expect(call.cacheRead).toBeGreaterThan(0);

    const { rows } = await w.mail.database.session.query<{ cached: string; sent: string }>(
      `SELECT sum(cached_input_tokens)::text AS cached, count(*)::text AS sent
         FROM mail_classification_calls
        WHERE workspace_id = $1 AND request_sent`,
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.sent)).toBe(MODEL_CASES.length);
    expect(Number(rows[0]?.cached)).toBeGreaterThan(0);
  });

  it('records the model, the prompt version, the tokens and the latency of every attempt', async () => {
    world = await createClassifierWorld();
    const w = world;
    await classifyEverything(w);

    const { rows } = await w.mail.database.session.query<{
      model_name: string;
      prompt_version: string;
      effort: string | null;
      outcome: string;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
    }>(
      `SELECT model_name, prompt_version, effort, outcome, input_tokens, output_tokens, latency_ms
         FROM mail_classification_calls
        WHERE workspace_id = $1 AND request_sent
        ORDER BY called_at, id`,
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows.length).toBe(MODEL_CASES.length);
    for (const row of rows) {
      expect(row.model_name).toBe('claude-opus-5');
      expect(row.prompt_version).toBe(CLASSIFIER_PROMPT_VERSION);
      expect(row.effort).toBe('low');
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    }
    // Every recorded failure mode appears, so the harness is exercising them rather
    // than describing them.
    const outcomes = new Set(rows.map(row => row.outcome));
    for (const failure of ['malformed', 'schema_invalid', 'refusal', 'excerpt_unverified', 'provider_error']) {
      expect(outcomes, failure).toContain(failure);
    }
  });

  it('writes a model row only for the answers it accepted, and never one that decides', async () => {
    world = await createClassifierWorld();
    const w = world;
    await classifyEverything(w);

    const { rows } = await w.mail.database.session.query<{ class: string; total: string }>(
      `SELECT class, count(*)::text AS total
         FROM mail_message_classifications
        WHERE workspace_id = $1 AND layer = 'model'
        GROUP BY class`,
      [w.mail.seeded.alpha.workspaceId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.class).toBe('uncertain');
    const accepted = MODEL_CASES.filter(c => c.expectedOutcome === 'accepted').length;
    expect(Number(rows[0]?.total)).toBe(accepted);
  });

  it('classifies a message once: a replayed job writes no second row and sends no second request', async () => {
    const only = REPLY_CORPUS.filter(c => c.id === 'terse-human-reply');
    world = await createClassifierWorld({ cases: only });
    const w = world;
    const messageId = w.messageIdOf('terse-human-reply');

    const first = await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });
    expect(first.recorded).toBe(true);
    const second = await classifyReplyWithModel(w.systemContext(), w.deps, { messageId });
    expect(second.recorded).toBe(false);

    expect(w.transport.calls.length).toBe(1);
    const rows = await listClassifications(w.systemContext(), messageId);
    expect(rows.filter(row => row.layer === 'model').length).toBe(1);
  });
});
