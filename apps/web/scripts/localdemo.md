# Issue781 local synthetic browser demo

## Reliable macOS review window (issue784)

For a review that must survive its originating terminal/tool command, explicitly start the finite OS-owned window from the repository root:

```sh
env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" TMPDIR="$TMPDIR" FSS_SYNTHETIC_LOCAL_DEMO=1 node --experimental-transform-types --disable-warning=ExperimentalWarning apps/web/scripts/localdemoReviewWindow.ts start
node --experimental-transform-types --disable-warning=ExperimentalWarning apps/web/scripts/localdemoReviewWindow.ts status
node --experimental-transform-types --disable-warning=ExperimentalWarning apps/web/scripts/localdemoReviewWindow.ts stop
```

`start` returns quickly with a private exact-owned receipt. This means STARTING, not ready. Use `status` until `state` is `ready`, then open the labeled isolated Chrome window. The receipt includes exact status/stop commands with the original TMPDIR and absolute executable/script paths, a runtime-log path, unique launchd service, supervisor PID and full resource receipt. Use those printed commands if changing shells/directories. No remembered PID should be reused to stop a later run.

The default promised usable window is 20 minutes **from READY**, maximum30. Set `FSS_LOCAL_DEMO_MINUTES=1` through `30` in the clean start command to change it. `resources.expiresAt` is the exact expiry. Startup has a separate selected-duration cooperative cancellation deadline and can fail without readiness. A hung native dependency can delay cancellation/cleanup, which is not certified hard-stop recovery. The window is independent of the originating runner's hard600second limit, not an attempt to extend that limit. It uses an explicitly bootstrapped, unique user GUI launchd one-shot with KeepAlive=false, no installation into LaunchAgents, login item or autostart, and no new dependency/service/spend. Plain foreground mode below is unchanged and remains tied to its parent terminal/tool lifetime.

Only one lease can exist per user/TMPDIR. Keep the same TMPDIR for controls and never bypass a duplicate refusal by choosing another directory. `stop` verifies the exact launchd service/receipt and writes a cancellation marker, including during startup, rather than signaling a reusable PID. Closing the isolated Chrome window also stops it. On ordinary stop or expiry, graceful fixture teardown removes PG/template/database, TLS and Chrome/profile, then removes the supervisor receipt/log/plist directory and bootstraps itself out of launchd. Nothing is left running as a delivery by acceptance tests. A second `stop` after completed cleanup has no active receipt to control.

Hard kill, OS crash, logout or a teardown failure is not certified graceful recovery. Unknown bootstrap outcomes retain the private receipt rather than guessing whether resources are safe to delete. If startup/teardown fails, inspect that exact receipt/log and service before any manual cleanup. A retained lease intentionally refuses another start. Never broadly kill Node/Chrome/Postgres or remove an unverified directory. Homebrew PostgreSQL and normal Chrome profiles are never adopted or stopped. No production, sending or real-business acceptance is implied. The same fictional-only/no-send/persistence limits below apply.

## Plain foreground mode

From the repository root with installed dependencies, Node24 and installed Google Chrome:

```sh
env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" TMPDIR="$TMPDIR" FSS_SYNTHETIC_LOCAL_DEMO=1 npm run localdemo --workspace apps/web
```

A clean environment is deliberate. The launcher refuses inherited PostgreSQL, production browser and provider settings. It creates its own loopback PostgreSQL/template/fixture database, localhost HTTPS certificate, signed OIDC test identity and isolated Chrome profile. It never adopts Homebrew PostgreSQL or your usual Chrome profile. It uses the real React build, browser host, authenticated API and domain owners, not a mockup. No production settings, credentials or external providers are needed.

The Chrome window opens the four fictional case A originals in **Replies**. The yellow SYNTHETIC / fictional / NO SEND / scripted-not-live-model label remains visible while scrolling, including after reload. Expand **Local demo instructions and limits** for the journey:

1. Inspect the readable original message and prior conversation. **Generate suggestion** invokes a fixed fixture script authored during implementation, not live inference. **Use suggestion in draft**, edit **Reply draft**, then **Preview exact reply**. Nothing is sent. The source already contains an agreed fictional walkthrough time and an unfulfilled recap promise. No actual scheduling, recap delivery or task/reminder control is added. Reply scratch is lost on refresh.
2. In Today, **Open firm**, **Load existing meetings**, **Open preparation**. This is a fictional fixture meeting reflecting the time agreed inside the invented thread, NOT a real calendar booking or actual human commitment. The preparation uses invented case A source observations, not model-quality evidence. No source link needs to be visited.
3. For useful private persistence, copy the displayed fictional meeting UUID into **Meeting ID**, **Read meeting notes**, write SYNTHETIC rehearsal notes in **Your notes**, **Save notes**. Reload, **Open firm**, enter the same meeting UUID, **Read meeting notes** to reopen. Only the existing real UI and meeting-note API persist these notes. Saving does not assign tasks, schedule a meeting, confirm interest, contact anyone or send anything.

Default lifetime: 20 minutes, hard maximum30. Set `FSS_LOCAL_DEMO_MINUTES=1` through `30` in the clean command to shorten/change it. Closing the isolated Chrome window, Ctrl-C, or `kill -TERM <exact Node PID printed in SYNTHETIC_BROWSER_DEMO_READY>` stops the demo. The ready receipt prints exact owned profile/TLS/PG paths, PG PID, database, OIDC/HTTPS origins, meeting UUID, expiry and stop command. A mode0600 copy lives inside the owned profile until shutdown. Shutdown removes the owned profile, TLS, database/template and cluster. All saved notes disappear with the disposable demo. Do not use real business or private content here.

Acceptance (exclusive disposable-PG/Chrome lane, never concurrent with the demo):

```sh
env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" TMPDIR="$TMPDIR" LC_ALL=en_US.UTF-8 FSS_SYNTHETIC_LOCAL_DEMO=1 FSS_LOCAL_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e --workspace apps/web -- test/e2e/syntheticBrowser781.spec.ts
```

Local synthetic usability is not production, real-business, autonomous follow-through or live-model acceptance. No release, sending, Gmail capture or LinkedIn activation is authorized by this command.
