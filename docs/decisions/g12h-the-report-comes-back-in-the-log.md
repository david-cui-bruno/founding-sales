# A one-off task's report comes back in its log stream (lane G12h)

`fss` writes its answer twice: one JSON object on stdout, and — when `--report <path>`
is given — the same bytes to a file with mode 600. Both were designed for a tool an
operator runs in a terminal.

A one-off ECS task has neither. Its filesystem is created with the task and destroyed
with it, so `--report /tmp/fss-drill/step8-restore-report.json` writes a file that
exists for ninety seconds on a host nobody can reach. There is no volume to mount: the
task runs on Fargate, in public subnets, with no EFS and no bucket for it.

## What survives

The log stream. `logConfiguration` is `awslogs` on every one of the three one-off task
definitions, pointed at the worker log group with its own stream prefix, so stdout and
stderr both reach CloudWatch and outlive the task by the group's retention.

So `release_run_task --capture <file>` writes the task's log messages to a file on the
runner as it prints them, and `release_captured_report <capture> <destination>` takes
the command's answer out of it: the last parseable JSON object in the capture that is
**not** a log line. The tool's own logs are JSON too, and they always carry `level` and
`event`; the answer never does. That is the discriminator, and it is a property of the
two shapes rather than a position in the stream, so a command that logged after
printing its answer would still be read correctly.

An empty capture, or a capture with no JSON object in it, is a failure with its own
message. A drill whose report could not be read is a drill that did not report, not
one that passed.

## Why not S3

A bucket the tasks could write reports into would be simpler to read and would be a
new place prospect-shaped data can live: the drill's step 8 report carries counts of
sends, replies and suppressions, and its step 3 report carries tombstone counts per
mailbox. The journal bucket is object-locked and append-only by design and must not
become a general write target; a second bucket is a second retention policy, a second
deletion path and a second thing to destroy at teardown.

The log group already exists, already has a retention, is already read by the metric
filters, and is already where an operator looks when a task fails. Using it costs
nothing new.

## What the reports still look like from outside

The drill script writes the per-step objects out of the captured report under the
names they have always had — `journal-replay.json`, `sent-reconcile.json`,
`inbox-recover.json`, `coverage.json`, `restore-report.json` — into
`$FSS_REHEARSAL_REPORTS`. The release record, the workflow's own assertions and the
uploaded artifact are unchanged: where the work ran is invisible to everything
downstream, which is the point.
