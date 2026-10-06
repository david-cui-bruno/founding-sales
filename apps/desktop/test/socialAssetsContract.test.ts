import {expect,it} from 'vitest';
import {socialAssetLibrarySchema} from '@fss/contracts';
it('accepts asset metadata but rejects object keys and signed URLs at the renderer boundary',()=>{
 const asset={id:'11111111-1111-4111-8111-111111111111',state:'ready',version:1,origin:{kind:'upload',sourceUrl:null,usageNote:null},objects:[{version:1,kind:'derivative',state:'ready',sha256:'a'.repeat(64),bytes:100,mime:'image/png',width:20,height:20}]};
 expect(socialAssetLibrarySchema.safeParse({assets:[asset]}).success).toBe(true);
 expect(socialAssetLibrarySchema.safeParse({assets:[{...asset,object_key:'private/key'}]}).success).toBe(false);
 expect(socialAssetLibrarySchema.safeParse({assets:[{...asset,objects:[{...asset.objects[0],url:'https://private.example/signed'}]}]}).success).toBe(false);
});
