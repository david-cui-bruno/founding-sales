// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEETING_TRANSCRIPTION, type MeetingTranscriptPage } from '@fss/contracts';
import { MeetingTranscript, type TranscriptPorts } from '../src/renderer/meetings/MeetingTranscript.tsx';
import { MeetingTranscriptionSection } from '../src/renderer/settings/MeetingTranscriptionSection.tsx';
import { MeetingRecoveryQueue } from '../src/renderer/recordings/MeetingRecoveryQueue.tsx';
import { useRoute } from '../src/renderer/app/useRoute.ts';
import { setNavigator } from '../src/renderer/routes.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { transcriptPage, MID, RID } from './support/meetingTranscriptFixture.ts';
afterEach(() => { cleanup(); vi.useRealTimers(); });
const portsFor = (page = transcriptPage()): TranscriptPorts => ({ read: vi.fn(async () => ({ page, reason: null })), reupload: vi.fn(async () => ({ status: 'resumed' as const })), chooseFile: vi.fn(async () => ({ status: 'cancelled' as const })) });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Transcript' }));
describe('meeting transcript', () => {
  it('partial_meeting_is_not_complete; source text stays inert', async () => {
    const page = transcriptPage('partial'); page.utterances[0]!.text = '<script>alert("hello")</script>';
    const { container } = render(<MeetingTranscript meetingId={MID} ports={portsFor(page)} />); open();
    expect(await screen.findByText('1 of 2 recordings ready')).toBeTruthy();
    expect(screen.getByText(/Original audio is needed/)).toBeTruthy();
    expect(screen.getByText('<script>alert("hello")</script>')).toBeTruthy(); expect(container.querySelector('script')).toBeNull();
  });
  it('repeated_names_stay_distinct and second_click_collapses_transcript', async () => {
    const page = transcriptPage(); page.recordings[1]!.participantLabel = page.recordings[0]!.participantLabel;
    render(<MeetingTranscript meetingId={MID} ports={portsFor(page)} />); open();
    expect(await screen.findAllByTestId('transcript-source')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' })); expect(screen.queryByTestId('transcript-content')).toBeNull();
  });
  it('late_participant_refreshes_revision instead of appending an old cursor', async () => {
    const first = { ...transcriptPage(), nextCursor: 'old-page' };
    const next = { ...transcriptPage('partial'), coverage: { ...transcriptPage('partial').coverage, sourceRevision: 3 } };
    const p = portsFor(); p.read = vi.fn().mockResolvedValueOnce({ page: first, reason: null }).mockResolvedValueOnce({ page: null, reason: 'transcript_changed' }).mockResolvedValueOnce({ page: next, reason: null });
    render(<MeetingTranscript meetingId={MID} ports={p} />); open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('1 of 2 recordings ready')).toBeTruthy();
    expect(p.read).toHaveBeenLastCalledWith({ meetingId: MID });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
  it('stale_account_read_is_discarded', async () => {
    let finish!: (value: { page: MeetingTranscriptPage; reason: null }) => void;
    const p = portsFor(); p.read = vi.fn<TranscriptPorts['read']>(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const { rerender } = render(<DraftsProvider key="old"><MeetingTranscript meetingId={MID} ports={p} /></DraftsProvider>); open();
    rerender(<DraftsProvider key="new"><MeetingTranscript meetingId={MID} ports={portsFor()} /></DraftsProvider>);
    await act(async () => { finish({ page: transcriptPage(), reason: null }); });
    expect(screen.queryByTestId('transcript-content')).toBeNull();
  });
  it('reupload_is_actionable_once and a repeated click cannot send twice', async () => {
    let finish!: () => void; const p = portsFor(); p.reupload = vi.fn<TranscriptPorts['reupload']>(() => new Promise(resolve => { finish = () => resolve({ status: 'resumed' as const }); }));
    const read = vi.fn(async () => ({ items: [{ recordingId: RID(1), meetingId: MID, firmId: RID(9), firmName: 'Example Rentals', participantLabel: 'audio.m4a' }], truncated: false }));
    render(<MeetingRecoveryQueue read={read} ports={p} />);
    const button = await screen.findByRole('button', { name: 'Reupload audio' }); fireEvent.click(button); fireEvent.click(button);
    expect(p.reupload).toHaveBeenCalledTimes(1); await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reupload audio' })).toBeNull());
  });
  it('the recovery firm link opens the actual firm route', async () => {
    const previous = globalThis.callie, hash = location.hash;
    globalThis.callie = { onNavigate: () => undefined } as unknown as NonNullable<typeof globalThis.callie>;
    history.replaceState(null, '', '#today');
    const read = async () => ({ items: [{ recordingId: RID(1), meetingId: MID, firmId: RID(9), firmName: 'Example Rentals', participantLabel: 'audio.m4a' }], truncated: false });
    function Harness() {
      const { route } = useRoute();
      return route.name === 'firm' ? <div data-testid="opened-firm">{route.firmId}</div> : <MeetingRecoveryQueue read={read} ports={portsFor()} />;
    }
    try {
      render(<Harness />);
      fireEvent.click(await screen.findByRole('link', { name: 'Example Rentals' }));
      expect(await screen.findByTestId('opened-firm')).toHaveProperty('textContent', RID(9));
    } finally {
      cleanup(); globalThis.callie = previous; setNavigator(() => undefined, () => undefined); history.replaceState(null, '', hash || '#today');
    }
  });
  it('an older Today read cannot restore an item after successful recovery', async () => {
    const items = [{ recordingId: RID(1), meetingId: MID, firmId: RID(9), firmName: 'Example Rentals', participantLabel: 'audio.m4a' }];
    let finish!: () => void;
    const read = vi.fn().mockResolvedValueOnce({ items, truncated: false }).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ items, truncated: false }); }));
    vi.useFakeTimers();
    await act(async () => { render(<MeetingRecoveryQueue read={read} ports={portsFor()} />); });
    const button = screen.getByRole('button', { name: 'Reupload audio' });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    await act(async () => { fireEvent.click(button); });
    await act(async () => { finish(); });
    expect(screen.queryByRole('button', { name: 'Reupload audio' })).toBeNull();
  });
  it('zero_allowance_is_clear and cannot accidentally enable spending', () => {
    const save = vi.fn(); render(<MeetingTranscriptionSection setting={DEFAULT_MEETING_TRANSCRIPTION} spentTodayCents={0} editable busy={false} onSave={save} />);
    expect(screen.getByText(/Set a daily meeting allowance/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Transcribe demo meetings' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Meeting transcription dollars per day'), { target: { value: '0.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save meeting allowance' }));
    expect(save).toHaveBeenCalledWith({ ...DEFAULT_MEETING_TRANSCRIPTION, dailyCeilingCents: 50 });
  });
});
