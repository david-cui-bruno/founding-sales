# Issue781 local synthetic browser demo

From the repository root with installed dependencies, Node24 and installed Google Chrome:

```sh
env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" TMPDIR="$TMPDIR" FSS_SYNTHETIC_LOCAL_DEMO=1 npm run localdemo --workspace apps/web
```

A clean environment is deliberate. The launcher refuses inherited PostgreSQL, production browser and provider settings. It creates its own loopback PostgreSQL/template/fixture database, localhost HTTPS certificate, signed OIDC test identity and isolated Chrome profile. It never adopts Homebrew PostgreSQL or your usual Chrome profile. It uses the real React build, browser host, authenticated API and domain owners, not a mockup. No production settings, credentials or external providers are needed.

The Chrome window opens the four fictional case A originals in **Replies**. The yellow SYNTHETIC / fictional / NO SEND / scripted-not-live-model label remains visible while scrolling, including after reload. Expand **Local demo instructions and limits** for the journey:

1. Inspect the readable original message and prior conversation. **Generate suggestion** invokes a fixed human-authored local script, not live inference. **Use suggestion in draft**, edit **Reply draft**, then **Preview exact reply**. Nothing is sent. The script does not supply real times or scheduling. Reply scratch is lost on refresh.
2. In Today, **Open firm**, **Load existing meetings**, **Open preparation**. This is a fictional fixture meeting, NOT Dana's confirmed commitment or a real booking. The preparation uses invented case A source observations, not model-quality evidence. No source link needs to be visited.
3. For useful private persistence, copy the displayed fictional meeting UUID into **Meeting ID**, **Read meeting notes**, write SYNTHETIC rehearsal notes in **Your notes**, **Save notes**. Reload, **Open firm**, enter the same meeting UUID, **Read meeting notes** to reopen. Only the existing real UI and meeting-note API persist these notes. Saving does not assign tasks, schedule a meeting, confirm interest, contact anyone or send anything.

Default lifetime: 20 minutes, hard maximum30. Set `FSS_LOCAL_DEMO_MINUTES=1` through `30` in the clean command to shorten/change it. Closing the isolated Chrome window, Ctrl-C, or `kill -TERM <exact Node PID printed in SYNTHETIC_BROWSER_DEMO_READY>` stops the demo. The ready receipt prints exact owned profile/TLS/PG paths, PG PID, database, OIDC/HTTPS origins, meeting UUID, expiry and stop command. A mode0600 copy lives inside the owned profile until shutdown. Shutdown removes the owned profile, TLS, database/template and cluster. All saved notes disappear with the disposable demo. Do not use real business or private content here.

Acceptance (exclusive disposable-PG/Chrome lane, never concurrent with the demo):

```sh
env -i HOME="$HOME" PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" TMPDIR="$TMPDIR" LC_ALL=en_US.UTF-8 FSS_SYNTHETIC_LOCAL_DEMO=1 FSS_LOCAL_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:e2e --workspace apps/web -- test/e2e/syntheticBrowser781.spec.ts
```

Local synthetic usability is not production, real-business, autonomous follow-through or live-model acceptance. No release, sending, Gmail capture or LinkedIn activation is authorized by this command.
