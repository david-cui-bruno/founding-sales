import {socialDeliveryQueueSchema,type SocialDeliveryQueue} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
/** Discovery is read-only; claim/begin revalidate approval under the post lock. */
export async function readSocialDeliveryQueue(ctx:RepositoryContext,deviceId:string):Promise<SocialDeliveryQueue>{
 const user=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;if(!user)return {items:[]};
 const rows=(await ctx.db.query(`SELECT d.id AS "deliveryId",d.post_id AS "postId",d.revision,
 CASE WHEN d.submission_id IS NULL THEN 'submit' WHEN d.state='cancellation_pending' THEN 'cancel' ELSE 'inspect' END AS action,
 d.submission_id AS "submissionId",d.receipt_id AS "receiptId",d.media_binding AS "mediaBinding",a.fingerprint,a.snapshot
 FROM social_deliveries d
 JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id
 JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id
 JOIN social_post_revisions r ON r.workspace_id=d.workspace_id AND r.post_id=d.post_id AND r.revision=d.revision
 JOIN social_accounts s ON s.workspace_id=r.workspace_id AND s.id=r.account_id AND s.owner_user_id=p.owner_user_id
 JOIN workspace_memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id AND m.status='active'
 JOIN devices v ON v.workspace_id=p.workspace_id AND v.user_id=p.owner_user_id AND v.id=$3 AND v.status='active'
 WHERE d.workspace_id=$1 AND p.owner_user_id=$2
 AND NOT EXISTS(SELECT 1 FROM social_post_revisions newer WHERE newer.workspace_id=d.workspace_id AND newer.post_id=d.post_id AND newer.revision>d.revision)
 AND ((d.submission_id IS NULL AND r.state='approved' AND s.state='connected' AND (d.state='pending' OR (d.state='preparing' AND d.claim_expires_at<=now())))
 OR (d.submission_id IS NOT NULL AND d.device_id=$3 AND s.state<>'disconnected' AND d.state IN ('submitting','scheduled','unknown','cancellation_pending') AND d.next_inspection_at<=now() AND d.inspection_deadline>now()))
 ORDER BY CASE WHEN d.state='cancellation_pending' THEN 0 WHEN d.submission_id IS NOT NULL THEN 1 ELSE 2 END,COALESCE(d.next_inspection_at,r.publish_at),d.id LIMIT 25`,[ctx.scope.workspaceId,user,deviceId])).rows;
 return socialDeliveryQueueSchema.parse({items:rows});
}
