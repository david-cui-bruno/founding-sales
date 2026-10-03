import { uuid } from '@fss/contracts';
import { readMeetingTranscript, MeetingTranscriptChangedError, MeetingTranscriptCursorError } from '@fss/domain/meetings/transcripts.ts';
import { contextForPrincipal, requirePrincipal } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';
export const MEETING_TRANSCRIPTION_PATHS: readonly string[] = ['/meetings/transcript'];
export async function routeMeetingTranscription(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
    if (!MEETING_TRANSCRIPTION_PATHS.includes(request.path))
        return null;
    if (options.auth === undefined)
        return { status: 404, body: { error: 'not_found' } };
    if (request.method !== 'GET')
        return { status: 405, body: { error: 'method_not_allowed' } };
    const auth = await requirePrincipal(options.auth, request);
    if (!auth.ok)
        return auth.result;
    const scoped = contextForPrincipal(options.auth, auth.principal);
    if (!scoped.ok)
        return scoped.result;
    const meetingId = uuid.safeParse(request.query?.get('meetingId'));
    const cursor = request.query?.get('cursor') ?? undefined;
    if (!meetingId.success || (cursor?.length ?? 0) > 500)
        return { status: 400, body: { error: 'invalid_input' } };
    try {
        const value = await readMeetingTranscript(scoped.context, { meetingId: meetingId.data, ...(cursor === undefined ? {} : { cursor }) });
        return value === null ? { status: 404, body: { error: 'not_found' } } : { status: 200, body: value };
    }
    catch (error) {
        if (error instanceof MeetingTranscriptChangedError)
            return { status: 409, body: { error: 'transcript_changed' } };
        if (error instanceof MeetingTranscriptCursorError)
            return { status: 400, body: { error: 'invalid_cursor' } };
        throw error;
    }
}
