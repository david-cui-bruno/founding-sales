import { describe, expect, it } from 'vitest';
import {
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
});
