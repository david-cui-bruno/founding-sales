import { expect, it } from 'vitest';
import { operationOf, OPERATIONS } from '../src/shared/operations.ts';
it('allows selected-note operations without letting the renderer choose a path or command envelope', () => {
  expect(operationOf('crm.personCreate')).toBe('crm.personCreate');
  const operation = OPERATIONS['crm.personCreate'];
  expect(operation?.kind).toBe('command');
  expect(operation?.input.safeParse({ fullName: 'Alex Example' }).success).toBe(
    true,
  );
  expect(
    operation?.input.safeParse({
      fullName: 'Alex Example',
      path: '/send',
      clientVersion: '1.0.0',
    }).success,
  ).toBe(false);
});
it('reads a bounded relationship page through a closed operation without changing operational contact state',()=>{
 const name=operationOf('crm.relationshipRead');
 expect(name).toBe('crm.relationshipRead');
});
it('closes business review operations and keeps enable requests and command envelopes out of renderer payloads',()=>{
 const policy=OPERATIONS['crm.businessPolicySave'];
 expect(policy?.kind).toBe('command');
 expect(OPERATIONS['crm.businessReviewRead']?.calls).toEqual([{method:'POST',path:'/crm/business/review/read'}]);
 expect(policy?.input.safeParse({mailboxId:'11111111-1111-4111-8111-111111111111',expectedGeneration:1,expectedAccountBinding:'a'.repeat(64),expectedRevision:0,enabled:false,disclosure:null,commandId:'caller-envelope'}).success).toBe(false);
});
