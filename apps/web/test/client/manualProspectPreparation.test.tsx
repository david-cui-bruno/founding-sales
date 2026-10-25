// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {manualProspectSchema} from '@fss/contracts';
import {ManualProspectPreparation} from '../../src/client/ManualProspectPreparation.tsx';
const prospect=manualProspectSchema.parse({candidateId:'10000000-0000-4000-8000-000000000001',revision:1,observedName:'Fictional company',website:null,locality:null,region:null,observedPhone:null,phoneBasis:'unknown',sources:[{label:'Fictional retained source',url:null,observedAt:null}],sourceNotices:[],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
afterEach(cleanup);
it('requires explicit exact manual review, invalidates on every edit and never implies sending or a performed attempt',()=>{
 const open=vi.fn();render(<ManualProspectPreparation prospect={prospect} isScopeCurrent={()=>true} openActivity={open}/>);
 const review=screen.getByRole('button',{name:'Review exact draft · NO SEND'});
 expect(review.hasAttribute('disabled')).toBe(true);expect(open).not.toHaveBeenCalled();
 const draft=screen.getByLabelText('Manual outreach draft');
 fireEvent.change(draft,{target:{value:'  Fictional\n<not markup> exact draft  '}});
 expect(screen.queryByRole('article',{name:'Reviewed manual draft'})).toBeNull();fireEvent.click(review);
 expect(screen.getByRole('article',{name:'Reviewed manual draft'}).textContent).toContain('  Fictional\n<not markup> exact draft  ');
 expect(screen.getByText(/Recipient and channel unknown/u)).toBeTruthy();expect(screen.getByText(/No send, attempt, consent or outcome was recorded/u)).toBeTruthy();
 fireEvent.change(draft,{target:{value:'Revised fictional draft'}});expect(screen.queryByRole('article',{name:'Reviewed manual draft'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:"Open this prospect's private manual activity"}));expect(open).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button',{name:/^(Send|Generate|Save)$/u})).toBeNull();expect(screen.getByText(/not an earliest-due queue/u)).toBeTruthy();
});
it('stale same-turn events cannot edit, review or open activity after synchronous scope revocation',()=>{
 let current=true;const open=vi.fn();render(<ManualProspectPreparation prospect={prospect} isScopeCurrent={()=>current} openActivity={open}/>);
 const draft=screen.getByLabelText('Manual outreach draft');fireEvent.change(draft,{target:{value:'Only current scope'}});current=false;
 fireEvent.change(draft,{target:{value:'Stale text'}});expect(draft).toHaveProperty('value','Only current scope');
 fireEvent.click(screen.getByRole('button',{name:'Review exact draft · NO SEND'}));fireEvent.click(screen.getByRole('button',{name:"Open this prospect's private manual activity"}));
 expect(screen.queryByRole('article',{name:'Reviewed manual draft'})).toBeNull();expect(open).not.toHaveBeenCalled();
});
