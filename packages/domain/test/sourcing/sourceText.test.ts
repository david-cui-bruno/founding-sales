import {it,expect} from 'vitest';
import {parsePageText} from '../../research/pageText.ts';
const text=(html:string)=>parsePageText(new TextEncoder().encode(html),'text/html');
it('does not let JavaScript comparisons swallow following page text',()=>{
 expect(text('<script>if (a < b) run();</script><p>Call our manager.</p>').text).toBe('Call our manager.');
 expect(text('<style>.a:before{content:"<"}</style><p>Visible</p>').text).toBe('Visible');
});
it('decodes visible entities after markup parsing, without executing encoded tags',()=>{
 expect(text('<p>Repairs &amp; maintenance&nbsp; &lt;script&gt; &#x26;</p>').text).toBe('Repairs & maintenance <script> &');
 expect(text('<script>broken <p>Hidden</p>').text).toBe('');
 expect(text('<article><p>Quoted elsewhere</p></article><p>Firm says this</p>').text).toBe('Firm says this');
});
it('decodes once and replaces invalid Unicode scalar references',()=>{
 expect(text('<p>&#38;lt;script&#38;gt;</p>').text).toBe('&lt;script&gt;');
 expect(text('<p>&#xD800; &#0; &#x110000;</p>').text).toBe('� � �');
});
