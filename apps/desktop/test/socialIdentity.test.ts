/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {readLinkedInIdentity,readLinkedInIdentityDetailed} from '../src/main/social/identity.ts';
afterEach(()=>{document.body.innerHTML='';});
function profile(name='Example Founder',slug='example-founder'){return `<a href="https://www.linkedin.com/in/${slug}/"><p>Premium</p><svg aria-label="${name}"></svg><img alt="${name}"></a><a href="https://www.linkedin.com/in/${slug}/"><div aria-label="${name}, Founder"><p>${name}</p><p>Founder</p></div></a>`;}
const url='https://www.linkedin.com/feed/';
it('reads only the own-profile sidebar, ignoring feed authors and company management links',()=>{
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile()}<a href="https://www.linkedin.com/company/123/admin/">Company</a></aside><main>${profile('Someone Else','someone-else')}</main>`;
 expect(readLinkedInIdentity(document,url)).toEqual({platform:'linkedin',externalAccountId:'https://www.linkedin.com/in/example-founder/',displayName:'Example Founder',accountKind:'profile'});
});
it('rejects missing, ambiguous, or mismatched identity evidence',()=>{
 for(const html of [profile(),`<aside aria-label="Sidebar">${profile()}${profile('Other','other')}</aside>`,`<aside aria-label="Sidebar">${profile().replace('alt="Example Founder"','alt="Different"')}</aside>`,`<aside aria-label="Sidebar">${profile()}</aside><aside aria-label="Sidebar">${profile()}</aside>`]){
 document.body.innerHTML=html;expect(readLinkedInIdentity(document,url)).toBeNull();
 }
});
it('does not accept login, another host, credentials, or unsafe profile URLs',()=>{
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile()}</aside>`;
 for(const wrong of ['https://www.linkedin.com/login','https://www.linkedin.com.evil.test/feed/','http://www.linkedin.com/feed/','https://user@www.linkedin.com/feed/'])expect(readLinkedInIdentity(document,wrong)).toBeNull();
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile().replaceAll('www.linkedin.com/in','evil.test/in')}</aside>`;
 expect(readLinkedInIdentity(document,url)).toBeNull();
});
it('ignores hidden account landmarks and rejects malformed names',()=>{
 document.body.innerHTML=`<aside aria-label="Sidebar" hidden>${profile()}</aside>`;expect(readLinkedInIdentity(document,url)).toBeNull();
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile('x'.repeat(201))}</aside>`;expect(readLinkedInIdentity(document,url)).toBeNull();
});

it('survives serialization into an isolated browser world without module dependencies',()=>{
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile()}</aside>`;
 const serialized=new Function('document','pageUrl',`return (${readLinkedInIdentityDetailed.toString()})(document,pageUrl)`);
 expect(serialized(document,url)).toEqual(readLinkedInIdentity(document,url));
});
it('reads the same sidebar while the native composer is open without navigating away',()=>{document.body.innerHTML=`<aside aria-label="Sidebar">${profile()}</aside><dialog open></dialog>`;expect(readLinkedInIdentity(document,'https://www.linkedin.com/sharing/compose')).toMatchObject({externalAccountId:'https://www.linkedin.com/in/example-founder/'});});
it('classifies missing or ambiguous own-profile evidence without returning names or URLs',()=>{
 document.body.innerHTML='';expect(readLinkedInIdentityDetailed(document,url)).toEqual({reason:'identity_sidebar_unavailable'});
 document.body.innerHTML='<aside aria-label="Sidebar"></aside><aside aria-label="Sidebar"></aside>';expect(readLinkedInIdentityDetailed(document,url)).toEqual({reason:'identity_sidebar_ambiguous'});
 document.body.innerHTML='<aside aria-label="Sidebar"></aside>';expect(readLinkedInIdentityDetailed(document,url)).toEqual({reason:'identity_profile_unavailable'});
 document.body.innerHTML=`<aside aria-label="Sidebar">${profile()}${profile('Other','other')}</aside>`;expect(readLinkedInIdentityDetailed(document,url)).toEqual({reason:'identity_profile_ambiguous'});
});
