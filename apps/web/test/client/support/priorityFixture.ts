import {manualProspectListSchema,prospectPriorityReviewSchema} from '@fss/contracts';
/** Current-list envelope for existing controlled raw-observation regression fixtures. */
export function priorityFixturePage(raw:unknown):unknown{
 const page=manualProspectListSchema.parse(raw);
 const priority=prospectPriorityReviewSchema.parse({policyVersion:'prospect-priority-v1',band:'ordinary',fit:'unknown',value:'unknown',timing:'unknown',roles:[],roleState:'unknown',roleCandidates:[],roleCandidatesHasMore:false,nextAction:'review_fit',assessmentRevision:0,lastConsideredAt:null,consideredCount:0,reasons:[]});
 return {prospects:page.prospects.map(prospect=>({prospect,priority})),hasMore:page.hasMore,viewRevision:'a'.repeat(64)};
}
export async function priorityFixtureResponse(response:Response):Promise<Response>{return Response.json(priorityFixturePage(await response.json()),{status:response.status});}
