/**
 * Approved immutable template versions (specification 11.1, 12.6).
 *
 * The table is migration 0009's and the rules are `packages/domain/src/rules/templates.ts`;
 * this package is the repository between them. See `docs/greenfield/sequences.md`.
 */

export {
  TEMPLATE_REFUSAL_CODES,
  approveTemplateVersion,
  createTemplateVersion,
  listTemplateVersions,
  readTemplateVersion,
  renderTemplateVersion,
  retireTemplateVersion,
  type CreateTemplateVersionInput,
  type RenderDecision,
  type TemplateRefusalCode,
  type TemplateResult,
  type TemplateVersionRow,
  type TemplateVersionWithWarnings,
} from './templates.ts';
