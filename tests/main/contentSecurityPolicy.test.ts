import { describe, expect, it } from 'vitest';
import { developmentContentSecurityPolicy } from '../../src/main/contentSecurityPolicy';

describe('developmentContentSecurityPolicy', () => {
  it('limits HMR connections to the fixed Vite endpoint', () => {
    const connectSource = developmentContentSecurityPolicy
      .split('; ')
      .find((directive) => directive.startsWith('connect-src'));

    expect(connectSource).toBe("connect-src 'self' ws://localhost:5173");
  });
});
