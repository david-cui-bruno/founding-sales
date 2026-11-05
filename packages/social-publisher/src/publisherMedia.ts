export interface PublisherMediaIdentity {workspaceId:string;attemptId:string;sha256:string}
/** Public identifiers only; the API independently fences every approved derivative read. */
export function publisherMediaURL(origin:string,input:PublisherMediaIdentity):string {
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
 if(!uuid.test(input.workspaceId)||!uuid.test(input.attemptId)||!/^[0-9a-f]{64}$/u.test(input.sha256))throw new Error('publisher_media_identity_invalid');
 return `${origin}/social/publisher/media/${input.workspaceId}/${input.attemptId}/${input.sha256}`;
}
