import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256Utf8 } from '../../src/shared/crypto/sha256';

it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
])('matches standard SHA256 vector %j', (input, expected) => {
  expect(sha256Utf8(input)).toBe(expected);
});
it('matches independent Node SHA256 across UTF8, surrogate replacement and padding boundaries', () => {
  expect(typeof TextEncoder).toBe('function');
  const lengths = [...Array.from({ length: 260 }, (_, i) => i), 511, 512, 513, 1023, 1024, 1025, 2047, 2048, 4095];
  const patterns = ['x', '\0', 'é', '漢', '🦎', 'e\u0301', '\ud800', '\udc00', 'a\ud800b\udc00'];
  for (const pattern of patterns) for (const length of lengths) {
    const input = pattern.repeat(length);
    expect(sha256Utf8(input), `${JSON.stringify(pattern)} × ${length}`).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
  }
});
