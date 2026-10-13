export interface BookingCreateCall {
 readonly submissionId:string;
 readonly eventTypeId:number;
 readonly accountId:number;
 readonly organizerEmail:string;
 readonly startsAt:string;
 readonly attendee:{readonly name:string;readonly email:string;readonly timeZone:string};
}
/** Deliberately excludes calendar descriptions and unrelated booking fields. */
export interface BookingCreateEvidence {
 readonly uid:string;readonly id:number;readonly eventTypeId:number;readonly accountId:number;
 readonly organizerEmail:string;readonly attendeeEmail:string;readonly startsAt:string;
 readonly endsAt:string;readonly updatedAt:string;readonly submissionId:string;
}
export type BookingCreateObservation = {readonly state:'accepted'|'pending';readonly booking:BookingCreateEvidence}|{readonly state:'failed'|'unknown';readonly reason:string};
export interface BookingCreateAvailability {
 readonly eventTypeId:number;readonly startsAt:string;
 readonly calendars:readonly {readonly credentialId:number;readonly externalId:string}[];
}
export interface BookingCreateProvider {
 inspect(input:BookingCreateCall):Promise<BookingCreateObservation>;
 availability(input:BookingCreateAvailability):Promise<{readonly available:boolean;readonly reason:string|null}>;
 create(input:BookingCreateCall):Promise<BookingCreateObservation>;
}
