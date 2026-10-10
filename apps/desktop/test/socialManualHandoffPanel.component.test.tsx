// @vitest-environment jsdom
import {it,expect,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {ManualHandoffPanel} from '../src/renderer/social/ManualHandoffPanel.tsx';
import type {OperationApi} from '../src/shared/operations.ts';
afterEach(()=>{cleanup();globalThis.callieApi=undefined;});
it('retries an uncertain exact confirmation with its original ID and reviews changed authority with a new ID',async()=>{
 const first='a'.repeat(64),second='b'.repeat(64);let fingerprint=first,approved=false,uncertain=true;
 const commands:{commandId:string;fingerprint:string}[]=[];
 globalThis.callieApi={
  read:async()=>({view:{postId:'post',revision:1,fingerprint,approvalId:approved?'approval':null,approvedAt:null,state:approved?'manual_needed':'review_required',accountEvidence:'human_review_required',snapshot:{account:{id:'account',platform:'x',externalId:'founder',displayName:fingerprint===first?'Founder':'New identity',accountKind:'profile',revision:fingerprint===first?1:2},text:'Observation.',images:[],publishAt:'2099-10-10T12:00:00Z',zone:'America/New_York'}},reason:null}),
  command:async(name:string,input:unknown)=>{if(name!=='social.confirmHandoff')throw new Error('Unexpected publication action');const command=input as {commandId:string;fingerprint:string};commands.push(command);if(uncertain){uncertain=false;throw new Error('Transport uncertain');}approved=true;return {accepted:true,approvalId:'approval',reason:null};},
 } as unknown as OperationApi;
 render(<ManualHandoffPanel postId='post' revision={1}/>);
 const review=async()=>{fireEvent.click(await screen.findByLabelText('I reviewed the exact destination, text, images and requested time.'));fireEvent.click(screen.getByRole('button',{name:'Approve manual handoff'}));};
 await review();await screen.findByText('No definite answer. Refresh this handoff before copying.');
 fireEvent.click(screen.getByRole('button',{name:'Refresh handoff'}));await review();
 await screen.findByRole('button',{name:'Copy approved text'});
 expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
 fingerprint=second;approved=false;
 fireEvent.click(screen.getByRole('button',{name:'Copy approved text'}));await screen.findByText('The destination or content changed. Review it again.');
 fireEvent.click(screen.getByRole('button',{name:'Refresh handoff'}));await screen.findByText(/New identity/);await review();
 await waitFor(()=>expect(commands).toHaveLength(3));expect(commands[2]?.commandId).not.toBe(commands[1]?.commandId);
 expect(commands.map(command=>command.fingerprint)).toEqual([first,first,second]);
 expect(await screen.findByRole('button',{name:'Copy approved text'})).toBeTruthy();
});
