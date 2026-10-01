import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../../db/migrationRunner.ts';

/**
 * **An applied migration is never edited.** `migrationRunner.ts` records the sha256 of
 * every file it applies in `schema_versions`, and refuses to continue when a recorded
 * file's checksum differs: expand-migrate-contract has no down migration to fall back on
 * (`docs/greenfield/migrations.md`). Production has 0001 to 0019 recorded, so an edit to
 * any of those files — a comment, a `HINT` string, the name of a script cited inside one
 * — stops the next migration run: the 0020 and 0021 releases, or any hand release that
 * launches the migration task. Stale text inside an applied migration stays stale
 * forever. That is the cost of the checksum, and it is the right cost.
 *
 * **0022, 0023, 0024 and 0025 are pinned before they are applied**, and that is not the same claim
 * as the rest. The twenty-one below them say "this is what production recorded" —
 * production ran schema 21 on 28 September 2026 — and these two say "these are the
 * bytes the release will record", each written as the last commit of its lane once the
 * file was final (J-facts for 0022, R for 0023, E for 0024, FU for 0025 — whose pin moved
 * once more after the GPT-6 review of PR 332, on the bytes the upgrade test then passed
 * 24 → 25).
 * 0022's pin has moved with each round of review of PR 307 — a workspace foreign
 * key and a column-level UPDATE grant in the first, a CHECK function over `detail`
 * in the second. The rule those moves follow: **the file changes in the commit that
 * fixes it, and the pin moves in the last commit of that round, alone.** The pin is
 * never edited in the same commit as the bytes it pins, because a pin written beside
 * the change it describes is a pin nobody recomputed. 0020 and 0021 were each pinned
 * the same way before their own releases. 0020's pin moved once,
 * in the second round of the review of PR 296, to correct a sentence in its own comment —
 * and the pin moved with it in that same last commit, which is the only way either may
 * ever move before its release. After it is applied, an edit is an edit to undo.
 *
 * These are the bytes production recorded (main `63d22573`, 27 September 2026). **A
 * failure here is not a value to update: it is an edit to undo.** A new migration file is
 * the only way forward.
 *
 * ## The vacuous-pass traps, named
 *
 * **A pin over the files it happens to find.** Every version below is required to exist,
 * under its own name, so a deleted or renamed migration fails rather than passing
 * silently.
 *
 * **A gap under the last applied version.** Every migration at or below the last pinned
 * one must be pinned here, so a file inserted below the waterline cannot slip in
 * unpinned. Versions above it are free: a migration still being written has no line here
 * until its bytes are final.
 */
const APPLIED: readonly (readonly [number, string, string])[] = [
  [1, '0001_foundation.sql', '9f89e7288cc913edcc3e3734e592c9479387b1ee31942b1b774332696aa1e89c'],
  [2, '0002_jobs.sql', '456d5c05e6b535a3c817c78808408684ace65b7d2b372fc7944a04dda55d77ef'],
  [3, '0003_identity.sql', '5bdf57f05a5be728b5338a08b1b8085de63eaf876ec8f1860eb4d5f1a1303be9'],
  [4, '0004_crm.sql', '745b7b54eccc9a62667ee7880f80d763a0b5e5aeb5d1189f1fc8612e4b71f500'],
  [5, '0005_search.sql', 'f00344b41d502abe16b643ae06954e6c311d48e4dcbcd78d989dffe98e9eae68'],
  [6, '0006_policy.sql', '5ee812980311354d70c41a683d377c89fb68c74503ae5cd18b8d3ebf1e4040e0'],
  [7, '0007_research.sql', '575f53b92e9d4585f73adcc81c540a29807c91eb850416576367f70b59db1e27'],
  [8, '0008_today.sql', '562e7c3198b01d5e736e58cf96c724ff118385f4e339fbe06f84f9e74c3c0499'],
  [9, '0009_mail.sql', '04b6b558a7cc12f71162910f2603cc29ce929275b7ffba93a3ef581183f11c33'],
  [10, '0010_outbound.sql', 'df07a69961393f11525073151f7b163d8d7c90be8b06334d421b0a25e29f64ee'],
  [11, '0011_classification.sql', 'f7eb3dd1ab08acb7c9e9c6dfb41b3b772c2880e263f7743604e4fc70dd1cf0d9'],
  [12, '0012_sequences.sql', '0c6145f7f90cdbd80f7228b62709b8110209c89b393d3c3c61517343c9174308'],
  [13, '0013_dashboard.sql', '03d162716d2659c501ef7899687a73dd0a2301b631f6b46a31d9557537d124f5'],
  [14, '0014_retention.sql', '172578184d4f2c1f6e71709f554694d1cb82262ee50003ca67d000add9ebf107'],
  [15, '0015_footer.sql', '3b910950447a24406796d9308a393d690e9afc72f74880517f1c5ec67f3b4ee4'],
  [16, '0016_calling_identity_attestation.sql', '128e4811b58a1283164bcd4ed0cf8ef46e11675bd083cf92e46c49eb30d3064e'],
  [17, '0017_release_records.sql', '0ce96851d49ad44834590ee92b7a2e96da7a948324cfe618faf48e11f765e96a'],
  [18, '0018_remove_linkedin.sql', '0904427b7212e658136e217a82b123dafd7f82e000e8f58eb40a0f357cdcb5a9'],
  [19, '0019_wave2_cleanup.sql', '541f3c1916c792eaccf388740db819184279b3ebc3257b86a788cf0edf737c16'],
  [20, '0020_postal_address.sql', 'ce741ddaec6051fb58c78ed03b927a1c970a7db236db325e2a06563cc395eb4c'],
  [21, '0021_compat_cleanup.sql', 'b782e33de64302ec7265678118a7e85432535bd435cbc6c5ec56830d6e974d93'],
  [22, '0022_funnel_facts.sql', '24a12518575536f95ca1f098d0af45ec341f43dfa3fc738365bfb4afab80f2aa'],
  [23, '0023_research.sql', 'f3aa198989dca6cdbe6292fded4f16a015c1bc4ad7df490f955dad10bf2bab6d'],
  [24, '0024_email_presentation.sql', '9211992c06d7eb43b094c6bc42db0c523c1b9260e09359f0e1212b9da79a5a5f'],
  [25, '0025_follow_up_permissions.sql', '3403935c669d54f9b814346bb6a5d983dce5b83f46de649fd5e781d23b1c14d1'],
  [26, '0026_send_path_v2.sql', 'f56392f403ba0dbf018a8a7499a6b2c43da77a055cf5666f5b8dd5ed42784f8d'],
  [27, '0027_mailbox_accounts.sql', 'bd796316596eac48937bec5a0a6d3ce35cef57fe06566372fab446093d45596a'],
  [28, '0028_call_to_booking.sql', 'ea6351668b42e904a9b9787b475cb6d9d5489f693db1f4922cd21115dd2e1fcc'],
  [29, '0029_meeting_booking_uids.sql', '3f4007cd59d2f99fc6f761ed82ed7dcffcb99381be2193de6b1d8212d5c9b168'],
  [30, '0030_call_transcripts.sql', '6b37bcb401852247e43f15d2e220a0f7e35923aa01efe94f680b067620ab8260'],
  [31, '0031_monthly_cash_ceiling.sql', '3ff1312918964934bea24e638a7a2fcdd56f3554476ed3dd7f232b64105afdae'],
  [32, '0032_call_summaries.sql', '33e3cbc0a4ae40d2352dac0306de18633316d170799002121acb90c16119f2ec'],
];

const EDITED = (fileName: string): string =>
  `${fileName} has changed. An applied migration is never edited: the runner recorded this sha256 in schema_versions and refuses to continue when the file differs, so the next migration run would stop before applying anything. Undo the edit — a new migration file is the only way forward.`;

describe('the applied migrations are immutable, byte for byte', () => {
  it('holds every applied migration to the sha256 production recorded for it', () => {
    const loaded = new Map(loadMigrations().map(migration => [migration.version, migration]));
    for (const [version, fileName, checksum] of APPLIED) {
      const migration = loaded.get(version);
      expect(migration, `${fileName} is gone: an applied migration is never deleted`).toBeDefined();
      expect(migration?.fileName, `migration ${String(version)} is not ${fileName}: an applied migration is never renamed`).toBe(fileName);
      expect(migration?.checksum, EDITED(fileName)).toBe(checksum);
    }
  });

  it('pins every migration up to the last applied one, so none slips in below the waterline', () => {
    const pinned = new Set(APPLIED.map(([version]) => version));
    const last = Math.max(...pinned);
    expect(APPLIED, 'the pins are contiguous from 0001').toHaveLength(last);
    for (const migration of loadMigrations()) {
      if (migration.version > last) continue;
      expect(pinned.has(migration.version), `${migration.fileName} is at or below the last applied migration and is not pinned above`).toBe(true);
    }
  });
});
