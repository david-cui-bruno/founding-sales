/**
 * Every bridge forgets what it was holding when the person changes (1.0.13, P0-A).
 *
 * The main process holds a snapshot per view: the CRM bridge holds the firm page and
 * the board, the settings bridge holds the settings, the stages, the figures and the
 * numbers, Today holds the expanded firm and the last call. None of that belongs to
 * the *next* person to sign in on this Mac, and until the review of 1.0.13 only the
 * reply bridge was cleared on a transition — the others answered their next read from
 * the last person's snapshot.
 *
 * Two things are needed and this file is both.
 *
 * **Reset.** `resetBridges` clears every one of them, and `registerWindows` calls it on
 * every announcement the session manager makes: a sign-out confirmed or pending,
 * another workspace, a role the server now gives, a revocation.
 *
 * **Drop what was already on the wire.** A read started before the transition answers
 * after it, and storing that answer would put the last person's firm back into the
 * bridge the next one is reading. `guardIdentity` wraps a host so that every method
 * notes the session generation it began under and, if the number has moved by the time
 * it answers, clears the bridge again and answers the empty state instead. One wrapper
 * rather than a check at every `await` inside five files: the second clear throws away
 * whatever the late method stored, which is the same guarantee and one place to read.
 */

/** Anything with a `forget` that clears it and answers its empty state. */
export interface Forgettable {
  forget(): Promise<unknown>;
}

/**
 * Wrap a bridge so a method that outlived its session answers the empty state.
 *
 * `generation` is the session manager's own counter, so "the session this began under"
 * is the same fact the renderer's guard and the authenticated client use.
 */
export function guardIdentity<H extends Forgettable>(host: H, generation: () => number): H {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(host)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    const method = value as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] =
      name === 'forget'
        ? method.bind(host)
        : async (...args: unknown[]): Promise<unknown> => {
            const mine = generation();
            const answer = await method.apply(host, args);
            if (mine === generation()) return answer;
            /*
             * Somebody else is signed in now, or nobody is. Whatever this stored goes
             * with the rest of the last person's state, and the caller gets nothing.
             *
             * **Why it clears rather than stepping aside.** By the time this line runs
             * the host has *already* stored the late answer: the write is inside
             * `method`, which has returned. Leaving it because a newer session has since
             * filled the bridge would leave the last person's firm page sitting beside
             * the new person's — a bridge holds a snapshot per view, and a newer read
             * only replaces the views it touches. Clearing costs the new session one
             * re-read; not clearing is the leak this file exists to stop.
             *
             * `forget()` is itself asynchronous, so the generation is taken again before
             * it and checked after (P2): another transition during the clear means
             * something may have landed behind it, and it is cleared once more.
             */
            const at = generation();
            const empty = await host.forget();
            return at === generation() ? empty : await host.forget();
          };
  }
  return wrapped as H;
}

/** Clear every bridge. Called on every identity transition, in the order they appear. */
export async function resetBridges(bridges: readonly Forgettable[]): Promise<void> {
  for (const bridge of bridges) await bridge.forget();
}
