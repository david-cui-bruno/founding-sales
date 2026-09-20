/**
 * Where a secret comes from (invariant 6, 4.1).
 *
 * "No secrets are stored in the repository." The Gmail OAuth client secret is the
 * one the mail lane needs, and it arrives the same way the database password does:
 * the ECS task definition's `secrets` block injects the *value* of a Secrets Manager
 * entry into an environment variable, and the process reads it once at startup.
 *
 * Everything in this lane takes a `SecretProvider` rather than a string, for three
 * reasons that are all about what cannot then happen. A command cannot put the secret
 * in a log line, because it never holds one long enough to be tempted. A test cannot
 * contain one, because `generatedSecretProvider` makes a random value when the test
 * starts. And the value never becomes part of a structure that gets serialized: the
 * provider is a function, and a function does not appear in a JSON error body.
 *
 * `describeSecretProvider` exists so a startup line can say *which* secrets are
 * configured without saying what any of them is.
 */

export const MAIL_SECRET_NAMES = ['gmail_oauth_client_secret'] as const;
export type MailSecretName = (typeof MAIL_SECRET_NAMES)[number];

export class SecretProviderError extends Error {
  constructor(
    readonly code: 'SECRET_MISSING' | 'SECRET_EMPTY',
    readonly secretName: string,
  ) {
    // The message names the secret, never its value, and never the variable's contents.
    super(`the secret ${secretName} is not configured`);
    this.name = 'SecretProviderError';
  }
}

export interface SecretProvider {
  /** Throws `SecretProviderError` rather than returning a placeholder. Fails closed. */
  read(name: MailSecretName): Promise<string>;
  /** Which names this provider can answer. Never the values. */
  names(): readonly MailSecretName[];
}

/** The environment variable a secret name arrives in, per the task definition. */
export const SECRET_ENVIRONMENT_VARIABLES: Readonly<Record<MailSecretName, string>> = Object.freeze({
  gmail_oauth_client_secret: 'FSS_GMAIL_OAUTH_CLIENT_SECRET',
});

/**
 * Read the injected values once, at construction, and hold nothing else.
 *
 * The environment object is read here and never again, so a later mutation of
 * `process.env` — by a test, by a dependency — cannot change what the process
 * believes its secret is halfway through its life.
 */
export function environmentSecretProvider(
  environment: Readonly<Record<string, string | undefined>>,
): SecretProvider {
  const held = new Map<MailSecretName, string>();
  for (const name of MAIL_SECRET_NAMES) {
    const value = environment[SECRET_ENVIRONMENT_VARIABLES[name]];
    if (value !== undefined && value.trim().length > 0) held.set(name, value);
  }
  return {
    read: async name => {
      await Promise.resolve();
      const value = held.get(name);
      if (value === undefined) throw new SecretProviderError('SECRET_MISSING', name);
      return value;
    },
    names: () => [...held.keys()],
  };
}

/**
 * A provider over values the caller made. Tests use it with `randomBytes`, so the
 * repository contains no secret and no secret-shaped literal.
 */
export function staticSecretProvider(values: Readonly<Partial<Record<MailSecretName, string>>>): SecretProvider {
  const held = new Map<MailSecretName, string>();
  for (const name of MAIL_SECRET_NAMES) {
    const value = values[name];
    if (value !== undefined && value.length > 0) held.set(name, value);
  }
  return {
    read: async name => {
      await Promise.resolve();
      const value = held.get(name);
      if (value === undefined) throw new SecretProviderError('SECRET_MISSING', name);
      return value;
    },
    names: () => [...held.keys()],
  };
}

/** For the startup line: the names that are configured, and no value. */
export function describeSecretProvider(provider: SecretProvider): { readonly configuredSecrets: string } {
  return { configuredSecrets: [...provider.names()].sort().join(' ') };
}
