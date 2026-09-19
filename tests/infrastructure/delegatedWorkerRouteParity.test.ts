import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Offline parity between the worker handler's HTTP path literals and the API
// Gateway route keys Terraform provisions. Text only: no Terraform binary,
// TypeScript compiler, subprocess or network. A handler path with no route is
// unreachable in production (the gateway answers 404 before the Lambda runs);
// a route with no handler path is dead (the handler itself answers 404).
// The handler serves the old routes itself and mounts the rebuilt core's `/v1` routes from src/v1/router.ts
// (S0), so both files are read: a path literal in either is a path the one Lambda serves.
const workerSourceFiles = ["cloud/lambdas/delegated-worker/src/handler.ts", "cloud/lambdas/delegated-worker/src/v1/router.ts"] as const;
const workerSources = workerSourceFiles.map((file) => readFileSync(join(process.cwd(), file), "utf8"));
const terraformSource = readFileSync(join(process.cwd(), "cloud/terraform/modules/delegated-worker/main.tf"), "utf8");

// Handler paths deliberately served without an API Gateway route. None is
// known. Any entry must name the path and explain why it stays internal.
const internalHandlerPaths: readonly string[] = [];

// Handler conditions are written one per line, so a method literal on the same
// line as a path literal is that path's method. A path whose line names no
// method (query allow-lists, scope selection) still needs a route under some method.
const pathComparison = /\b(?:path|rawPath)\s*(?:===|!==)\s*(['"])(\/[^'"\s]*)\1/g;
const pathList = /\[((?:\s*['"]\/[^'"\s]*['"]\s*,?)+)\]\.includes\((?:[\w$]+\.)*(?:path|rawPath)\)/g;
const quotedPath = /['"](\/[^'"\s]*)['"]/g;
const methodComparison = /\bmethod\s*(?:===|!==)\s*['"]([A-Z]+)['"]/g;

const handlerPaths = new Set<string>();
const handlerRoutes = new Set<string>();
// How many path literals each worker source contributed, so a refactor that hid them cannot silently empty the check.
const literalsPerSource: number[] = [];
for (const source of workerSources) {
  let literals = 0;
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const line of uncommented.split("\n")) {
    const paths = [
      ...[...line.matchAll(pathComparison)].map((match) => match[2]),
      ...[...line.matchAll(pathList)].flatMap((match) => [...match[1].matchAll(quotedPath)].map((inner) => inner[1])),
    ];
    const methods = new Set([...line.matchAll(methodComparison)].map((match) => match[1]));
    const [method] = methods;
    for (const path of paths) {
      literals += 1;
      handlerPaths.add(path);
      if (methods.size === 1 && method) handlerRoutes.add(`${method} ${path}`);
    }
  }
  literalsPerSource.push(literals);
}

const routeList = /delegated_routes\s*=\s*toset\(\[([\s\S]*?)\]\)/.exec(terraformSource);
if (!routeList) throw new Error("Missing local.delegated_routes in cloud/terraform/modules/delegated-worker/main.tf");
const terraformRoutes = [...routeList[1].matchAll(/"([A-Z]+ \/[^"\s]*)"/g)].map((match) => match[1]);
const terraformPaths = new Set(terraformRoutes.map((route) => route.split(" ")[1]));
const pathOf = (route: string): string => route.split(" ")[1];

describe("delegated-worker handler and Terraform route parity", () => {
  it("reads both real sources and drives the API gateway route keys from the same set", () => {
    expect(handlerPaths.size).toBeGreaterThan(0);
    for (const [index, count] of literalsPerSource.entries()) expect(count, `${workerSourceFiles[index]} path literals`).toBeGreaterThan(0);
    expect(terraformRoutes.length).toBeGreaterThan(0);
    expect(new Set(terraformRoutes).size).toBe(terraformRoutes.length);
    for (const route of terraformRoutes) expect(route).toMatch(/^(?:GET|POST) \/[a-z0-9/-]+$/);
    const resource = /resource "aws_apigatewayv2_route" "delegated_worker" \{([\s\S]*?)\n\}/.exec(terraformSource);
    expect(resource).not.toBeNull();
    const body = (resource as RegExpExecArray)[1].replace(/\s+/g, " ");
    expect(body).toContain("for_each = var.delegated_worker_enabled ? local.delegated_routes : toset([])");
    expect(body).toContain("route_key = each.value");
    for (const path of internalHandlerPaths) {
      expect(handlerPaths.has(path), `internal exception ${path} is no longer a handler path`).toBe(true);
      expect(terraformPaths.has(path), `internal exception ${path} is routed anyway`).toBe(false);
    }
  });

  it("exposes every handler path literal as an API gateway route", () => {
    const missing = [...handlerPaths].filter((path) => !internalHandlerPaths.includes(path) && !terraformPaths.has(path)).sort();
    expect(missing, "handler paths without a local.delegated_routes entry").toEqual([]);
    const missingRoutes = [...handlerRoutes].filter((route) => !internalHandlerPaths.includes(pathOf(route)) && !terraformRoutes.includes(route)).sort();
    expect(missingRoutes, "handler METHOD /path pairs without a matching route key").toEqual([]);
  });

  it("provisions no route the handler does not serve", () => {
    const dead = terraformRoutes.filter((route) => !handlerPaths.has(pathOf(route))).sort();
    expect(dead, "route keys without a handler path literal").toEqual([]);
    const wrongMethod = terraformRoutes.filter((route) => {
      const pinned = [...handlerRoutes].filter((candidate) => pathOf(candidate) === pathOf(route));
      return pinned.length > 0 && !pinned.includes(route);
    }).sort();
    expect(wrongMethod, "route keys whose method the handler never accepts for that path").toEqual([]);
  });
});
