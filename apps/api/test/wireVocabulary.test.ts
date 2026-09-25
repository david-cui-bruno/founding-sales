import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as wire from '@fss/contracts';
import { REPLY_CLASSES, REPLY_DISPOSITIONS, type ResumeDecision, type StepChannel } from '@fss/domain';
import { CLASSIFIER_EFFORTS, CLASSIFIER_MODELS, REPLY_NEXT_ACTIONS } from '@fss/domain/classification';
import { OUTBOUND_STATES } from '@fss/domain/outbound';
import {
  ENROLLMENT_END_REASONS,
  ENROLLMENT_STATES,
  SEQUENCE_STOP_CONDITIONS,
  SEQUENCE_VERSION_STATES,
  STEP_CHANNELS,
  STEP_COMPLETION_SOURCES,
  STEP_EXECUTION_STATES,
  STEP_RESULTS,
} from '@fss/domain/sequences';
import { TODAY_ITEM_KINDS, TODAY_LANES } from '@fss/domain/today';

/**
 * Every closed vocabulary the wire contract declares is the domain's own (lane g78,
 * audit item D07).
 *
 * The desktop may not import `@fss/domain` (14.2), so `@fss/contracts` spells each
 * list the Mac validates: the classifier's efforts, the sequence states, the enrollment
 * end reasons, the Today lanes. A spelling is a copy, and a copy is how D03 happened —
 * the server gained `xhigh` and `max` and the Mac's list did not. The API depends on
 * both packages, so this is the one place that can hold each spelling to the list the
 * domain actually uses: a value added, removed or reordered on either side fails here,
 * in the API's CI, instead of as an answer a Mac cannot parse.
 *
 * The step channel is held to the domain's `StepChannel` type as well as to its array
 * (the array arrived when LinkedIn was removed on 25 September 2026), and the
 * confirmation consequences, which have no exported array in the domain, to the CHECK
 * constraint that defines them in migration 0011.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the wire vocabularies are the domain’s', () => {
  it.each([
    ['SEQUENCE_VERSION_STATES', wire.SEQUENCE_VERSION_STATES, SEQUENCE_VERSION_STATES],
    ['SEQUENCE_STOP_CONDITIONS', wire.SEQUENCE_STOP_CONDITIONS, SEQUENCE_STOP_CONDITIONS],
    ['ENROLLMENT_STATES', wire.ENROLLMENT_STATES, ENROLLMENT_STATES],
    ['ENROLLMENT_END_REASONS', wire.ENROLLMENT_END_REASONS, ENROLLMENT_END_REASONS],
    ['STEP_CHANNELS', wire.STEP_CHANNELS, STEP_CHANNELS],
    ['STEP_COMPLETION_SOURCES', wire.STEP_COMPLETION_SOURCES, STEP_COMPLETION_SOURCES],
    ['STEP_RESULTS', wire.STEP_RESULTS, STEP_RESULTS],
    // Lane g88: the resume review names each unexecuted step's state.
    ['STEP_EXECUTION_STATES', wire.STEP_EXECUTION_STATES, STEP_EXECUTION_STATES],
    ['CLASSIFIER_EFFORTS', wire.CLASSIFIER_EFFORTS, CLASSIFIER_EFFORTS],
    ['CLASSIFIER_MODELS', wire.CLASSIFIER_MODELS, CLASSIFIER_MODELS],
    ['REPLY_CLASSES', wire.REPLY_CLASSES, REPLY_CLASSES],
    ['REPLY_DISPOSITIONS', wire.REPLY_DISPOSITIONS, REPLY_DISPOSITIONS],
    ['REPLY_NEXT_ACTIONS', wire.REPLY_NEXT_ACTIONS, REPLY_NEXT_ACTIONS],
    ['OUTBOUND_STATES', wire.OUTBOUND_STATES, OUTBOUND_STATES],
    ['TODAY_LANES', wire.TODAY_LANES, TODAY_LANES],
    ['TODAY_ITEM_KINDS', wire.TODAY_ITEM_KINDS, TODAY_ITEM_KINDS],
  ] as const)('%s', (_name, spelled, domain) => {
    expect([...spelled]).toEqual([...domain]);
  });

  it('STEP_CHANNELS is the domain’s StepChannel', () => {
    const same: Same<(typeof wire.STEP_CHANNELS)[number], StepChannel> = true;
    expect(same).toBe(true);
    expect(new Set(wire.STEP_CHANNELS).size).toBe(wire.STEP_CHANNELS.length);
  });

  it('RESUME_DECISION_KINDS is decideResume’s three answers (lane g88)', () => {
    const same: Same<(typeof wire.RESUME_DECISION_KINDS)[number], ResumeDecision['kind']> = true;
    expect(same).toBe(true);
    expect(new Set(wire.RESUME_DECISION_KINDS).size).toBe(wire.RESUME_DECISION_KINDS.length);
  });

  it('REPLY_CONFIRMATION_CONSEQUENCES is migration 0011’s CHECK', () => {
    const migration = readFileSync(
      new URL('../../../packages/domain/db/migrations/0011_classification.sql', import.meta.url),
      'utf8',
    );
    const check = /mail_reply_confirmations_consequences_known\s+CHECK \(consequences <@ ARRAY\[([^\]]+)\]/u.exec(migration);
    expect(check).not.toBeNull();
    const values = [...(check?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
    expect([...wire.REPLY_CONFIRMATION_CONSEQUENCES]).toEqual(values);
  });
});
