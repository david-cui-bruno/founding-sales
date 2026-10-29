import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
import type {SeededCrm} from './crmFixtures.ts';
type Fixture={session:SessionQueryable;seeded:TwoWorkspaces;crm:SeededCrm};
type Row=Record<string,unknown>;
/** Both cases name actual pg_constraint entries. No catalog exemption or fake
 * coverage label is used for the immutable native-policy constraint trigger. */
export function currentUSSupplyCases(
 publication:(fixture:Fixture)=>Promise<Row>,
 insert:(fixture:Fixture,table:string,row:Row)=>Promise<unknown>,
){
 return [
  {constraint:'automatic_research_native_policy_supported',run:async(fixture:Fixture)=>
   insert(fixture,'sourcing_automatic_research_firms',{...await publication(fixture),native_policy_version:'unknown'})},
  {constraint:'automatic_research_native_policy_immutable',run:async(fixture:Fixture)=>{
   const row=await publication(fixture);
   await insert(fixture,'sourcing_automatic_research_firms',row);
   return fixture.session.query(`UPDATE sourcing_automatic_research_firms
    SET native_policy_version='native-firm-eligibility-us-v1',revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[row['workspace_id'],row['id']]);
  }},
 ];
}
