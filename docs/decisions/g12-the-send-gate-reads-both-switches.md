# The send gate reads both of 16.2's switches, and the worker's schema minimum moves for it

**Lane:** G12 · **Spec:** 16.2, Appendix G 42 · **Files:** `packages/domain/outbound/{gate,types}.ts`, `packages/domain/db/schemaRange.ts`, `Dockerfile.worker(.dockerignore)`

## What the specification says and what the code did

16.2: "Production sending remains disabled until all mandatory scenarios for the
affected release class pass, the deployed commit/image digests match the rehearsal
artifacts, and an authenticated admin enables sending."

Three clauses, two stored facts, and until this lane nothing on the dispatch path read
either of the second two. `decideSend` read `sending_domains.automated_sending_enabled`
— G7-2's per-domain DNS gate, whose CHECK forbids it without SPF, DKIM, DMARC and a
Postmaster review — and stopped there. G9 shipped `workspace_settings.sending_enabled`
with the `releaseGateReference` and the pure rule `effectiveSendingEnabled`, and said
in its own decision notes that the lane wiring the send path would be this one.

So a workspace whose DNS passed could send from an image nobody had rehearsed. That is
the exact sentence 16.2 exists to forbid.

## The decision

`decideSend` now requires all three facts:

1. `sending_domains.automated_sending_enabled` for the primary sending domain
   (unchanged, and still refused as `automated_sending_disabled`);
2. `workspace_settings.sending_enabled.enabled`, read through `readSetting`;
3. the deployment's own flag, passed in as `SendGateDeps.deploymentSendingEnabled`.

(2) and (3) are ANDed by `effectiveSendingEnabled`, which is G9's pure rule and takes
the deployment flag as an argument precisely so that this lane could supply it. A new
refusal code, `workspace_sending_not_attested`, names the pair; its `detail` says which
half said no (`workspace` or `deployment`) and never the reference itself.

**The default is false.** A caller that omits `deploymentSendingEnabled` gets a held
send. The failure mode of the other default is sending from an unrehearsed artifact,
which is not recoverable; the failure mode of this one is a held email with a refusal
that names why.

**No new hold reason code.** `HOLD_REASON_CODES` is seeded by migration 0001 and this
lane adds no migration, so `holdReasonForRefusal` returns null for the new code and no
`active_holds` row is opened — exactly the treatment `automated_sending_disabled` and
`sending_domain_unknown` already get. The fence records the reason; the automation is
already stopped by the refusal itself, because a workspace with sending disabled has
nothing else to churn on. `outboundSendHandoff` maps the null to `scoped_pause`, the
same as those two.

**Order.** The attestation is checked before the sending domain, first in the "not yet"
group and after every "never send to this person" check. A workspace nobody has enabled
should report that rather than the state of its DNS records, and a suppressed recipient
must still be reported as suppressed.

## The consequence nobody could avoid: the worker's schema minimum

`decideSend` runs in the worker, inside the dispatching transaction. It now issues a
statement against `workspace_settings`, which arrives in migration 0013. Under the rule
`docs/decisions/g10-worker-schema-minimum.md` states — a binary declares the lowest
version on which its statements can succeed, not the lowest it would like —
`WORKER_SCHEMA_RANGE.minimum` moves from 12 to 13. The note in `schemaRange.ts` written
when G9 landed 0013 said this lane would be the one to move it.

The alternative, catching `undefined_table` and treating it as "not attested", was
rejected: it makes a stale deployment indistinguishable from an admin who has not
enabled sending, which is a supported state an operator would then try to "fix".

Both ranges are now the strict `{13, 13}` the coordinator's launch note anticipated, so
Appendix G 22 has no overlapping image/schema pair and asserts the refusal instead.

`packages/domain/outbound` now imports `../settings`, so `Dockerfile.worker` and its
dockerignore name `packages/domain/settings`. G4's `imageClosure.test.ts` catches the
omission without Docker; it was observed failing before the two lines were added.

## The vacuous-pass trap this opens, and where it is closed

`packages/domain/test/outbound/support/outboundWorld.ts` now seeds the attestation and
defaults `deploymentSendingEnabled: true`, because a world that could not send would
make every cap, window and suppression scenario refuse for a reason it is not about.
That seed is itself a trap: a suite whose fixture quietly enables sending proves nothing
about the switch. It is closed twice — `packages/domain/test/outbound/attestation.test.ts`
sets both halves explicitly for each of its five cases, and
`scripts/releaseMutationCheck.mjs` removes the fixture seed and requires the outbound
suite to fail.
