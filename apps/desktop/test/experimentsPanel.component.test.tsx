// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {ExperimentsPanel} from '../src/renderer/sourcing/ExperimentsPanel.tsx';
afterEach(()=>{cleanup();globalThis.callieApi=undefined;});
it('shows unavailable experiment scope when the operation bridge is absent',async()=>{
 globalThis.callieApi=undefined;
 render(<ExperimentsPanel report={{from:'2026-10-01T00:00:00Z',to:'2026-10-09T00:00:00Z',asOf:'2026-10-09T00:00:00Z',cohorts:[],maturity:[],firms:[],coverage:{candidates:0,qualified:0,admitted:0,unavailable:0},search:{attempts:0,creditsReserved:0}}}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('Experiment scope is unavailable');
});
