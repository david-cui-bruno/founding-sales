import type { OutboundCase, OutboundCaseFixture } from './outboundCases.ts';

const alpha = (f: OutboundCaseFixture) => f.seeded.alpha.workspaceId;

async function epoch(f: OutboundCaseFixture, side: 'alpha' | 'beta' = 'alpha'): Promise<string> {
  return (await f.session.query<{id:string}>(`INSERT INTO mailbox_recovery_epochs
    (workspace_id,mailbox_id,activity_at,started_on,earned_cap,stage_started_on)
    VALUES($1,$2,'2026-09-01T09:00Z','2026-09-15',50,'2026-09-15') RETURNING id`,
  [f.seeded[side].workspaceId,f.mail[side].mailboxId])).rows[0]!.id;
}

/** Each malformed row violates exactly one migration0064 promise, including tenant references. */
export const SENDER_RECOVERY_CONSTRAINT_CASES: readonly OutboundCase[] = [
  {constraint:'mailbox_recovery_epochs_pkey',run:async f=>{
    const id=await epoch(f);
    return f.session.query(`INSERT INTO mailbox_recovery_epochs(workspace_id,id,mailbox_id,activity_at,started_on,earned_cap,stage_started_on)
      VALUES($1,$2,$3,'2026-09-02T09:00Z','2026-09-16',50,'2026-09-16')`,[alpha(f),id,f.mail.alpha.mailboxId]);
  }},
  {constraint:'mailbox_recovery_epochs_workspace_id_mailbox_id_activity_at_key',run:async f=>{await epoch(f);return epoch(f);}},
  {constraint:'mailbox_recovery_epochs_workspace_id_mailbox_id_fkey',run:async f=>f.session.query(`INSERT INTO mailbox_recovery_epochs
    (workspace_id,mailbox_id,activity_at,started_on,earned_cap,stage_started_on)
    VALUES($1,$2,'2026-09-01T09:00Z','2026-09-15',50,'2026-09-15')`,[alpha(f),f.mail.beta.mailboxId])},
  {constraint:'mailbox_recovery_epochs_earned_cap_check',run:async f=>f.session.query(`INSERT INTO mailbox_recovery_epochs
    (workspace_id,mailbox_id,activity_at,started_on,earned_cap,stage_started_on)
    VALUES($1,$2,'2026-09-01T09:00Z','2026-09-15',101,'2026-09-15')`,[alpha(f),f.mail.alpha.mailboxId])},
  {constraint:'mailbox_recovery_epochs_qualifying_days_check',run:async f=>f.session.query(`INSERT INTO mailbox_recovery_epochs
    (workspace_id,mailbox_id,activity_at,started_on,earned_cap,qualifying_days,stage_started_on)
    VALUES($1,$2,'2026-09-01T09:00Z','2026-09-15',50,-1,'2026-09-15')`,[alpha(f),f.mail.alpha.mailboxId])},
  {constraint:'mailbox_send_ramp_workspace_id_recovery_epoch_id_fkey',run:async f=>f.session.query(
    'UPDATE mailbox_send_ramp SET recovery_epoch_id=$3 WHERE workspace_id=$1 AND mailbox_id=$2',
    [alpha(f),f.mail.alpha.mailboxId,await epoch(f,'beta')])},
  {constraint:'mailbox_send_days_workspace_id_recovery_epoch_id_fkey',run:async f=>f.session.query(`INSERT INTO mailbox_send_days
    (workspace_id,mailbox_id,business_date,cap_granted,recovery_epoch_id,recovery_cap,recovery_stage)
    VALUES($1,$2,'2026-09-15',5,$3,5,0)`,[alpha(f),f.mail.alpha.mailboxId,await epoch(f,'beta')])},
  {constraint:'mailbox_send_days_recovery_cap_check',run:async f=>f.session.query(`INSERT INTO mailbox_send_days
    (workspace_id,mailbox_id,business_date,cap_granted,recovery_epoch_id,recovery_cap,recovery_stage)
    VALUES($1,$2,'2026-09-15',5,$3,101,0)`,[alpha(f),f.mail.alpha.mailboxId,await epoch(f)])},
  {constraint:'mailbox_send_days_recovery_stage_check',run:async f=>f.session.query(`INSERT INTO mailbox_send_days
    (workspace_id,mailbox_id,business_date,cap_granted,recovery_epoch_id,recovery_cap,recovery_stage)
    VALUES($1,$2,'2026-09-15',5,$3,5,6)`,[alpha(f),f.mail.alpha.mailboxId,await epoch(f)])},
  {constraint:'mailbox_send_days_check',run:async f=>f.session.query(`INSERT INTO mailbox_send_days
    (workspace_id,mailbox_id,business_date,cap_granted,recovery_cap)
    VALUES($1,$2,'2026-09-15',5,5)`,[alpha(f),f.mail.alpha.mailboxId])},
  {constraint:'mailbox_send_days_check1',run:async f=>f.session.query(`INSERT INTO mailbox_send_days
    (workspace_id,mailbox_id,business_date,cap_granted,recovery_stage)
    VALUES($1,$2,'2026-09-15',5,0)`,[alpha(f),f.mail.alpha.mailboxId])},
];
