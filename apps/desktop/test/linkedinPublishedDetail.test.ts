/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {linkedInPublishedDetailScript} from '../src/main/social/adapters/linkedinPublishedDetail.ts';
afterEach(()=>{document.body.innerHTML='';});
function run(){return new Function('document',`return ${linkedInPublishedDetailScript()}`)(document);}
function fixture(){document.body.innerHTML=`<main aria-label="Feed detail update"><a aria-label="Go to boost post page" href="https://www.linkedin.com/ad-beta/boost/campaigns/new/details?content=urn%3Ali%3Ashare%3A123&origin=memberPostDetails">Boost</a><div role="article" data-urn="urn:li:activity:456"><a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/founder?miniProfileUrn=example">Founder</a><div class="update-components-update-v2__commentary"><span>Hello<br><br>World</span></div><article data-id="comment"><div>Comment is not post text</div></article></div></main>`;}
it('reads distinct scheduled-share and published-activity IDs without inferring time',()=>{fixture();expect(run()).toEqual({ok:true,view:{shareId:'urn:li:share:123',activityId:'urn:li:activity:456',authorExternalId:'https://www.linkedin.com/in/founder/',text:'Hello\n\nWorld',permalink:'https://www.linkedin.com/feed/update/urn:li:activity:456/',publishedAt:null}});});
it('requires a single authoritative share mapping and a single post',()=>{fixture();document.querySelector('a')!.remove();expect(run()).toEqual({ok:false});fixture();document.querySelector('main')!.append(document.querySelector('[role="article"]')!.cloneNode(true));expect(run()).toEqual({ok:false});});
it('rejects a foreign mapping or non-profile author',()=>{fixture();document.querySelector('a')!.setAttribute('href','https://evil.test/ad-beta/boost/campaigns/new/details?content=urn:li:share:123');expect(run()).toEqual({ok:false});fixture();document.querySelector('.update-components-actor__meta-link')!.setAttribute('href','https://www.linkedin.com/company/other');expect(run()).toEqual({ok:false});});
it('does not certify media or collapsed text as a full text-only publication',()=>{fixture();document.querySelector('[role="article"]')!.innerHTML+='<div class="feed-shared-update-v2__content"><img alt=""></div>';expect(run()).toEqual({ok:false});fixture();document.querySelector('.update-components-update-v2__commentary')!.innerHTML+='<button>… more</button>';expect(run()).toEqual({ok:false});});

it('checks loaded image count on a published receipt without comparing image bytes',()=>{
 fixture();document.querySelector('[role="article"]')!.innerHTML+='<div class="feed-shared-update-v2__content"><img src="https://media.licdn.com/image" alt=""></div>';
 const inspect=()=>new Function('document',`return ${linkedInPublishedDetailScript(1)}`)(document);
 expect(inspect()).toEqual({ok:false});
 Object.defineProperties(document.querySelector('img')!,{complete:{value:true},naturalWidth:{value:100}});
 expect(inspect()).toMatchObject({ok:true,view:{shareId:'urn:li:share:123'}});
 document.querySelector('.feed-shared-update-v2__content')!.innerHTML+=' <img src="https://media.licdn.com/extra">';
 expect(inspect()).toEqual({ok:false});
});
