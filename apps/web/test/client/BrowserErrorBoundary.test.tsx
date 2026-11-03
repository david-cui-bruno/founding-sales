// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BrowserErrorBoundary } from '../../src/client/BrowserErrorBoundary.tsx';

afterEach(cleanup);

describe('browser render error boundary', () => {
  it('replaces a failed render with recovery UI without exposing exception content', () => {
    const error = new TypeError('private fixture value');
    function BrokenView(): never {
      throw error;
    }
    render(<BrowserErrorBoundary><BrokenView /></BrowserErrorBoundary>);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(error.message)).toBeNull();
  });

});
