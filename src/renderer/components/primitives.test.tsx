// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

afterEach(() => {
  cleanup();
});

describe('Button', () => {
  it('renders a real button and forwards clicks', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add company</Button>);

    const button = screen.getByRole('button', { name: 'Add company' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('supports quiet and danger variants without changing semantics', () => {
    render(
      <>
        <Button variant="quiet">Dismiss</Button>
        <Button variant="danger">Remove</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Add company
      </Button>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add company' }));

    expect(onClick).not.toHaveBeenCalled();
  });
});
