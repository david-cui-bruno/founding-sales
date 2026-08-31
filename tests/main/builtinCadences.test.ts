import { describe, expect, it } from 'vitest';

import {
  BUILTIN_CADENCES,
  computeCadenceContentHash,
  parseCadenceAggregate,
} from '../../src/main/domain/cadence/builtinCadences';

describe('built-in founder-sales cadence catalog', () => {
  it('ships the six exact immutable V1 cadence aggregates', () => {
    expect(BUILTIN_CADENCES.map((definition) => ({
      id: definition.id,
      family: definition.family,
      version: definition.version,
      category: definition.category,
      attemptCap: definition.attemptCap,
      offsets: definition.steps.map(({ dayOffset }) => dayOffset),
      breakupSteps: definition.steps.filter(({ breakup }) => breakup).map(({ id }) => id),
      components: definition.steps.map((step) => step.components.map((component) => component.actionType)),
    }))).toEqual([
      {
        id: 'cadence-a-v1', family: 'cadence_a', version: 1,
        category: 'prospecting', attemptCap: 8,
        offsets: [0, 1, 3, 5, 8, 11, 12, 14],
        breakupSteps: ['cadence-a-v1-day-14'],
        components: [
          ['call', 'voicemail', 'text'], ['call'], ['text'], ['call', 'voicemail'],
          ['email'], ['call'], ['text'], ['text'],
        ],
      },
      {
        id: 'cadence-b-v1', family: 'cadence_b', version: 1,
        category: 'prospecting', attemptCap: 6,
        offsets: [0, 2, 5, 9, 13, 16],
        breakupSteps: ['cadence-b-v1-day-16'],
        components: [
          ['call', 'voicemail', 'text'], ['call'], ['text'],
          ['call', 'voicemail'], ['email'], ['text'],
        ],
      },
      {
        id: 'cadence-c-v1', family: 'cadence_c', version: 1,
        category: 'prospecting', attemptCap: 4,
        offsets: [0, 1, 4, 8],
        breakupSteps: ['cadence-c-v1-day-8'],
        components: [['text'], ['call'], ['text'], ['text']],
      },
      {
        id: 'post-interview-v1', family: 'post_interview', version: 1,
        category: 'post_stage', attemptCap: 2,
        offsets: [0, 2], breakupSteps: [], components: [['text'], ['call']],
      },
      {
        id: 'post-offer-v1', family: 'post_offer', version: 1,
        category: 'post_stage', attemptCap: 5,
        offsets: [0, 2, 5, 9, 12],
        breakupSteps: ['post-offer-v1-day-12'],
        components: [['email'], ['text'], ['text'], ['call'], ['text']],
      },
      {
        id: 'onboarding-v1', family: 'onboarding', version: 1,
        category: 'onboarding', attemptCap: 1,
        offsets: [0], breakupSteps: [], components: [['text', 'text', 'text']],
      },
    ]);
  });

  it('preserves the locked V1 copy and policy identifiers', () => {
    const [cadenceA, cadenceB, cadenceC, postInterview, postOffer, onboarding] = BUILTIN_CADENCES;
    expect(cadenceA.policyIds).toEqual({
      call: 'founder_call_v1', text: 'founder_text_v1', email: 'founder_email_v1',
    });
    expect(cadenceA.steps[2]?.components[0]?.template.body).toContain(
      'happy to share what other Providence landlords tell me about finding contractors',
    );
    expect(cadenceA.steps[7]?.components[0]?.template.body).toContain(
      'closing my file — if a repair ever has you chasing plumbers, this number will still work',
    );
    expect(cadenceB.steps[0]?.components[0]?.template.body.toLowerCase()).toContain('research');
    expect(cadenceC.steps[0]?.components[0]?.template.body.toLowerCase()).toContain('thank');
    expect(postInterview.steps[0]?.components[0]?.template.body).toContain('{{confirmed_pain}}');
    expect(postOffer.steps[2]?.components[0]?.template.body).toContain('{{trial_commitment}}');
    expect(JSON.stringify(postOffer).toLowerCase()).not.toContain('spots left');
    expect(onboarding.steps[0]?.components.map(({ template }) => template.body)).toEqual([
      expect.stringContaining('Welcome'),
      expect.stringContaining('{{stripe_link}}'),
      expect.stringContaining('Text your first job to this number now'),
    ]);
  });

  it('defines a typed and forward-only outcome graph for every component', () => {
    for (const definition of BUILTIN_CADENCES) {
      const componentPositions = new Map(
        definition.steps.flatMap((step) => step.components.map((component) => [
          component.id,
          [step.sequence, component.sequence] as const,
        ])),
      );
      for (const step of definition.steps) {
        for (const component of step.components) {
          expect(Object.keys(component.outcomes).sort()).toEqual(
            [...component.allowedOutcomes, 'marked_impossible'].sort(),
          );
          expect(component.outcomes.failed).toEqual({
            kind: 'retry_component', componentId: component.id,
          });
          expect(component.outcomes.channel_unavailable).toEqual({
            kind: 'resolve_contact_method', componentId: component.id,
          });
          for (const transition of Object.values(component.outcomes)) {
            if (transition.kind === 'retry_component') {
              expect(transition.componentId).toBe(component.id);
            }
            if (transition.kind === 'next_component') {
              const target = componentPositions.get(transition.componentId);
              expect(target).toBeDefined();
              expect(
                target![0] > step.sequence
                || (target![0] === step.sequence && target![1] > component.sequence),
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('uses a stable SHA-256 over the canonical full aggregate and rejects corruption', () => {
    expect(BUILTIN_CADENCES.map(({ contentHash }) => contentHash)).toEqual([
      '31cde885f94eaef9dd4a7a0788949e32c21bac53fa0741bca44a57f3a4dc8b5c',
      '57c2a6e871ccf16a5a7b672602ea7c6997d42a53230cf18cccd32d2b00bbab9a',
      '9bd917a71a7eee848df65ca61088b3e06b01c8959e1b2972a150258880c2caf4',
      '4a5d4ef5f9493016753d4e1f26d34e2ff43b9686d5ab509aca2c8e7957c78d39',
      'b618a6e697b956249a2df2b21f70a11cca30de7620c8674fadcf2e83d567179b',
      '9a8524d83dc96427f4c541eb28d3afecc5983c60c967051130eae9b34f604f25',
    ]);
    for (const definition of BUILTIN_CADENCES) {
      expect(computeCadenceContentHash(definition)).toBe(definition.contentHash);
      expect(parseCadenceAggregate(structuredClone(definition))).toEqual(definition);
      expect(() => parseCadenceAggregate({ ...definition, contentHash: '0'.repeat(64) })).toThrow();
    }
  });

  it('rejects a self-consistent hash when channel or failure mechanics violate the graph contract', () => {
    const wrongFailure = structuredClone(BUILTIN_CADENCES[0]!);
    (wrongFailure.steps[0]!.components[0]!.outcomes as Record<string, unknown>).failed = {
      kind: 'complete_step',
    };
    (wrongFailure as { contentHash: string }).contentHash = computeCadenceContentHash(wrongFailure);
    expect(() => parseCadenceAggregate(wrongFailure)).toThrow();

    const wrongChannel = structuredClone(BUILTIN_CADENCES[0]!);
    (wrongChannel.steps[0]!.components[0] as { channel: string }).channel = 'email';
    (wrongChannel as { contentHash: string }).contentHash = computeCadenceContentHash(wrongChannel);
    expect(() => parseCadenceAggregate(wrongChannel)).toThrow();
  });
});
