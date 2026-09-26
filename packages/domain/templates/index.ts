/**
 * Template versions: created, edited in place and approved (specification 11.1, 12.6; wave 2, S3).
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
  updateTemplateVersion,
  type CreateTemplateVersionInput,
  type RenderDecision,
  type TemplateRefusalCode,
  type TemplateResult,
  type TemplateSaveResult,
  type TemplateTextInput,
  type TemplateVersionRow,
  type TemplateVersionWithWarnings,
  type UpdateTemplateVersionInput,
} from './templates.ts';
