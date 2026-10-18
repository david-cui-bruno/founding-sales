import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { statementsOf } from './sql.ts';

const RIGHTS = ['SELECT', 'UPDATE', 'USAGE'] as const;
const ROLES = ['app_runtime', 'migration'] as const;
const nameOf = (raw: string): string => {
  const name = raw.trim().replace(/^(?:public|"public")\./iu, '');
  if (!/^(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")$/iu.test(name)) throw new Error('UNSUPPORTED_SEQUENCE_GRANT_NAME');
  return name.replaceAll('"', '').toLowerCase();
};

/** Explicit sequence grants belong to sequence ACLs, never the table replay. */
export function declaredSequenceGrantDifferences(
  directory: string, after: number, through: number,
  baseline: readonly string[], live: readonly string[],
): readonly { role: string; object: string; detail: string }[] {
  const expected = new Set(baseline);
  const named = new Set<string>();
  for (const file of readdirSync(directory).sort()) {
    const version = /^(\d{4})_[a-z0-9_]+\.sql$/u.exec(file)?.[1];
    if (version === undefined || Number(version) <= after || Number(version) > through) continue;
    for (const statement of statementsOf(readFileSync(join(directory, file), 'utf8'))) {
      const grant = /^(GRANT|REVOKE)\s+([\s\S]+?)\s+ON\s+SEQUENCE\s+([\s\S]+?)\s+(?:TO|FROM)\s+([^;]+);?$/iu.exec(statement.normalized);
      if (!grant) continue;
      const privileges = grant[2]!.split(',').flatMap(raw => {
        const right = raw.trim().toUpperCase();
        if (/^ALL(?:\s+PRIVILEGES)?$/u.test(right)) return RIGHTS;
        if (!RIGHTS.some(allowed => allowed === right)) throw new Error('UNSUPPORTED_SEQUENCE_GRANT_PRIVILEGE');
        return [right];
      });
      const roles = grant[4]!.split(',').map(nameOf).filter(role => ROLES.some(compared => compared === role));
      for (const name of grant[3]!.split(',').map(nameOf)) {
        named.add(name);
        for (const role of roles) for (const right of privileges) {
          const key = `${role} | ${name} | ${right}`;
          if (grant[1]!.toUpperCase() === 'GRANT') expected.add(key);
          else expected.delete(key);
        }
      }
    }
  }
  const actual = new Set(live);
  const differences: { role: string; object: string; detail: string }[] = [];
  for (const name of named) for (const role of ROLES) {
    const missing = RIGHTS.filter(right => expected.has(`${role} | ${name} | ${right}`) && !actual.has(`${role} | ${name} | ${right}`));
    const extra = RIGHTS.filter(right => !expected.has(`${role} | ${name} | ${right}`) && actual.has(`${role} | ${name} | ${right}`));
    if (missing.length || extra.length) differences.push({ role, object: `sequence ${name}`, detail: [
      missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `unexpected ${extra.join(', ')}` : '',
    ].filter(Boolean).join('; ') });
  }
  return differences;
}
