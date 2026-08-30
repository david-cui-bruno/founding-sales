import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the foundation title and status', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Callie Founder Sales System');
    expect(markup).toContain('Foundation initializing');
  });
});
