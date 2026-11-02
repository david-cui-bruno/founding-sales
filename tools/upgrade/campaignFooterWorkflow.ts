import assert from 'node:assert/strict';
import {SENDING_STOP_LINE} from '@fss/contracts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {FixtureHandles} from './fixture.ts';

export const CAMPAIGN_FOOTER_UPGRADE_WORKFLOW='outbound.campaignOpening footer rebuild (0157, runtime role)';
const COMPANY_LINE='Callie, AI maintenance coordination';

/** The replaced `campaign_opening_footer_body`, called as `app_runtime` on the surviving approved template:
 * a body ending in the previous sign-off-only block is rebuilt to sign-off, company line, stop sentence,
 * the recorded postal address (when one exists) riding the company line, and every byte above it kept. */
export async function runCampaignFooterUpgradeWorkflow(session:SessionQueryable,handles:FixtureHandles):Promise<string>{
 assert(handles.templateVersionId,'the deployed fixture must retain its approved template');
 const signOff=(await session.query<{footer_sign_off:string}>('SELECT footer_sign_off FROM template_versions WHERE workspace_id=$1 AND id=$2',[handles.workspaceId,handles.templateVersionId])).rows[0]?.footer_sign_off.trim();
 assert(signOff,'the surviving template carries its footer sign-off');
 const address=(await session.query<{address:string|null}>("SELECT nullif(btrim(value->>'address',E' \\t\\n\\r'),'') AS address FROM workspace_settings WHERE workspace_id=$1 AND setting_key='postal_address' AND superseded_at IS NULL",[handles.workspaceId])).rows[0]?.address??null;
 const expected=`${signOff}\n${COMPANY_LINE}${address===null?'':` \u00b7 ${address}`}\n${SENDING_STOP_LINE}`;
 const rebuild=async(body:string)=>(await session.query<{body:string|null}>('SELECT campaign_opening_footer_body($1,$2,$3) AS body',[handles.workspaceId,handles.templateVersionId,body])).rows[0]?.body??null;
 assert.equal(await rebuild(`Hello.\n\nOne question about your properties.\n\n${signOff}`),`Hello.\n\nOne question about your properties.\n\n${expected}`);
 assert.equal(await rebuild(signOff),expected);
 assert.equal(await rebuild('Hello.\n\nNo recognised footer block.'),null,'an unrecognised footer is refused, never rewritten');
 return `sign-off-only block rebuilt to the ${address===null?'address-free':'addressed'} company/stop footer; bytes above it kept; unrecognised footer refused`;
}
