/**
 * The structured-outputs rules a provider schema must keep, walked over every node
 * (the walker C3b wrote for the call summary, copied here for the reply classifier; the
 * two can be merged when both lanes are on main):
 *
 *   * an enum's values are each of the node's declared type;
 *   * an enum is never beside a type list: a nullable value is `anyOf` with `{ type: 'null' }`;
 *   * every object is closed (`additionalProperties: false`) and requires every property;
 *   * none of the constraints the API refuses: length, numeric, array size, pattern.
 *
 * Learned from the real API's 400 on 1 Oct 2026: `output_config.format.schema: Invalid
 * schema: Enum value 'interested' does not match declared type '['string', 'null']'`.
 */
export function schemaProblems(node: unknown, path = '$'): string[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap((child, index) => schemaProblems(child, `${path}[${String(index)}]`));
  const schema = node as Record<string, unknown>;
  const problems: string[] = [];
  const declared = schema['type'] === undefined ? null : Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
  if (Array.isArray(schema['enum'])) {
    if (declared === null) problems.push(`${path}: enum without a type`);
    else {
      if (declared.length !== 1) problems.push(`${path}: enum beside a type list ${JSON.stringify(declared)}`);
      for (const value of schema['enum'] as unknown[]) {
        const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
        if (!declared.includes(kind) && !(kind === 'integer' && declared.includes('number'))) problems.push(`${path}: enum value ${JSON.stringify(value)} is not ${JSON.stringify(declared)}`);
      }
    }
  }
  for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'pattern']) {
    if (banned in schema) problems.push(`${path}: ${banned} is not supported`);
  }
  if (declared?.includes('object')) {
    if (schema['additionalProperties'] !== false) problems.push(`${path}: an object must set additionalProperties: false`);
    const keys = Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {}).sort();
    const required = [...((schema['required'] as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(required)) problems.push(`${path}: required ${JSON.stringify(required)} is not every property ${JSON.stringify(keys)}`);
  }
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'enum' || key === 'required') continue;
    problems.push(...schemaProblems(child, `${path}.${key}`));
  }
  return problems;
}
