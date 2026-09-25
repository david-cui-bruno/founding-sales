import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stand-ins for the three CLIs lane g74's scripts call — `gh`, `aws` and `docker` —
 * for the offline checks in `weeklyRehearsal.check.ts` and `releaseManifest.check.ts`.
 *
 * Each is a small Python program, written to a temporary directory, that answers from a
 * JSON state file and appends every call to a log, one JSON line per call. The log is
 * what lets a check assert what a script did *not* do — no write to a rehearsal
 * repository, no issue opened on a fresh day — which an answer-only stub cannot.
 *
 * `gh api -F body=@file` arguments are read at call time and logged, because the
 * scripts delete their working directory on exit.
 */

export interface StubCall {
  readonly args: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface Stub {
  /** The executable to pass as the seam (`FSS_GH_COMMAND`, `FSS_REHEARSAL_AWS_COMMAND`, `FSS_DOCKER_COMMAND`). */
  readonly command: string;
  calls(): readonly StubCall[];
  /** The state file as it is now; the docker stub writes the copies it makes into it. */
  state(): Record<string, unknown>;
}

const GH_PROGRAM = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
state = json.load(open(os.path.join(here, "state.json")))
args = sys.argv[1:]
entry = {"args": args}
for index, arg in enumerate(args):
    if arg in ("-F", "-f") and index + 1 < len(args):
        key, _, value = args[index + 1].partition("=")
        if value.startswith("@") and os.path.exists(value[1:]):
            entry.setdefault("files", {})[key] = open(value[1:]).read()
with open(os.path.join(here, "calls-" + os.path.basename(__file__) + ".jsonl"), "a") as handle:
    handle.write(json.dumps(entry) + "\\n")
if args[:2] == ["run", "download"]:
    run = args[2]
    directory = args[args.index("--dir") + 1]
    content = (state.get("downloads") or {}).get(run)
    if content is None:
        sys.stderr.write("no artifact named fss-image-digests in run " + run + "\\n")
        sys.exit(1)
    os.makedirs(directory, exist_ok=True)
    open(os.path.join(directory, "image-digests.json"), "w").write(content)
    sys.exit(0)
if args[:1] == ["api"]:
    if args[1] == "graphql":
        print(json.dumps({"data": {}}))
        sys.exit(int(state.get("graphqlExit", 0)))
    method = args[args.index("-X") + 1] if "-X" in args else "GET"
    path = next(arg for arg in args[1:] if arg.startswith("repos/"))
    key = method + " " + path
    routes = state.get("routes") or {}
    if key in routes:
        answer = routes[key]
        print(answer if isinstance(answer, str) else json.dumps(answer))
        sys.exit(0)
    sys.stderr.write("gh: Not Found (HTTP 404) " + key + "\\n")
    sys.exit(1)
sys.stderr.write("the gh stub does not know: " + " ".join(args) + "\\n")
sys.exit(2)
`;

const AWS_PROGRAM = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "state.json")
state = json.load(open(path))
args = sys.argv[1:]
with open(os.path.join(here, "calls-" + os.path.basename(__file__) + ".jsonl"), "a") as handle:
    handle.write(json.dumps({"args": args}) + "\\n")

def value(flag):
    return args[args.index(flag) + 1] if flag in args else None

def not_found(what):
    sys.stderr.write("An error occurred (ImageNotFoundException) when calling the DescribeImages operation: " + what + "\\n")
    sys.exit(254)

registry = state.get("registry", "123456789012.dkr.ecr.us-east-1.amazonaws.com")
if args[:2] == ["ecr", "get-login-password"]:
    print("not-a-real-password")
    sys.exit(0)
if args[:2] == ["ecr", "describe-repositories"]:
    name = value("--repository-names")
    if name not in (state.get("repositories") or {}):
        sys.stderr.write("An error occurred (RepositoryNotFoundException)\\n")
        sys.exit(254)
    print(registry + "/" + name)
    sys.exit(0)
if args[:2] == ["ecr", "describe-images"]:
    repository = (state.get("repositories") or {}).get(value("--repository-name"))
    if repository is None:
        sys.stderr.write("An error occurred (RepositoryNotFoundException)\\n")
        sys.exit(254)
    identifier = value("--image-ids")
    kind, _, wanted = identifier.partition("=")
    if kind == "imageDigest":
        if wanted in repository.get("digests", []):
            print(wanted)
            sys.exit(0)
        not_found(identifier)
    if kind == "imageTag":
        digest = (repository.get("tags") or {}).get(wanted)
        if digest:
            print(digest)
            sys.exit(0)
        not_found(identifier)
if args[:2] == ["ecs", "describe-services"]:
    name = value("--services")
    service = (state.get("services") or {}).get(name)
    if service is None:
        print(json.dumps({"services": [], "failures": [{"arn": name, "reason": "MISSING"}]}))
        sys.exit(0)
    print(json.dumps({"services": [dict(service, serviceName=name)]}))
    sys.exit(0)
if args[:2] == ["ecs", "describe-task-definition"]:
    arn = value("--task-definition")
    definition = (state.get("taskDefinitions") or {}).get(arn)
    if definition is None:
        sys.stderr.write("An error occurred (ClientException) when calling the DescribeTaskDefinition operation\\n")
        sys.exit(254)
    print(json.dumps(definition))
    sys.exit(0)
sys.stderr.write("the aws stub does not know: " + " ".join(args) + "\\n")
sys.exit(2)
`;

const DOCKER_PROGRAM = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "state.json")
state = json.load(open(path))
args = sys.argv[1:]
entry = {"args": args}
if args[:1] == ["login"]:
    entry["stdin"] = sys.stdin.read()
with open(os.path.join(here, "calls-" + os.path.basename(__file__) + ".jsonl"), "a") as handle:
    handle.write(json.dumps(entry) + "\\n")
if args[:1] == ["login"]:
    sys.exit(0)
if args[:3] == ["buildx", "imagetools", "create"]:
    destination = args[args.index("--tag") + 1]
    source = args[-1]
    name_and_tag = destination.rsplit("/", 1)[1]
    name, _, tag = name_and_tag.partition(":")
    digest = source.rsplit("@", 1)[1]
    if state.get("copyChangesDigest"):
        digest = "sha256:" + "f" * 64
    repository = state["repositories"][name]
    repository.setdefault("tags", {})[tag] = digest
    repository.setdefault("digests", []).append(digest)
    json.dump(state, open(path, "w"))
    sys.exit(0)
sys.stderr.write("the docker stub does not know: " + " ".join(args) + "\\n")
sys.exit(2)
`;

function stub(program: string, name: string, state: unknown, directory?: string): Stub {
  const home = directory ?? mkdtempSync(join(tmpdir(), `fss-${name}-stub-`));
  const command = join(home, name);
  writeFileSync(command, program);
  chmodSync(command, 0o755);
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  return {
    command,
    calls: () => {
      const log = join(home, `calls-${name}.jsonl`);
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as StubCall);
    },
    state: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as Record<string, unknown>,
  };
}

/** `gh`: `routes` maps `"<METHOD> repos/…"` to an answer; `downloads` maps a run id to `image-digests.json`. */
export function ghStub(state: {
  readonly routes?: Readonly<Record<string, unknown>>;
  readonly downloads?: Readonly<Record<string, string>>;
  readonly graphqlExit?: number;
}): Stub {
  return stub(GH_PROGRAM, 'gh', state);
}

/**
 * `aws` and `docker`, sharing one state so a copy `docker` makes is what `aws` reads back:
 * `repositories` maps a name to `{ tags, digests }`, `services` a service name to what
 * `describe-services` reports, `taskDefinitions` an ARN to its definition.
 */
export function registryStubs(state: Readonly<Record<string, unknown>>): { readonly aws: Stub; readonly docker: Stub } {
  const home = mkdtempSync(join(tmpdir(), 'fss-registry-stub-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  return { aws: stub(AWS_PROGRAM, 'aws', state, home), docker: stub(DOCKER_PROGRAM, 'docker', state, home) };
}
