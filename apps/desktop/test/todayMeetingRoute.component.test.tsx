// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState, type JSX } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { FirmsRoute } from '../src/renderer/firms/FirmsRoute.tsx';
import { setNavigator, type Route } from '../src/renderer/routes.ts';
import type { OperationApi } from '../src/shared/operations.ts';
import { crmState, FIRM_ID } from './e2e/support/crmFixtures.ts';
const MEETING = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';
afterEach(() => { cleanup(); globalThis.callieApi = undefined; setNavigator(() => undefined, () => undefined); });
it('a Today meeting route retains its target while the firm and meeting reads arrive', async () => {
  const briefReads: string[] = [];
  globalThis.callieApi = {
    read: async (name: string, input: {meetingId?:string}) => {
      if (name === 'crm.businessMailList') return {sources:[],nextAfterId:null};
      if (name.startsWith('crm.')) return crmState();
      if (name === 'research.open') return { firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' };
      if (name === 'calling.history') return { calls: null };
      if (name === 'meetings.forFirm') return { meetings: [MEETING,OTHER].map(meetingId => ({ meetingId, state: 'booked', startsAt: new Date(Date.now()+86_400_000).toISOString(), endsAt: new Date(Date.now()+88_200_000).toISOString() })) };
      if (name === 'meetings.brief') { briefReads.push(input.meetingId!); return { brief: null, reason: 'not_found' }; }
      if (name === 'recordings.state') return { items: [], recentFolder: null, folderMissing: false };
      if (name === 'meetings.recordingsForFirm') return { recordings: [] };
      if (name === 'sourcing.firmQualification') return { view: null, reason: null };
      return { meetings: [] };
    },
    command: async () => { throw new Error('Opening a call context sends no command'); },
  } as unknown as OperationApi;
  const generation = createGeneration();
  function Shell(): JSX.Element {
    const [route,setRoute] = useState<Route>({ name: 'firm', firmId: FIRM_ID, meetingId: OTHER });
    useEffect(() => { setNavigator(setRoute,setRoute); },[]);
    return <FirmsRoute route={route} identity="test-person" generation={0} guard={generation.guard}/>;
  }
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DraftsProvider><Shell/></DraftsProvider></QueryClientProvider>);
  await screen.findAllByTestId('firm-meeting-row');
  await vi.waitFor(() => expect(briefReads).toEqual([OTHER]));
});
