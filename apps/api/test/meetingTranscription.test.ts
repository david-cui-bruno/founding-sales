import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
describe('meeting transcript reads', () => {
    let fixture: AuthFixture;
    let token: string;
    let admin: string;
    let meetingId: string;
    let firmId: string;
    const read = async (id = meetingId, bearer = token, cursor?: string) => await dispatch({
        method: 'GET', path: '/meetings/transcript', query: new URLSearchParams({ meetingId: id, ...(cursor === undefined ? {} : { cursor }) }),
        headers: { authorization: `Bearer ${bearer}` }, body: undefined,
    }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false, upgradeUrl: 'https://callie.example/download' });
    beforeAll(async () => {
        fixture = await createAuthFixture();
        token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
        admin = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
        firmId = await seedFirm(fixture, { name: 'Transcript Test Rentals', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
        meetingId = randomUUID();
        await fixture.db.query(`INSERT INTO meetings (workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at)
      VALUES ($1,$2,'m5api','m5api',$3,'booked',now(),now()+interval '20 minutes',now())`, [fixture.alpha.workspaceId, meetingId, firmId]);
    });
    afterAll(async () => { await fixture.stop(); });
    it('gives the assigned user an honest empty transcript without confirming attendance', async () => {
        const result = await read();
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ meetingId, coverage: { total: 0, ready: 0 }, utterances: [], nextCursor: null, timing: 'file_relative' });
        expect((await fixture.db.query<{
            state: string;
        }>('SELECT state FROM meetings WHERE id=$1', [meetingId])).rows[0]?.state).toBe('booked');
    });
    it('does not reveal transcript presence after reassignment or across workspaces', async () => {
        await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.admin.userId]);
        expect((await read()).status).toBe(404);
        expect((await read(randomUUID())).status).toBe(404);
        expect((await read(meetingId, admin)).status).toBe(200);
        const beta = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
        expect((await read(meetingId, beta)).status).toBe(404);
        await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.salesperson.userId]);
    });
});
