import {expect,it} from 'vitest';
import {parsePageText} from '../../research/pageText.ts';
it('reads an ordinary article-wrapped contact page while excluding quotations and hidden instructions',()=>{
 const body=new TextEncoder().encode('<article><h1>Contact RentProv Realty</h1><p>admin@rentprovrealty.com</p><p>Providence RI</p><blockquote>Fabricated review address: fake@example.test</blockquote><div hidden>hidden@example.test</div><script>secret@example.test</script><form>form@example.test</form></article>');
 const parsed=parsePageText(body,'text/html',{omitNavigation:true,includeArticles:true});
 expect(parsed.text).toContain('admin@rentprovrealty.com');
 for(const excluded of ['fake@example.test','hidden@example.test','secret@example.test','form@example.test'])expect(parsed.text).not.toContain(excluded);
 expect(parsePageText(body,'text/html').text).not.toContain('admin@rentprovrealty.com');
});
