import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const backupPath = ".github/workflows/crm-acquisition-diagnostic-cleanup.yml";
function runBody(path: string, name: string): string {
  const lines = readFileSync(resolve(path), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error("workflow step unavailable");
  const at = lines.findIndex(
    (line, index) => index > start && line.trim() === "run: |",
  );
  if (at < 0) throw new Error("workflow shell unavailable");
  const width = (lines[at]?.search(/\S/u) ?? 0) + 2;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(width))) break;
    body.push(line.slice(width));
  }
  return body.join("\n");
}
function originRun(
  change: Record<string, unknown> = {},
  fail = false,
  jobChange: Record<string, unknown> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-workflow-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const fixture = {
      id: 123,
      run_attempt: 1,
      head_sha: "a".repeat(40),
      head_branch: "main",
      event: "workflow_dispatch",
      status: "completed",
      workflow_id: 456,
      repository: { full_name: "david-cui-bruno/founding-sales" },
      head_repository: { full_name: "david-cui-bruno/founding-sales" },
      ...change,
    };
    const fixturePath = join(directory, "run.json");
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const jobsPath = join(directory, "jobs.json");
    writeFileSync(
      jobsPath,
      JSON.stringify({
        total_count: 1,
        jobs: [
          {
            name: "diagnostic",
            status: "completed",
            conclusion: "failure",
            steps: [
              {
                name: "Apply only the exact approved saved plan",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "Clean exact owned lease after expiry failure or cancellation",
                status: "completed",
                conclusion: "failure",
              },
            ],
            ...jobChange,
          },
        ],
      }),
    );
    const calls = join(directory, "calls");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env python3\nimport os,sys,json\nopen(os.environ['CALLS'],'a').write(' '.join(sys.argv[1:])+'\\n')\nif os.environ.get('FAIL_GH')=='1':\n print('private-response-sentinel',file=sys.stderr);sys.exit(1)\nif '/jobs?' in sys.argv[-1]:print(open(os.environ['JOBS_FIXTURE']).read())\nelif '/attempts/' in sys.argv[-1]:print(open(os.environ['FIXTURE']).read())\nelse:print(json.dumps({'id':456,'path':'.github/workflows/crm-acquisition-diagnostic.yml'}))\n`,
    );
    chmodSync(gh, 0o755);
    const output = join(directory, "output");
    writeFileSync(output, "");
    const run = spawnSync(
      "bash",
      [
        "-c",
        runBody(
          backupPath,
          "Verify exact completed manual origin before cloud access",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"]}`,
          CALLS: calls,
          FIXTURE: fixturePath,
          JOBS_FIXTURE: jobsPath,
          FAIL_GH: fail ? "1" : "0",
          ORIGIN_RUN_ID: "123",
          ORIGIN_ATTEMPT: "1",
          ORIGIN_SOURCE_SHA: "a".repeat(40),
          GITHUB_REPOSITORY: "david-cui-bruno/founding-sales",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
        },
      },
    );
    return {
      code: run.status,
      output: run.stdout + run.stderr,
      receipt: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it("backup accepts only the exact completed manual main origin and emits only its source binding", () => {
  const result = originRun();
  expect(result.code, result.output).toBe(0);
  expect(result.receipt).toBe(
    `source_commit=${"a".repeat(40)}\ncleanup_required=true\n`,
  );
  expect(result.output).not.toContain("private-response-sentinel");
});
it.each([
  { event: "push" },
  { head_branch: "feature" },
  { id: 999 },
  { run_attempt: 2 },
  { head_sha: "b".repeat(40) },
  { status: "in_progress" },
  { head_repository: { full_name: "untrusted/fork" } },
  { workflow_id: "456" },
])(
  "backup refuses mismatched or unverified origin before obtaining cleanup authority: %j",
  (change) => {
    const result = originRun(change);
    expect(result.code).toBe(1);
    expect(result.receipt).toBe("");
    expect(result.output).toContain("diagnostic origin refused or unavailable");
  },
);
it("unknown GitHub status never becomes absence or exposes a private remote error", () => {
  const result = originRun({}, true);
  expect(result.code).toBe(1);
  expect(result.receipt).toBe("");
  expect(result.output).not.toContain("private-response-sentinel");
});
it("the primary is default-off manual-only and backup cannot recursively acquire or apply", () => {
  const primary = readFileSync(
    resolve(".github/workflows/crm-acquisition-diagnostic.yml"),
    "utf8",
  );
  const backup = readFileSync(resolve(backupPath), "utf8");
  expect(primary).toContain("default: disabled");
  expect(primary).toContain("workflow_dispatch:");
  expect(primary).not.toMatch(
    /workflow_run:|schedule:|pull_request:|^ {2}push:/mu,
  );
  expect(backup).toMatch(
    /workflows: \[["']CRM acquisition diagnostic lifecycle["']\]/u,
  );
  expect(backup).not.toMatch(
    /workflow_dispatch:|schedule:|terraform apply|put-secret-value|diagnostic-handoff.mjs prepare/u,
  );
  for (const workflow of [primary, backup]) {
    expect(workflow).toContain("group: greenfield-rehearsal");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: rehearsal");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("upload-artifact");
  }
});

function frozenInputs(digestCorrect: boolean, sourceCorrect = true) {
  const directory = mkdtempSync(join(tmpdir(), "fss-private-workflow-"));
  try {
    const document = JSON.stringify({
      sourceCommit: sourceCorrect ? "a".repeat(40) : "b".repeat(40),
      privateReview: "private-document-sentinel",
    });
    const digest = createHash("sha256").update(document).digest("hex");
    const envOutput = join(directory, "env");
    writeFileSync(envOutput, "");
    const run = spawnSync(
      "bash",
      [
        "-c",
        runBody(
          ".github/workflows/crm-acquisition-diagnostic.yml",
          "Freeze reviewed private inputs before cloud access",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          GITHUB_ENV: envOutput,
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: "a".repeat(40),
          DIAGNOSTIC_STAGE: "lifecycle",
          REVIEWED_SHA256: digestCorrect ? digest : "0".repeat(64),
          LEASE_JSON: document,
          PRIVATE_GOOGLE_JSON: JSON.stringify({
            oidc: { client_secret: "private-google-sentinel" },
            gmail: { client_secret: "private-google-sentinel" },
          }),
        },
      },
    );
    let stored = "";
    try {
      stored = readFileSync(
        join(directory, "diagnostic-inputs/lease.json"),
        "utf8",
      );
    } catch {
      /* refusal creates no approved file */
    }
    return {
      code: run.status,
      output: run.stdout + run.stderr,
      stored,
      exported: readFileSync(envOutput, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
it("freezes exact reviewed private bytes without exporting Google inputs or printing documents", () => {
  const result = frozenInputs(true);
  expect(result.code, result.output).toBe(0);
  expect(result.stored).toContain("private-document-sentinel");
  expect(result.exported).toBe("");
  expect(result.output).not.toMatch(
    /private-document-sentinel|private-google-sentinel/u,
  );
});
it.each([
  [false, true],
  [true, false],
])(
  "refuses changed approval or source before writing an accepted lease: %j",
  (hash, source) => {
    const result = frozenInputs(hash, source);
    expect(result.code).toBe(1);
    expect(result.stored).toBe("");
    expect(result.output).not.toMatch(
      /private-document-sentinel|private-google-sentinel/u,
    );
  },
);
it("refreshes identity before cleanup on failure and never uploads private working files", () => {
  const primary = readFileSync(
    resolve(".github/workflows/crm-acquisition-diagnostic.yml"),
    "utf8",
  );
  expect(primary).toContain(
    "if: always() && inputs.stage == 'lifecycle' && steps.inputs.outcome == 'success' && steps.validate.outcome == 'success'",
  );
  expect(primary).toContain(
    "if: always() && steps.cleanup_role.outcome == 'success'",
  );
  expect(
    primary.indexOf(
      "Refresh the normal role before unconditional owned cleanup",
    ),
  ).toBeLessThan(
    primary.indexOf(
      "Clean exact owned lease after expiry failure or cancellation",
    ),
  );
  expect(primary).toContain(
    '< "$RUNNER_TEMP/diagnostic-inputs/google.private.json"',
  );
  expect(primary).not.toMatch(
    /echo .*GOOGLE|cat .*google|upload-artifact|PRIVATE KEY/u,
  );
});

it.each([
  { conclusion: "skipped", steps: [] },
  {
    steps: [
      {
        name: "Apply only the exact approved saved plan",
        status: "completed",
        conclusion: "skipped",
      },
      {
        name: "Clean exact owned lease after expiry failure or cancellation",
        status: "completed",
        conclusion: "skipped",
      },
    ],
  },
  {
    steps: [
      {
        name: "Apply only the exact approved saved plan",
        status: "completed",
        conclusion: "failure",
      },
      {
        name: "Clean exact owned lease after expiry failure or cancellation",
        status: "completed",
        conclusion: "success",
      },
    ],
  },
])(
  "disabled, proposal, prerequisite refusal or verified cleanup does not acquire a backup cloud session: %j",
  (job) => {
    const result = originRun({}, false, job);
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toContain("cleanup_required=false");
  },
);
it("missing cleanup evidence is an unavailable proof, never absence or a successful cleanup", () => {
  const result = originRun({}, false, { steps: [] });
  expect(result.code).toBe(1);
  expect(result.receipt).toBe("");
});
