import {expect,it} from 'vitest';
import {phoneDiscoveryDiagnostic} from '../../sourcing/phoneDiscoveryDiagnostic.ts';
it('keeps bounded closed counters and excludes arbitrary provider metadata',()=>{
 const result=phoneDiscoveryDiagnostic('empty_pages','parse',Infinity,{
  robots_disallowed:3,address_not_public:1001,request_failed:-1,paused:1.5,
  status_403:2,status_404:4,status_500:1001,status_503:2,
  'https://private.invalid/path?token=secret':1,error_message:9,status_999:3,
 });
 expect(result).toEqual({branch:'empty_pages',stage:'parse',pages:0,skipped:{address_not_public:1000,robots_disallowed:3,http_4xx:6,http_5xx:1000}});
 expect(JSON.stringify(result)).not.toMatch(/private|token|secret|message|999/);
});
