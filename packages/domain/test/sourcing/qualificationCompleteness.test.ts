import {expect,it} from 'vitest';
import {parsePageText,MAX_BLOCKS,MAX_TEXT_CHARACTERS} from '../../research/pageText.ts';
import {qualificationCitationRoles} from '../../sourcing/qualificationCitationRoles.ts';
const parse=(html:string)=>parsePageText(new TextEncoder().encode(html),'text/html',{omitNavigation:true,includeArticles:true});
it('retains original structural citation targets and truthfully marks count overflow, never packs office cards',()=>{
 const html=Array.from({length:MAX_BLOCKS+1},(_,i)=>`<p>Original section ${i}</p>`).join('');
 const page=parse(html);expect(page.truncated).toBe(true);expect(page.blocks).toHaveLength(MAX_BLOCKS);
 expect(page.blocks[0]).toEqual({id:'b1',text:'Original section 0'});expect(page.blocks[99]).toEqual({id:'b100',text:'Original section 99'});
 expect(page.blocks.some(b=>b.text.includes('section 100'))).toBe(false);
});
it('does not promote retained fragments of a truncated page into complete positive evidence',()=>{
 const candidate={firmName:'Harbor Example Management',locality:'Boston',region:'MA' as const,website:'https://harbor.example.test/'};
 const html=`<p>${candidate.firmName}</p><p>${candidate.firmName} manages residential homes in Boston, MA.</p>`+Array.from({length:100},(_,i)=>`<p>Section ${i}</p>`).join('');
 const page=parse(html);expect(page.truncated).toBe(true);
 const source={id:'11111111-1111-4111-8111-111111111111',url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-18T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,blocks:[...page.blocks],truncated:page.truncated};
 expect(qualificationCitationRoles(candidate,[],[source])).toEqual({ok:true,facts:[]});
});
it('retains whole blocks within existing bounds and truthfully marks character overflow',()=>{
 const complete=parse('<p>Harbor Example Management</p><p>Boston, MA</p><p>617-555-0190</p>');
 expect(complete.truncated).toBe(false);expect(complete.blocks.map(b=>b.text)).toEqual(['Harbor Example Management','Boston, MA','617-555-0190']);
 expect(parse(`<p>${'x'.repeat(MAX_TEXT_CHARACTERS+1)}</p>`).truncated).toBe(true);
});
