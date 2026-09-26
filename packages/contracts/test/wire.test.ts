import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CLASSIFIER_EFFORTS,
  ceilingMaximum,
  classifierSettingsResponseSchema,
  clientCompatibility,
  clientVersionPolicySchema,
  clientVersionRangeSchema,
  describeClientVersionMaximum,
  mayMutate,
  publishedClientVersions,
  REMOVED_STEP_CHANNELS,
  resumePreviewStepSchema,
  sequenceStepDtoSchema,
  sequenceVersionsResponseSchema,
  STEP_CHANNELS,
  wireDrift,
} from '../src/index.ts';

/**
 * Lane g78's two contracts: the compatibility ceiling and the exactness check the
 * routes' tests use. Both are pure, so their rules are here rather than behind a
 * database.
 */

describe('the compatibility ceiling (O04)', () => {
  const policy = clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.x', incompatible: ['1.0.7'] });

  it('tops a major line at 999.999 and a minor line at 999', () => {
    expect(ceilingMaximum('1.x')).toBe('1.999.999');
    expect(ceilingMaximum('1.4.x')).toBe('1.4.999');
    expect(ceilingMaximum('0.x')).toBe('0.999.999');
  });

  it('publishes exactly the two keys an installed Mac parses', () => {
    const published = publishedClientVersions(policy);
    expect(published).toEqual({ minimum: '1.0.0', maximum: '1.999.999' });
    expect(clientVersionRangeSchema.safeParse(published).success).toBe(true);
  });

  it('admits every build on the line, refuses a listed one, and refuses above and below', () => {
    expect(clientCompatibility(policy, '1.0.5')).toEqual({ kind: 'supported', version: '1.0.5' });
    expect(clientCompatibility(policy, '1.37.2')).toEqual({ kind: 'supported', version: '1.37.2' });
    expect(clientCompatibility(policy, '1.0.7')).toEqual({ kind: 'incompatible', version: '1.0.7' });
    expect(mayMutate(policy, '1.0.7')).toBe(false);
    expect(clientCompatibility(policy, '2.0.0')).toEqual({ kind: 'api_behind_client', version: '2.0.0', maximum: '1.999.999' });
    expect(clientCompatibility(clientVersionPolicySchema.parse({ minimum: '1.2.0', ceiling: '1.x', incompatible: [] }), '1.1.9')).toEqual({
      kind: 'upgrade_required',
      version: '1.1.9',
      minimum: '1.2.0',
    });
  });

  it('decides the same as the published range for every version it does not list', () => {
    const published = publishedClientVersions(policy);
    for (const version of ['0.9.9', '1.0.0', '1.0.4', '1.0.5', '1.999.999', '2.0.0', 'latest']) {
      expect(clientCompatibility(published, version), version).toEqual(clientCompatibility(policy, version));
    }
  });

  it('refuses a policy that does not mean what it says', () => {
    const refused = [
      { minimum: '2.0.0', ceiling: '1.x', incompatible: [] },
      { minimum: '1.0.0', ceiling: '1', incompatible: [] },
      { minimum: '1.0.0', ceiling: '1.x.x', incompatible: [] },
      { minimum: '1.0.0', ceiling: '1.x', incompatible: ['0.9.0'] },
      { minimum: '1.0.0', ceiling: '1.x', incompatible: ['2.0.0'] },
      { minimum: '1.0.0', ceiling: '1.x', incompatible: ['1.0.7', '1.0.7'] },
      { minimum: '1.0.0', ceiling: '1.x' },
      { minimum: '1.0.0', maximum: '1.0.4' },
    ];
    for (const candidate of refused) {
      expect(clientVersionPolicySchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });

  it('reads a ceiling’s maximum as a line, and any other version as itself', () => {
    expect(describeClientVersionMaximum('1.999.999')).toBe('any 1.x');
    expect(describeClientVersionMaximum('1.4.999')).toBe('any 1.4.x');
    expect(describeClientVersionMaximum('1.0.4')).toBe('1.0.4');
  });
});

describe('wireDrift: exact at the route, tolerant on the Mac (D07)', () => {
  const schema = z.object({ id: z.string(), nested: z.object({ kind: z.enum(['a', 'b']) }), list: z.array(z.object({ n: z.number() })) });

  it('is empty for an answer that is exactly the contract', () => {
    expect(wireDrift(schema, { id: 'x', nested: { kind: 'a' }, list: [{ n: 1 }] })).toEqual([]);
  });

  it('names a key the contract does not declare, at any depth', () => {
    expect(wireDrift(schema, { id: 'x', extra: 1, nested: { kind: 'a', more: true }, list: [{ n: 1, other: 'y' }] })).toEqual([
      'extra: not declared by the contract',
      'nested.more: not declared by the contract',
      'list.0.other: not declared by the contract',
    ]);
  });

  it('names a missing key and a value outside a vocabulary', () => {
    const drift = wireDrift(schema, { nested: { kind: 'c' }, list: [] });
    expect(drift.some(line => line.startsWith('id:'))).toBe(true);
    expect(drift.some(line => line.startsWith('nested.kind:'))).toBe(true);
  });

  it('is what the Mac’s parse does not do: the same schema strips an added key rather than refusing', () => {
    const step = {
      id: '11111111-1111-4111-8111-111111111111',
      sequenceVersionId: '22222222-2222-4222-8222-222222222222',
      ordinal: 1,
      channel: 'email',
      delay: { unit: 'elapsed', hours: 0 },
      onNoAnswer: null,
      templateVersionId: null,
    };
    expect(sequenceStepDtoSchema.safeParse({ ...step, addedLater: 1 }).success).toBe(true);
    expect(wireDrift(sequenceStepDtoSchema, { ...step, addedLater: 1 })).toEqual(['addedLater: not declared by the contract']);
    // D01, stated as the contract: the key 1.0.4 refused is required.
    const { sequenceVersionId: _dropped, ...withoutVersion } = step;
    expect(sequenceStepDtoSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('accepts every classifier effort the server does (D03)', () => {
    for (const effort of CLASSIFIER_EFFORTS) {
      const parsed = classifierSettingsResponseSchema.safeParse({
        enabled: true,
        modelName: 'claude-opus-5',
        effort,
        maxOutputTokens: 512,
        dailyCallCap: 500,
        updatedByUserId: null,
        updatedAt: null,
      });
      expect(parsed.success, effort).toBe(true);
    }
  });
});

describe('a stored step of a removed channel is readable and not authorable (lane A2)', () => {
  const current = {
    id: '11111111-1111-4111-8111-111111111111',
    sequenceVersionId: '22222222-2222-4222-8222-222222222222',
    ordinal: 1,
    channel: 'call_task',
    delay: { unit: 'business_days', days: 0 },
    onNoAnswer: 'advance',
    templateVersionId: null,
  };
  const removed = {
    id: '33333333-3333-4333-8333-333333333333',
    sequenceVersionId: '22222222-2222-4222-8222-222222222222',
    ordinal: 2,
    channel: 'removed',
    removedChannel: 'linkedin',
    delay: { unit: 'business_days', days: 2 },
    onNoAnswer: null,
    templateVersionId: null,
  };
  const version = {
    id: '22222222-2222-4222-8222-222222222222',
    sequenceId: '44444444-4444-4444-8444-444444444444',
    version: 1,
    state: 'published',
    stopConditions: ['human_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'],
    publishedAt: '2026-09-01T13:00:00.000Z',
    retiredAt: null,
  };

  it('parses a versions answer holding a removed step, where it once refused the whole answer', () => {
    expect(wireDrift(sequenceVersionsResponseSchema, { versions: [{ ...version, steps: [current, removed] }] })).toEqual([]);
    expect(wireDrift(sequenceStepDtoSchema, removed)).toEqual([]);
  });

  it('carries the channel it was and none of what it carried', () => {
    expect(wireDrift(sequenceStepDtoSchema, { ...removed, linkedinMessage: 'Hello' })).toEqual([
      'linkedinMessage: not declared by the contract',
    ]);
    expect(sequenceStepDtoSchema.safeParse({ ...removed, templateVersionId: current.id }).success).toBe(false);
    expect(sequenceStepDtoSchema.safeParse({ ...removed, onNoAnswer: 'advance' }).success).toBe(false);
    expect(sequenceStepDtoSchema.safeParse({ ...removed, removedChannel: 'fax' }).success).toBe(false);
  });

  it('still refuses the stored value itself, and draft authoring knows only the current channels', () => {
    expect(sequenceStepDtoSchema.safeParse({ ...current, channel: 'linkedin_task' }).success).toBe(false);
    expect(sequenceStepDtoSchema.safeParse({ ...current, channel: 'linkedin' }).success).toBe(false);
    expect([...STEP_CHANNELS]).toEqual(['email', 'call_task']);
    expect([...REMOVED_STEP_CHANNELS]).toEqual(['linkedin']);
  });

  it('reviews a removed step as held for channel_removed, and only so', () => {
    const step = {
      stepExecutionId: '55555555-5555-4555-8555-555555555555',
      ordinal: 2,
      channel: 'removed',
      removedChannel: 'linkedin',
      state: 'held',
      heldReason: 'channel_removed',
      originalDueAt: '2026-09-20T13:00:00.000Z',
      dueAt: '2026-09-20T13:00:00.000Z',
      proposedDueAt: '2026-09-20T13:00:00.000Z',
    };
    expect(wireDrift(resumePreviewStepSchema, step)).toEqual([]);
    expect(resumePreviewStepSchema.safeParse({ ...step, state: 'pending' }).success).toBe(false);
    const { heldReason: _dropped, ...withoutReason } = step;
    expect(resumePreviewStepSchema.safeParse(withoutReason).success).toBe(false);
    expect(resumePreviewStepSchema.safeParse({ ...step, channel: 'linkedin_task' }).success).toBe(false);
  });
});
