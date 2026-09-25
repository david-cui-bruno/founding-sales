# Desired count zero is a root variable, and the scale-up is a script (lane G12h)

David's condition 2 of 21 September: "services are created at desired count zero and
scaled only after the migration task and `fss verify` succeed, worker before API".

Terraform and a shell script can each express half of that, and the question this
record answers is which half goes where.

## What Terraform owns

`bootstrap` is a `bool` root variable on both roots, plumbed to the cluster module,
where it becomes:

```hcl
api_desired_count    = var.bootstrap ? 0 : var.api_desired_count
worker_desired_count = var.bootstrap ? 0 : var.worker_desired_count
```

The first apply of a fresh environment passes `true` and both services are created at
zero. The rehearsal root defaults to `true` because every rehearsal environment is a
fresh one; production defaults to `false` because production is bootstrapped once, and
passing `true` to a running environment is a real outage.

## What the script owns

`infra/scripts/release-deploy.sh` performs the transient zero of a schema release and
the scale-up in both cases, and its target is
`terraform output deployment_plan`'s `declared_desired_count` — the number the root
declares, read from the plan rather than typed into a shell file. A literal there is a
number that drifts from the root's, and the drift is invisible until the day somebody
changes one of them.

## What was rejected: `ignore_changes = [desired_count]`

The tidy-looking alternative is to let Terraform declare the count once and then stop
tracking it, so the script can move it freely. It was rejected for two reasons:

1. **The next schema release needs Terraform to be able to scale to zero.** Once the
   count is ignored, the only thing that can change it is the script, and a service
   whose replica count no plan can express is a service nobody can reason about from
   the repository.
2. **It hides the bootstrap rather than stating it.** `bootstrap` makes the two states
   — "this environment is being created" and "this environment is running" — a value
   an operator passes and a plan shows. `ignore_changes` makes them indistinguishable.

The cost of not using it is one real piece of drift: between the bootstrap apply and
the script's scale-up, the cloud says zero and the root says two. That window is the
bootstrap, it is minutes long, and the next apply reconciles it — which is the
behaviour wanted, because an apply during that window *should* put the services back
where the root says they belong.

## Why zero at all

Both binaries refuse to start unless the applied schema version is exactly the range
they declare (`FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX` against `WORKER_SCHEMA_RANGE`), and
from migration 0006 onwards every declared range is a strict `{N,N}`. A fresh
environment's database has no schema at all. An apply that created the services
running would therefore create two of them crash-looping, the deployment circuit
breaker would roll them back to a definition that also cannot start, and the migration
task that would have fixed it had not been launched yet — because it cannot be
launched until the cluster exists.

So the order is: database and cluster and task definitions, then the migration task,
then `fss verify`, then the worker, then the API. Nothing before the migration can
usefully be running, and the honest way to say that in Terraform is to create it at
zero.

## Amended (lane g70, 25 September 2026): `ignore_changes = [desired_count]` after all

The rejection above rested on the next schema release needing Terraform to scale to
zero. In practice no release ever asked Terraform to. The schema release stopped the
services inside `release-deploy.sh`, and that script runs *after* the apply. The apply
had already pointed the running services at task definitions whose strict `{N,N}` range
refuses the old schema. The 25 September deploy of schema 16 ran in that order
(`docs/greenfield/release.md` 8.0af). An apply that can move the count cannot come
after a stop either: it would put the declared numbers back and start the tasks the
stop was for.

So both services now carry `ignore_changes = [desired_count]`, and the split is:

- **Terraform** decides the count a service is *created* at. `bootstrap` still states
  "this environment is being created", in the plan an operator reads.
- **`infra/scripts/release-stop.sh`** takes both services to zero before a
  schema-change apply.
- **`infra/scripts/release-deploy.sh`** refuses a schema change unless they are at zero,
  and sets the declared counts from `output.deployment_plan` in every deploy, as it
  always has.

The count is still a number the repository states, in the root's variables and in
`deployment_plan`, so reason 1's worry, a count nobody can reason about from the
repository, does not return. What is given up is the reconciliation the last paragraph
of "What was rejected" wanted: an apply no longer puts a service back to its declared
count. The next deploy does.
