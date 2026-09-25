import { describe, expect, it } from 'vitest';
import { LIVENESS_PATH, NOT_READY_STATUS, READINESS_PATH } from '../../apps/api/src/bootstrap/readiness.ts';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The load balancer asks readiness, and the container asks liveness (audit S14, lane
 * g81).
 *
 * The target group polled `/healthz`, which answers 200 whenever the process is
 * running. The checks that say a task must not serve — the applied schema outside the
 * range the binary declares (4.2), the system generation not the pinned one (Appendix
 * E step 1), a database that cannot answer, and since PR 215 a pool with no connection
 * free (`database_busy`) — only ever failed `/readyz`, which nothing that routes traffic
 * read. A task a rolling deploy started against the wrong schema was put in service as
 * soon as it was listening.
 *
 * ## The vacuous-pass trap, named
 *
 * Asserting that the edge module *mentions* `/readyz` would pass against a variable
 * whose description said so while its default still read `/healthz`. So the default is
 * read out of its own block and compared with the path the API actually serves, the
 * matcher must be exactly the one status readiness answers when ready, and the
 * container health check must still be liveness — a container check on readiness would
 * restart every task the moment the database hiccupped, which is the opposite trap.
 * The timing half reads the numbers a rolling deploy depends on, not prose about them.
 */

const EDGE_VARIABLES = readRepositoryFile('infra/modules/edge/variables.tf');
const EDGE = readRepositoryFile('infra/modules/edge/main.tf');
const CLUSTER_VARIABLES = readRepositoryFile('infra/modules/cluster/variables.tf');

/** The text of `variable "<name>" { … }`, up to the next top-level block. */
function variableBlock(terraform: string, name: string): string {
  const start = terraform.indexOf(`variable "${name}" {`);
  if (start < 0) return '';
  const end = terraform.indexOf('\n}\n', start);
  return end < 0 ? terraform.slice(start) : terraform.slice(start, end);
}

function numberIn(block: string, attribute: string): number {
  const match = new RegExp(`\\n\\s*${attribute}\\s*=\\s*(\\d+)(?:\\n|$)`, 'u').exec(block);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

const TARGET_GROUP = ((): string => {
  const start = EDGE.indexOf('resource "aws_lb_target_group" "api" {');
  if (start < 0) return '';
  const end = EDGE.indexOf('\n}\n', start);
  return end < 0 ? EDGE.slice(start) : EDGE.slice(start, end);
})();

const HEALTH_CHECK = ((): string => {
  const start = TARGET_GROUP.indexOf('health_check {');
  if (start < 0) return '';
  const end = TARGET_GROUP.indexOf('\n  }\n', start);
  return end < 0 ? '' : TARGET_GROUP.slice(start, end);
})();

describe('g81: the target group health check is readiness', () => {
  it('still finds the blocks it reads', () => {
    expect(variableBlock(EDGE_VARIABLES, 'health_check_path')).not.toBe('');
    expect(TARGET_GROUP).not.toBe('');
    expect(HEALTH_CHECK).toContain('path                = var.health_check_path');
  });

  it('polls the path the API answers readiness on', () => {
    expect(READINESS_PATH).toBe('/readyz');
    expect(variableBlock(EDGE_VARIABLES, 'health_check_path')).toContain(`default     = "${READINESS_PATH}"`);
    expect(variableBlock(EDGE_VARIABLES, 'health_check_path')).not.toContain(`default     = "${LIVENESS_PATH}"`);
  });

  it('treats the not-ready answer as unhealthy', () => {
    expect(HEALTH_CHECK).toContain('matcher             = "200"');
    expect(NOT_READY_STATUS).toBe(503);
    expect(HEALTH_CHECK).not.toMatch(/matcher\s*=\s*"[^"]*5\d\d/u);
  });

  it('keeps the container health check on liveness, so a database outage drains rather than restarts', () => {
    const containerCheck = variableBlock(CLUSTER_VARIABLES, 'api_health_check_command');
    expect(containerCheck).toContain(`'${LIVENESS_PATH}'`);
    expect(containerCheck).not.toContain(READINESS_PATH);
  });

  it('puts a ready task in service inside the service grace period, so a rolling deploy completes', () => {
    const interval = numberIn(HEALTH_CHECK, 'interval');
    const healthy = numberIn(HEALTH_CHECK, 'healthy_threshold');
    const unhealthy = numberIn(HEALTH_CHECK, 'unhealthy_threshold');
    const timeout = numberIn(HEALTH_CHECK, 'timeout');
    const grace = numberIn(variableBlock(CLUSTER_VARIABLES, 'health_check_grace_period_seconds'), 'default');
    const deregistration = numberIn(TARGET_GROUP, 'deregistration_delay');

    for (const value of [interval, healthy, unhealthy, timeout, grace, deregistration]) expect(value).not.toBeNaN();
    // Two passes fifteen seconds apart: in service about thirty seconds after it is
    // ready, well inside the sixty seconds ECS ignores the load balancer for.
    expect(healthy * interval).toBeLessThanOrEqual(30);
    expect(healthy * interval + timeout).toBeLessThan(grace);
    // A probe answers inside its interval, and a busy task is out after 45 seconds.
    expect(timeout).toBeLessThan(interval);
    expect(unhealthy * interval).toBeLessThanOrEqual(45);
    expect(deregistration).toBe(30);
  });
});
