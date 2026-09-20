# G5b: `PutMetricData` through the AWS SDK, not embedded metric format

**Date:** 20 September 2026 · **Lane:** G5b process bootstrap · **Spec:** 13.3, and
G1's `docs/decisions/g1-alert-repetition.md`

## Spec silence

Section 13.3 says the applications emit metrics and that alarms watch them. It does not
say how the datapoint gets to CloudWatch.

## Decision

The worker calls `cloudwatch:PutMetricData` through `@aws-sdk/client-cloudwatch`, from
exactly one module: `packages/domain/jobs/metricsCloudWatch.ts`. The SDK is imported
lazily, inside `loadCloudWatchTransport`, so the API process — which never publishes —
does not load it.

## The alternative that was considered

CloudWatch embedded metric format: write a JSON log line with an `_aws` block and let
CloudWatch Logs extract the metrics. It needs no SDK, no `PutMetricData` permission and
no network call from the task, and it is the usual advice for Fargate.

It was not taken, for one reason that is written down in the infrastructure rather than
in an opinion. `infra/modules/cluster/main.tf` grants both task roles:

```
Sid      = "PublishOperationalMetrics"
Action   = ["cloudwatch:PutMetricData"]
Condition = { StringEquals = { "cloudwatch:namespace" = var.metric_namespace } }
```

The infrastructure lane granted the permission for a direct call and constrained it to
one namespace. Publishing through logs instead would leave that grant unused, put the
metric's latency behind log ingestion, and make the namespace a property of a log line
rather than of an IAM condition. If the coordinator prefers the embedded format, the
change is contained: `createCloudWatchSink` keeps its signature and the transport
writes a line instead of sending a command, and the IAM statement above comes out.

## What is tested and what is not

Everything on this side of the transport: the mapping onto `PutMetricData`, the
twenty-datum batch, the single timestamp for a whole publication, the omission of an
empty `Dimensions`, and the refusal of a metric name no alarm reads — which happens
*before* the transport is touched, so an unknown name never leaves the process.

The transport itself is one `send`, and no test calls AWS. One test constructs the
client to prove the lazy import's specifier still resolves, which is the single thing a
lazy import can break silently; it sends no command, so no credential is needed and
none is read.

## Twenty per request

`PutMetricData` has accepted up to a thousand `MetricData` members per request for
some request shapes since 2023. Twenty is the limit that has always been safe, and the
publication is a handful of gauges a minute, so the batch size is not worth a
compatibility question.

## The no-op is not a stub

With no transport — a laptop, a test, `FSS_METRICS=off` — the sink still validates
every datum and then sends nothing. A wrong unit or a metric name no alarm reads fails
where someone is looking at it rather than in production where nothing would.
