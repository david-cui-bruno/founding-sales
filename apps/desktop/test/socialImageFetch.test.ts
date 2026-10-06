import {it,expect} from 'vitest';import {fetchSocialImage} from '../src/main/social/imageFetch.ts';
it('pins the checked address and rechecks redirects instead of reaching a private destination',async()=>{
 const seen:string[]=[];await expect(fetchSocialImage('https://images.example/photo.png',{lookup:async host=>host==='private.example'?['127.0.0.1']:['93.184.216.34'],request:async input=>{seen.push(input.address);return {status:302,location:'https://private.example/private',contentType:'',body:Buffer.alloc(0)};}})).rejects.toThrow('image_host_not_public');expect(seen).toEqual(['93.184.216.34']);
});
it('refuses mixed public/private DNS, non-HTTPS, oversize data and executable formats',async()=>{
 let calls=0;const request=async()=>{calls++;return {status:200,location:null,contentType:'image/png',body:Buffer.from('fixture')};};
 await expect(fetchSocialImage('https://images.example/a',{lookup:async()=>['93.184.216.34','10.0.0.1'],request})).rejects.toThrow('image_host_not_public');
 await expect(fetchSocialImage('http://images.example/a',{request})).rejects.toThrow('invalid_image_url');expect(calls).toBe(0);
 await expect(fetchSocialImage('https://images.example/a',{lookup:async()=>['93.184.216.34'],request:async()=>({status:200,location:null,contentType:'image/svg+xml',body:Buffer.from('<svg/>')})})).rejects.toThrow('unsupported_image');
 await expect(fetchSocialImage('https://images.example/a',{lookup:async()=>['93.184.216.34'],request:async()=>({status:200,location:null,contentType:'image/png',body:Buffer.alloc(21*1024*1024)})})).rejects.toThrow('image_too_large');
});
