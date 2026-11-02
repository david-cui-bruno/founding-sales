import {expect,it} from 'vitest';
import {guessAddress,verdictCredits,type AddressVerdict} from '../../outreach/addressGuess.ts';

// ADR0038: the one guess is `first@host`, the person's real first name in lowercase ASCII, at the company's own host and nowhere else.
it.each([
 ['Ryan','ryan'],['JORDAN','jordan'],['Zoë','zoe'],['José','jose'],['Renée','renee'],['Ångström','angstrom'],
])('writes %s as %s@host: lowercased, diacritics stripped',(first,local)=>{
 expect(guessAddress(first,'peak.org')).toBe(`${local}@peak.org`);
});
it.each([
 ['an initial','J'],['a hyphenated name','Jean-Luc'],['two words','Mary Ann'],['an apostrophe',"D'Arcy"],['a dotted initial','J.'],['a digit','Jo3'],['surrounding space',' Tyler '],
 ['a letter ASCII cannot spell','Łukasz'],['an empty name',''],['a name of marks only','\u0301'],['an overlong name','a'.repeat(41)],
])('refuses %s (%s): never repaired, never a second pattern',(_label,first)=>{
 expect(guessAddress(first,'peak.org')).toBeNull();
});
it('refuses a role mailbox, a consumer domain and a host that is not a mail domain, and only ever builds first@host',()=>{
 expect(guessAddress('Info','peak.org')).toBeNull();expect(guessAddress('Office','peak.org')).toBeNull();
 expect(guessAddress('Ryan','gmail.com')).toBeNull();expect(guessAddress('Ryan','localhost')).toBeNull();expect(guessAddress('Ryan','10.0.0.1')).toBeNull();
 expect(guessAddress('Ryan','Peak.Org')).toBe('ryan@peak.org');
 for(const first of ['Ryan','Jordan','Amy'])expect(guessAddress(first,'peak.org')).toMatch(/^[a-z]+@peak\.org$/u);
});
it('charges one credit for ok, invalid and disposable and nothing for catch_all and unknown (R3 measured the first four; disposable is charged, conservatively)',()=>{
 const credits=Object.fromEntries((['ok','catch_all','unknown','invalid','disposable'] as AddressVerdict[]).map(verdict=>[verdict,verdictCredits(verdict)]));
 expect(credits).toEqual({ok:1,catch_all:0,unknown:0,invalid:1,disposable:1});
});
