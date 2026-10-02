// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedBriefDto } from '@fss/contracts';
import { PreparedBrief } from '../src/renderer/research/PreparedBrief.tsx';

/**
 * Lane PB: the prepared brief on the firm page and the Today card — read-only since the
 * scope reduction after review PBR. The label, the https-only links and the fold; no editor
 * and no command.
 */

const BRIEF: PreparedBriefDto = {
  brief: 'Who to ask for: Pat Placeholder, Owner (confirmed)\nSoftware: appfolio\nDoors: 300',
  sources: [
    { url: 'https://firm.example.test/contact', label: 'Phone source' },
    { url: 'http://legacy.example.test/', label: 'Old page' },
  ],
  observedOn: '2026-10-02',
  preparedBy: 'Callie research agent (web), verified phones',
  updatedAt: '2026-10-02T15:00:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('the prepared brief, read-only', () => {
  it('says it is prepared research Callie did not verify, links https sources only, and offers nothing to change', () => {
    render(<PreparedBrief brief={BRIEF} />);
    expect(screen.getByTestId('prepared-brief-provenance').textContent).toBe('Prepared research · observed 2 Oct 2026 · not verified by Callie');
    expect(screen.getByTestId('prepared-brief-text').textContent).toBe(BRIEF.brief);
    const links = screen.getAllByTestId('prepared-brief-source');
    expect(links.map(link => link.getAttribute('href'))).toEqual(['https://firm.example.test/contact']);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(screen.getByTestId('prepared-brief-source-unlinked').textContent).toBe('Old page');
    // Read-only: the only control is a link or "Show more".
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Clear')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('folds a long brief behind Show more, and draws nothing for a firm with none or an older API', async () => {
    const user = userEvent.setup();
    const long = { ...BRIEF, brief: Array.from({ length: 9 }, (_, i) => `Line ${String(i + 1)}`).join('\n') };
    const { rerender } = render(<PreparedBrief brief={long} />);
    expect(screen.getByTestId('prepared-brief-text').className).toContain('line-clamp-6');
    await user.click(screen.getByTestId('prepared-brief-more'));
    expect(screen.getByTestId('prepared-brief-text').className).not.toContain('line-clamp-6');
    expect(screen.getByTestId('prepared-brief-more').textContent).toBe('Show less');
    rerender(<PreparedBrief brief={null} />);
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
    rerender(<PreparedBrief brief={undefined} />);
    expect(screen.queryByTestId('prepared-brief')).toBeNull();
  });
});
