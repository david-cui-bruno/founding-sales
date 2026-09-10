// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PresentationRoot } from './PresentationRoot';

afterEach(cleanup);

it('keeps one fixed presentation ancestor and child editor identity across descendant changes', () => {
  const view = (mode: string) => <PresentationRoot><section data-workflow-mode={mode}><input aria-label="Draft" defaultValue="Saved draft" /></section><aside>Sibling surface</aside></PresentationRoot>;
  const { container, rerender } = render(view('meeting_first'));
  const root = container.querySelector('.presentation-root')!;
  expect(root.getAttribute('data-presentation')).toBe('native-a');
  expect(root.hasAttribute('data-workflow-mode')).toBe(false);
  const editor = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(editor, { target: { value: 'Unsubmitted draft' } });
  editor.focus();
  editor.setSelectionRange(3, 7);
  for (const mode of ['pending', 'legacy', 'unknown']) {
    rerender(view(mode));
    expect(container.querySelectorAll('.presentation-root')).toHaveLength(1);
    expect(container.firstElementChild).toBe(root);
    expect(root.contains(screen.getByText('Sibling surface'))).toBe(true);
    expect(screen.getByRole('textbox')).toBe(editor);
    expect(editor.value).toBe('Unsubmitted draft');
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 7]);
  }
});
