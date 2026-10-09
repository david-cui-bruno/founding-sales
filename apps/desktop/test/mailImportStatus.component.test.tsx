// @vitest-environment jsdom
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {MailImportStatus,type MailImportPorts} from '../src/renderer/firms/MailImportStatus.tsx';
import {mailImportHealth,IMPORT_ID} from './support/mailImportFixture.ts';
afterEach(cleanup);
const MAILBOX='11111111-1111-4111-8111-111111111111';
it('shows measured metadata, retained copies and decimal allocation separately without treating a traversal end as full body coverage',async()=>{
 const ports:MailImportPorts={health:vi.fn(async()=>mailImportHealth()),request:vi.fn(async()=>({importId:IMPORT_ID,status:'queued' as const}))};
 render(<MailImportStatus ports={ports} enabled mailboxId={MAILBOX} privacyKey="one" generation={2} accountBinding={'a'.repeat(64)}/>);
 expect(await screen.findByText('Retained unique messages: 7')).toBeTruthy();expect(screen.getByText('Copied-body coverage: partial')).toBeTruthy();expect(screen.getByText('Retained copied bodies: 5')).toBeTruthy();expect(screen.getByText('Callie import allocation reserved: 100000000000000000007 units')).toBeTruthy();expect(screen.getByText('Observed allocation usage: 70 units')).toBeTruthy();expect(screen.getByText('Unknown allocation usage held: 30 units')).toBeTruthy();expect(screen.getByText('Current retained-copy traversal reached its end. Coverage remains partial.')).toBeTruthy();expect(screen.getByText('Older copies visited: 12 · refreshed: 5 · unresolved: 7')).toBeTruthy();expect(screen.getByText('History overlap is incomplete.')).toBeTruthy();expect(screen.queryByText(/all messages imported|all bodies complete|quota refunded/i)).toBeNull();
});

it('acknowledges a queued request separately from the next authenticated health read without inventing imported counts',async()=>{
 const user=userEvent.setup();const health=vi.fn(async()=>null),request=vi.fn(async()=>({importId:IMPORT_ID,status:'queued' as const}));const ports:MailImportPorts={health,request};
 render(<MailImportStatus ports={ports} enabled mailboxId={MAILBOX} privacyKey="one" generation={2} accountBinding={'a'.repeat(64)}/>);await screen.findByText('No import status is available for this mailbox.');await user.click(screen.getByRole('button',{name:'Request 90-day import'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith({mailboxId:MAILBOX}));expect(await screen.findByText('Import request queued. Coverage is reported separately after work runs.')).toBeTruthy();expect(health).toHaveBeenCalledTimes(2);expect(screen.queryByText(/Retained unique messages|Retained copied bodies|Import state: complete/)).toBeNull();
});
it('keeps permitted copied-body coverage separate from a disconnected mailbox and expired history recovery',async()=>{
 const measured=mailImportHealth();const ports:MailImportPorts={health:async()=>({...measured,state:'complete',connectionState:'disconnected',copyCoverage:{...measured.copyCoverage,coverage:'complete'},gapCoverage:{olderCopyReconciliation:{kind:'bounded_current_copy_traversal',coverage:'partial',visitedCopies:'2',refreshedCopies:'1',unresolvedCopies:'1',traversalExhausted:false},kind:'surviving_message_enumeration_and_fresh_history',epoch:1,state:'draining',originalCursor:'unavailable',fromAt:'2026-09-01T00:00:00Z',toAt:'2026-10-08T00:00:00Z',windowFrozen:true,totalDays:37,completedDays:12,historyComplete:false,reason:'history_coverage_expired'}}),request:vi.fn()};
 render(<MailImportStatus ports={ports} enabled mailboxId={MAILBOX} privacyKey="one" generation={2} accountBinding={'a'.repeat(64)}/>);
 expect(await screen.findByText('Mailbox connection: disconnected')).toBeTruthy();expect(screen.getByText('Copied-body coverage: complete')).toBeTruthy();expect(screen.getByText('Retained copied bodies: 5')).toBeTruthy();expect(screen.getByText('Recovery-gap state: draining')).toBeTruthy();expect(screen.getByText('Original history cursor is unavailable.')).toBeTruthy();expect(screen.getByText('Fresh recovery history is incomplete.')).toBeTruthy();expect(screen.queryByText(/Original Gmail is currently available|All history complete|Copies deleted by disconnect/i)).toBeNull();
});
it('discards late health and queued acknowledgement on privacy, mailbox and source-version changes',async()=>{
 let finish!:(value:ReturnType<typeof mailImportHealth>)=>void;
 const pending=new Promise<ReturnType<typeof mailImportHealth>>(resolve=>{finish=resolve;});
 let completeRequest!:(value:{importId:string;status:'queued'})=>void;
 const ports:MailImportPorts={health:vi.fn(async()=>pending),request:vi.fn(()=>new Promise<{importId:string;status:"queued"}>(resolve=>{completeRequest=resolve;}))};
 const props={ports,enabled:true,mailboxId:MAILBOX,privacyKey:'one',generation:2,accountBinding:'a'.repeat(64),sourceVersion:1};
 const view=render(<MailImportStatus {...props}/>);
 view.rerender(<MailImportStatus {...props} enabled={false} privacyKey="two" sourceVersion={2}/>);
 finish(mailImportHealth()); await waitFor(()=>expect(screen.queryByText('Retained unique messages: 7')).toBeNull());
 const current:MailImportPorts={health:async()=>null,request:ports.request};
 view.rerender(<MailImportStatus {...props} ports={current}/>);await screen.findByText('No import status is available for this mailbox.');
 await userEvent.setup().click(screen.getByRole('button',{name:'Request 90-day import'}));
 view.rerender(<MailImportStatus {...props} ports={current} enabled={false} mailboxId={IMPORT_ID} generation={3}/>);
 completeRequest({importId:IMPORT_ID,status:'queued'});
 await waitFor(()=>expect(screen.queryByText('Import request queued. Coverage is reported separately after work runs.')).toBeNull());
 expect(screen.queryByText('Retained unique messages: 7')).toBeNull();
});

it('separates exhausted initial traversal from the current recovery epoch without implying unique or complete history',async()=>{
 const measured=mailImportHealth();const ports:MailImportPorts={health:async()=>({...measured,gapCoverage:{olderCopyReconciliation:{kind:'bounded_current_copy_traversal',coverage:'partial',visitedCopies:'2',refreshedCopies:'1',unresolvedCopies:'1',traversalExhausted:false},kind:'surviving_message_enumeration_and_fresh_history',epoch:2,state:'draining',originalCursor:'unavailable',fromAt:'2026-10-08T00:00:00Z',toAt:'2026-10-09T00:00:00Z',windowFrozen:true,totalDays:1,completedDays:1,historyComplete:false,reason:null}}),request:vi.fn()};
 render(<MailImportStatus ports={ports} enabled mailboxId={MAILBOX} privacyKey="one" generation={2} accountBinding={'a'.repeat(64)}/>);
 expect(await screen.findByText('Current retained-copy traversal reached its end. Coverage remains partial.')).toBeTruthy();
 expect(screen.getByText('Recovery epoch 2 retained-copy traversal is ongoing. Coverage remains partial.')).toBeTruthy();
 expect(screen.getByText('Recovery older copies visited: 2 · refreshed: 1 · unresolved: 1')).toBeTruthy();
 expect(screen.queryByText(/unique older copies|all older copies complete/i)).toBeNull();
});
