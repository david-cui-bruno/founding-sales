import { describe, expect, it } from 'vitest';
import {
  createRendererTrust,
  isApprovedExternalUrl,
  isTrustedRendererUrl,
} from '../../src/main/navigationPolicy';

describe('navigation policy', () => {
  it('allows only the packaged renderer origin', () => {
    expect(isTrustedRendererUrl('callie://app/index.html')).toBe(true);
    expect(isTrustedRendererUrl('https://attacker.example')).toBe(false);
  });

  it('allows founder-initiated external links only over HTTPS', () => {
    expect(isApprovedExternalUrl('https://docs.google.com/document/d/1')).toBe(
      true,
    );
    expect(isApprovedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isApprovedExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('allows only the exact configured Vite entry in unpackaged development', () => {
    const trust = createRendererTrust({
      isPackaged: false,
      developmentRendererUrl: 'http://localhost:5173',
    });

    expect(trust.rendererUrl).toBe('http://localhost:5173/');
    expect(trust.isTrustedRendererUrl('callie://app/index.html')).toBe(true);
    expect(trust.isTrustedRendererUrl('http://localhost:5173/')).toBe(true);
    expect(trust.isTrustedRendererUrl('http://localhost:5173/index.html')).toBe(
      false,
    );
    expect(trust.isTrustedRendererUrl('http://localhost:5174/')).toBe(false);
    expect(trust.isTrustedRendererUrl('http://127.0.0.1:5173/')).toBe(false);
  });

  it('fails closed to callie when development is malformed or packaged', () => {
    const malformed = createRendererTrust({
      isPackaged: false,
      developmentRendererUrl: 'http://localhost:5173/lookalike',
    });
    const packaged = createRendererTrust({
      isPackaged: true,
      developmentRendererUrl: 'http://localhost:5173',
    });

    expect(malformed.rendererUrl).toBe('callie://app/index.html');
    expect(malformed.isTrustedRendererUrl('http://localhost:5173/')).toBe(false);
    expect(packaged.rendererUrl).toBe('callie://app/index.html');
    expect(packaged.isTrustedRendererUrl('http://localhost:5173/')).toBe(false);
  });
});
