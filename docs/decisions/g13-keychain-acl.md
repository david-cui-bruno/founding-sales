# G13a: `-T ''` on `add-generic-password` makes every Keychain read raise a dialog

**Not a decision under spec silence. A defect, found by the host layer, fixed here.**

`docs/decisions/g2-desktop-test-layers.md` named this exactly: "What is honestly not
proved here — that `security add-generic-password` behaves as `keychainCommand`
expects against a real login keychain." It does not.

**What was there.**

```
security add-generic-password -a <account> -s <service> -U -T '' -w
```

**What `-T` does.** It names an application that may read the item without
authorization. The manual page's advice is to pass one per trusted application; with
no `-T` at all, the item's access control list trusts the application that created
it. `-T ''` is neither: it asks for an access control list containing one entry for
an application at the empty path, which matches nothing. The result is an item no
application may read.

**What that costs.** Every read raises the modal "security wants to use your
confidential information stored in device-secret in your keychain" dialog. On a
person's Mac that is one prompt they can answer with *Always Allow*, at an arbitrary
moment, with the app apparently hung until they do — the read is on the path to
renewing a session, so it happens when a person has just come back to the app and it
is refusing to work. On a headless runner nobody answers it, and the process waits
forever.

**Measured, before the fix.** `find-generic-password -w` against an item written with
`-T ''`, with an eight-second timeout: killed by the timeout, no output, no exit
status. The same write with `-T` removed: the secret comes back, exit 0, no dialog.
With `-T /usr/bin/security`: the same. The difference is entirely `-T ''`.

**The fix.** Remove `-T`. One token in `apps/desktop/src/main/keychain.ts`.

**Why the default and not `-T /usr/bin/security`.** They behave identically here,
because `security` is both the creator and the reader. The default says what is meant
— the tool that put the secret there may read it back — without writing a path that
would be wrong if the adapter ever stopped shelling out.

**Why no unit test caught it.** G2's test asserts the argument vector, and correctly:
the secret is not in it, and `-w` is last so the password comes from standard input.
Both remain true with `-T ''`. The property that broke is not a property of the
argument vector; it is a property of the item macOS creates from it. That is the
definition of a host test, and `apps/desktop/test/host/keychain.host.test.ts` is now
the one that would catch it: it writes, reads back, updates, reads back and removes
through the real `/usr/bin/security`, and a re-introduced `-T ''` makes it time out
rather than fail — which is itself the symptom, so the message names it.

**Where the item goes in the test.** The login keychain, with a service name unique
per run, removed in `afterEach`. Not a temporary keychain: the keychain to write to is
a trailing positional argument, and `-w` with no value — which is what makes
`security` read the password from standard input at all — swallows the next token. So
either the secret goes in the argument vector or the item goes in the default
keychain, and the argument vector is the one that matters.
