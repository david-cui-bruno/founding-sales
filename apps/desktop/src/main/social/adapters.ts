import type {SocialPlatform} from './runtime.ts';
export interface AccountIdentity {platform:SocialPlatform;externalId:string;displayName:string}
export interface ApprovedPost {
 deliveryId:string;postId:string;revision:number;account:AccountIdentity;text:string;
 images:{assetId:string;version:number;localPath:string;sha256:string;altText:string}[];
 publishAt:string;zone:string;fingerprint:string;
}
export interface InspectionResult {state:'scheduled'|'published'|'cancelled'|'absent'|'unknown';receiptId:string|null;permalink:string|null;observedAt:string;accountExternalId:string|null;observedFingerprint:string|null;complete:boolean}
export type SubmissionResult={kind:'scheduled';receiptId:string}|{kind:'not_submitted';reason:string}|{kind:'unknown'};
/** Implementations use fixed platform DOM actions. No model-authored selectors/code. */
export interface SocialAdapter {
 inspectAccount():Promise<AccountIdentity|null>;
 stage(input:ApprovedPost):Promise<{ready:boolean;reason?:string}>;
 /** Must recheck account, exact staged content/media/time and runtime epoch before click. */
 submit(input:ApprovedPost):Promise<SubmissionResult>;
 inspect(input:{receiptId:string|null;fingerprint:string}):Promise<InspectionResult>;
 cancel(receiptId:string):Promise<InspectionResult>;
}
