import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { actualAccountCallOutcomes, connectedCallOutcomes, manualCallOutcomes, accountCallOutcomeSchema } from '../../src/shared/contracts/accountOutboundContract';
import { manualOutcomeSchema } from '../../src/shared/contracts/ownerCommandContract';
import { phoneOutcomes, describePhoneOutcome } from '../../src/renderer/features/today/companyPhoneSession';

const root = resolve(__dirname, '../..');
const callOutcomes = () => {
  const shape = manualOutcomeSchema.options.find(option => option.shape.channel.value === 'call');
  if (!shape) throw new Error('call member missing');
  return [...(shape.shape.outcome.options as readonly string[])];
};

describe('the call outcome set has one shared source of truth', () => {
  it('names the three connected results beside the existing values', () => {
    expect([...connectedCallOutcomes]).toEqual(['connected', 'interested', 'not_interested', 'gatekeeper']);
    expect([...actualAccountCallOutcomes]).toEqual(['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'interested', 'not_interested', 'gatekeeper']);
    expect([...manualCallOutcomes]).toEqual([...actualAccountCallOutcomes, 'cancelled', 'not_called', 'unknown', 'opt_out']);
  });
  it('every enum site agrees with the shared list', () => {
    expect(callOutcomes()).toEqual([...manualCallOutcomes]);
    expect([...phoneOutcomes]).toEqual([...manualCallOutcomes]);
    expect(accountCallOutcomeSchema.options).toEqual([...actualAccountCallOutcomes, 'cancelled', 'not_called']);
  });
  it('the report form labels the three connected results in plain words', () => {
    expect(describePhoneOutcome('interested')).toBe('Connected, interested');
    expect(describePhoneOutcome('not_interested')).toBe('Connected, not interested');
    expect(describePhoneOutcome('gatekeeper')).toBe('Gatekeeper, did not reach them');
    expect(describePhoneOutcome('no_answer')).toBe('No answer');
  });
  it('no site keeps a private copy of the actual-outcome list', () => {
    const literal = "'connected', 'no_answer', 'voicemail', 'busy', 'wrong_number'";
    for (const file of ['src/renderer/features/today/CompanyPhoneCall.tsx', 'src/main/domain/today/todayActualCallEvidence.ts',
      'src/shared/contracts/ownerCommandContract.ts', 'cloud/lambdas/delegated-worker/src/ownerCommandCoordinator.ts']) {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect([file, text.includes(literal) || text.includes(literal.replaceAll(' ', ''))]).toEqual([file, false]);
    }
  });
});
