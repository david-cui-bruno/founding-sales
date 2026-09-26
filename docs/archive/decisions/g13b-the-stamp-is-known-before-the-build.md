# G13b: the desktop commit stamp is the commit, so it is known before anything is built

**The question the brief asked.** `infra/scripts/rehearsal-release-record.sh` takes a
`desktop_commit_stamp` and writes it into the release record. The signed bundle carries
a stamp naming the commit it was built from. These two have to be equal
(specification 16.2: "the deployed commit/image digests match the rehearsal artifacts").
Which one is produced first — build the desktop and pass its stamp into the rehearsal,
or run the rehearsal and build to its stamp?

**Decision: neither. The stamp is not a build output.** It is `git rev-parse HEAD` of
the release commit, which exists before either job runs, and both jobs are told the
same value. The order below follows from that, and it is the order in
`docs/greenfield/release.md` section 2.

```
   the release commit (git rev-parse HEAD)
     ├──► David pushes the two images, tagged with it      (release.md §2)
     ├──► the rehearsal runs with desktop_commit_stamp = it (release.md §3)
     │      └─ the release record names it
     ├──► the production apply creates the CloudFront hostname (release.md §4)
     ├──► David sets FSS_UPDATE_CHANNEL_URL from that apply
     └──► the desktop release job runs on that commit
            └─ the verifier confirms the stamp equals the record
```

## Why not build the desktop first

It is the obvious reading of the brief, and it is wrong for a practical reason the
operator's own configuration made plain: on 20 September 2026 the desktop release job
**cannot run at all**. Eight of the nine signing secrets are absent and
`FSS_UPDATE_CHANNEL_URL` does not exist, because CloudFront does not exist until the
first production apply. A rehearsal that had to wait for a signed desktop build would
be a rehearsal that could not run before the infrastructure it is rehearsing.

Making the stamp a build output also makes it something a person copies between two
workflow forms, which is the kind of step that is right four times and wrong on the
fifth. `git rev-parse HEAD` is the same string for everybody who checks out the
release, and nobody has to wait for a runner to learn it.

## Why not build the desktop to the rehearsal's stamp either

Same reason in the other direction: the record's stamp would then be the *intended*
commit rather than a fact about an artifact, and the comparison would be the record
against itself.

## Where the comparison actually happens

Three places, and only the last two are worth anything.

1. **Before the build.** `.github/workflows/greenfield-desktop.yml` takes an optional
   `desktop_commit_stamp` input and refuses when it is present and is not `github.sha`.
   This is a typo check, and it fails in seconds rather than after ninety minutes.
   Empty is permitted: the first build of a commit may precede the rehearsal that
   records it.

2. **After the build, against the artifact.** The manifest's `commitSha` is read out of
   the release stamp, which is written into the app directory before it is packed and
   is therefore *inside the asar and inside the code signature*. The workflow compares
   that with `github.sha` and, when given, with the input. A bundle cannot claim a
   commit it is not without also failing `codesign --verify`.

3. **At enable time, by David.** `release.md` section 6 step 2 already makes the image
   digests a person's comparison rather than a workflow's. The desktop stamp joins it:
   the release record names a stamp, the run summary prints a commit, and they are the
   same forty characters or sending does not get enabled.

## The one thing this cannot prove

That the Mac David is running is the Mac the record describes. The stamp is checkable
on a bundle in hand — `npm run verify:desktop:package -- /Applications/Callie.app`
prints it — but nothing reports it to the API, and 5.3's compatibility gate is about
versions rather than commits. If that ever matters, the device registration is where
the stamp would go, and it is a G2 surface, not this one.
