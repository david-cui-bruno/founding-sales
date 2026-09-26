import { TEMPLATE_VARIABLE_NAMES, type TemplateVariableName } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * Deterministic template variables from eligible CRM data (specification 11.1).
 *
 * "Launch templates support deterministic variables from eligible CRM data." The
 * whole list is here, it is closed, and every entry is a column somebody typed or a
 * provider produced — never a derivation that guesses.
 *
 * The one derivation is `contact_first_name`, and its rule is stricter than it looks.
 * A first name is the first whitespace-separated token of the recorded full name,
 * *and it must contain a letter and be at least two characters*. A contact recorded
 * as `?`, `-` or `N/A` has no eligible first name, so the variable is absent and
 * 11.1's "Missing required variables hold the step" applies. The alternative is an
 * email beginning "Hello ?," which is worse than an email that did not go out. See
 * `docs/decisions/g8-deterministic-variables.md`.
 *
 * An absent value is *absent*, never an empty string: `renderTemplate` treats a
 * blank as missing, and a map that carried `''` would be a map that rendered a gap.
 */

// The list is `@fss/contracts`', so the Mac's template form names the same seven; it is re-exported here so every importer of this module is unchanged.
export { TEMPLATE_VARIABLE_NAMES, type TemplateVariableName };

const PLACEHOLDER_NAMES = new Set(['n/a', 'na', 'unknown', 'none', 'tbd', 'null']);

/** The first token of a full name, when it is plausibly a name. */
export function firstNameOf(fullName: string): string | null {
  const token = fullName.trim().split(/\s+/u)[0] ?? '';
  if (token.length < 2) return null;
  if (!/\p{L}/u.test(token)) return null;
  if (PLACEHOLDER_NAMES.has(token.toLowerCase())) return null;
  return token;
}

const present = (value: string | null): string | undefined => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

interface VariableDbRow {
  readonly firm_name: string;
  readonly locality: string | null;
  readonly region_code: string | null;
  readonly website: string | null;
  readonly full_name: string;
  readonly title: string | null;
  readonly [column: string]: unknown;
}

/**
 * Every variable this system can fill for one contact. Names absent from the map are
 * the ones the CRM has no eligible value for.
 */
export async function templateVariablesFor(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly contactId: string },
): Promise<Readonly<Record<string, string>>> {
  const { rows } = await context.db.query<VariableDbRow>(
    `SELECT f.name AS firm_name, f.locality, f.region_code, f.website, c.full_name, c.title
       FROM contacts c
       JOIN firms f ON f.workspace_id = c.workspace_id AND f.id = c.firm_id
      WHERE c.workspace_id = $1 AND c.id = $2 AND c.firm_id = $3`,
    [context.scope.workspaceId, input.contactId, input.firmId],
  );
  const row = rows[0];
  if (row === undefined) return {};

  const values: Record<string, string> = {};
  const set = (name: TemplateVariableName, value: string | undefined): void => {
    if (value !== undefined) values[name] = value;
  };
  set('firm_name', present(row.firm_name));
  set('firm_locality', present(row.locality));
  set('firm_region', present(row.region_code));
  set('firm_website', present(row.website));
  set('contact_full_name', present(row.full_name));
  set('contact_title', present(row.title));
  set('contact_first_name', present(firstNameOf(row.full_name)));
  return values;
}
