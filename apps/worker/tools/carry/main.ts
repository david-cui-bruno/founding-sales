import { CARRY_EXIT_CODES, main } from './cli.ts';

/**
 * The carry tool's entry point (lane G11).
 *
 * `node --experimental-transform-types apps/worker/tools/carry/main.ts <subcommand>`,
 * run from an operator's laptop under the operator role. It is not in the worker
 * image: `Dockerfile.worker.dockerignore` allows `apps/worker/src` back into the
 * build context and nothing else, so `tools/` never ships. That is deliberate — the
 * carry is a one-time operation with AWS credentials and a decryption identity, and
 * a production container has no business being able to run it.
 */

main(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The message, never the stack and never a value that could be a connection
    // string: an operator's terminal is not a redacted log.
    console.error(`carry failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = CARRY_EXIT_CODES.failed;
  });
