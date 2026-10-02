// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplyModelState } from '../src/renderer/replyContract.ts';
import { createGeneration } from '../src/renderer/app/generation.ts';
import { ReplyModelSection } from '../src/renderer/settings/ReplyModelSection.tsx';

/**
 * Slice 3a, C0, item 8, on screen: an admin sees the model now, picks the other, saves,
 * and the answer appears beside the control. A salesperson sees no section at all.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { callieApi?: unknown }).callieApi = undefined;
});

const model = (modelName: string, notice: string | null = null): ReplyModelState => ({
  classifier: { enabled: true, modelName, effort: 'low' },
  online: true,
  mayMutate: true,
  notice,
});

function install(read: ReplyModelState, save: (input: unknown) => ReplyModelState) {
  const calls: { name: string; input: unknown }[] = [];
  (globalThis as { callieApi?: unknown }).callieApi = {
    read: async (name: string) => {
      calls.push({ name, input: null });
      return await Promise.resolve(read);
    },
    command: async (name: string, input: unknown) => {
      calls.push({ name, input });
      return await Promise.resolve(save(input));
    },
  };
  return calls;
}

function mount(isAdmin: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReplyModelSection isAdmin={isAdmin} identity="admin@example.test" generation={0} guard={createGeneration().guard} />
    </QueryClientProvider>,
  );
}

describe('Settings › Reply suggestions', () => {
  it('names the current model in words, and saves the other through the one command', async () => {
    const calls = install(model('claude-opus-5'), () => model('claude-haiku-4-5-20251001', 'reply_model_saved'));
    mount(true);
    await waitFor(() => expect(screen.getByTestId('reply-model-current').textContent).toBe('Model now: Opus 5 (direct API)'));
    // Nothing to save until the choice differs.
    expect((screen.getByTestId('reply-model-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reply-model-select'), { target: { value: 'claude-haiku-4-5-20251001' } });
    fireEvent.click(screen.getByTestId('reply-model-save'));
    await waitFor(() => expect(screen.getByTestId('reply-model-notice').textContent).toBe('Saved.'));
    expect(screen.getByTestId('reply-model-current').textContent).toBe('Model now: Haiku 4.5 (AWS credits)');
    // The model name alone: the effort and the caps are not on offer and are never sent.
    expect(calls.find(call => call.name === 'replies.saveModel')?.input).toEqual({ modelName: 'claude-haiku-4-5-20251001' });
    expect(screen.queryByText(/effort/iu)?.tagName).not.toBe('SELECT');
  });

  it('shows a refusal beside the control and keeps the model that is stored', async () => {
    install(model('claude-opus-5'), () => model('claude-opus-5', 'admin_only'));
    mount(true);
    await waitFor(() => screen.getByTestId('reply-model-select'));
    fireEvent.change(screen.getByTestId('reply-model-select'), { target: { value: 'claude-haiku-4-5-20251001' } });
    fireEvent.click(screen.getByTestId('reply-model-save'));
    await waitFor(() => expect(screen.getByTestId('reply-model-notice').textContent).toBe('Only an admin may change the model.'));
    expect(screen.getByTestId('reply-model-current').textContent).toBe('Model now: Opus 5 (direct API)');
  });

  it('is absent for anyone who is not an admin, and asks nothing', () => {
    const calls = install(model('claude-opus-5'), () => model('claude-opus-5'));
    mount(false);
    expect(screen.queryByTestId('reply-model')).toBeNull();
    expect(calls).toEqual([]);
  });
});
