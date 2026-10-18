import {expect,test} from 'playwright/test';
import {socialPostMutationSchema,type SocialWorkspace} from '@fss/contracts';
import {startAppServer} from './support/appServer.ts';

test('keeps explicit manual social drafting in the real shell without recurring posting controls',async({page})=>{
 const id='11111111-1111-4111-8111-111111111111',postId='22222222-2222-4222-8222-222222222222';
 let view:SocialWorkspace={accounts:[{id,platform:'linkedin',displayName:'Fixture profile',externalId:'fixture',accountKind:'profile',state:'connected',adapterVersion:'fixture-v1',verifiedAt:null}],posts:[]};
 const mutations:unknown[]=[];
 const server=await startAppServer({operations:{
  'social.workspace':()=>({view,reason:null}),
  'social.drafts':()=>({view:null,reason:'not_configured'}),
  'social.weekly':()=>({view:null,reason:'not_configured'}),
  'social.mutate':argument=>{
   const input=socialPostMutationSchema.parse(argument);mutations.push(input);
   if(input.action!=='save')throw new Error('Only an explicit draft save is permitted');
   view={...view,posts:[{postId,revision:1,accountId:input.accountId,text:input.text,images:input.images,publishAt:input.publishAt,zone:input.zone,state:'draft',reason:null}]};
   return {accepted:true,view,reason:null};
  },
 }});
 try{
  await page.goto(server.url('#social'));
  await page.getByRole('button',{name:'New post',exact:true}).click();
  await page.getByLabel('Post text',{exact:true}).fill('A practical manual observation for business relationships.');
  await page.getByTestId('nav-firms').click();
  await page.getByTestId('nav-social').click();
  await expect(page.getByLabel('Post text',{exact:true})).toHaveValue('A practical manual observation for business relationships.');
  await expect(page.getByRole('heading',{name:/recurring/i})).toHaveCount(0);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.getByText('A practical manual observation for business relationships.',{exact:true})).toBeVisible();
  expect(mutations).toEqual([expect.objectContaining({action:'save',accountId:id,publishAt:null})]);
  await expect(page.getByRole('button',{name:'Approve & schedule',exact:true})).toBeDisabled();
 }finally{await server.stop();}
});
