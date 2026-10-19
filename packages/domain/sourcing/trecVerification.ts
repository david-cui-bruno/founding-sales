/** Legacy trecfile.txt only. Official field dictionary:
 * https://www.trec.texas.gov/public/trec-public-information-files-instructions
 * Portal exports have a different, unresolved schema and are deliberately unsupported. */
export const TREC_INSTRUCTIONS_URL = 'https://www.trec.texas.gov/public/trec-public-information-files-instructions';
export const TREC_LIMITS = {bytes: 256 * 1024 * 1024, rows: 500_000, lineBytes: 4096, organizations: 50_000, firms: 1000} as const;
export const TREC_STATUSES = {
  '20': 'Current and Active', '21': 'Current and Inactive',
  '30': 'Probation and Active', '31': 'Probation and Inactive',
  '45': 'Expired', '47': 'Suspended', '56': 'Relinquished', '57': 'Revoked', '80': 'Deceased',
} as const;
export type TrecStatus = keyof typeof TREC_STATUSES;
export type TrecOrganization = {
  licenseType: 'BLLC' | 'BCRP'; licenseNumber: string; legalName: string;
  status: TrecStatus; originalLicenseDate: string | null; expirationDate: string | null;
  mailingCountyCode: string | null; physicalCountyCode: string | null; agencyIdentifier: string;
};
export type TrecMetadata = {sourceUrl: string; retrievedAt: string; sourceUpdatedAt: string | null};
export type TrecExistingFirm = {
  firmId: string; legalName: string; mailingCountyCode: string;
  license?: {type: 'BLLC' | 'BCRP'; number: string};
};
export function trecDate(value: string): string | null {
  if (value === '') return null;
  if (!/^\d{8}$/u.test(value)) throw new Error('invalid_trec_date');
  const date = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new Error('invalid_trec_date');
  return date;
}
function county(value: string): string | null {
  if (value === '' || value === '999') return null;
  if (!/^\d{1,3}$/u.test(value)) throw new Error('invalid_trec_county');
  return value;
}
/** Excludes individuals before splitting or retaining any fields. Never include row content in errors. */
export function parseTrecOrganization(line: string): TrecOrganization | null {
  if (Buffer.byteLength(line) > TREC_LIMITS.lineBytes) throw new Error('trec_line_too_large');
  const separator = line.indexOf('\t');
  const type = separator < 0 ? line : line.slice(0,separator);
  if (type !== 'BLLC' && type !== 'BCRP') return null;
  const f = line.split('\t');
  // Agency identifier is position 32. Final Key Name is labelled 32 again in the official dictionary.
  if (f.length !== 33) throw new Error('invalid_trec_columns');
  const number = f[1]!, name = f[2]!, status = f[4]!;
  if (!/^\d+(?:-\d+)?$/u.test(number) || number.length > 10 || !name.trim() || name.length > 64 || Array.from(name).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || !Object.hasOwn(TREC_STATUSES, status) || !/^\d{1,10}$/u.test(f[31]!)) throw new Error('invalid_trec_organization');
  return {licenseType:type, licenseNumber:number, legalName:name, status:status as TrecStatus,
    originalLicenseDate:trecDate(f[5]!), expirationDate:trecDate(f[6]!),
    mailingCountyCode:county(f[18]!), physicalCountyCode:county(f[25]!), agencyIdentifier:f[31]!};
}
function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace(/Z$/u, value.includes('.') ? 'Z' : '.000Z')) throw new Error('invalid_trec_metadata');
  return Date.parse(value);
}
export function trecProvenance(metadata: TrecMetadata, now: Date) {
  const url = new URL(metadata.sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.trec.texas.gov' || url.port || url.username || url.password || url.search || url.hash) throw new Error('invalid_trec_source_url');
  const observed = now.getTime(), retrieved = timestamp(metadata.retrievedAt);
  const updated = metadata.sourceUpdatedAt === null ? null : timestamp(metadata.sourceUpdatedAt);
  if (!Number.isFinite(observed) || retrieved > observed || (updated !== null && updated > retrieved)) throw new Error('invalid_trec_metadata');
  return {source:'Texas Real Estate Commission' as const, format:'trecfile.txt' as const,
    sourceUrl:metadata.sourceUrl, dictionaryUrl:TREC_INSTRUCTIONS_URL, retrievedAt:metadata.retrievedAt, sourceUpdatedAt:metadata.sourceUpdatedAt,
    evaluatedAt:now.toISOString(), freshness:updated === null ? 'unknown' as const : observed-updated > 48*3600_000 ? 'stale' as const : 'recent_source_snapshot' as const,
    liveVerified:false as const, origin:'operator_supplied_unverified' as const};
}
// Case/outer whitespace only. Do not erase punctuation, suffixes or internal spaces.
const identity = (name: string) => name.trim().toUpperCase();
export function verifyTrecFirms(records: readonly TrecOrganization[], firms: readonly TrecExistingFirm[], metadata: TrecMetadata, now: Date) {
  if (records.length > TREC_LIMITS.organizations || firms.length > TREC_LIMITS.firms) throw new Error('trec_input_too_large');
  const provenance = trecProvenance(metadata, now);
  const ids = new Set<string>();
  const results = firms.map(firm => {
    if (!firm.firmId || firm.firmId.length > 100 || ids.has(firm.firmId) || !firm.legalName.trim() || firm.legalName.length > 64 || !/^\d{1,3}$/u.test(firm.mailingCountyCode) || firm.mailingCountyCode === '999' || (firm.license && (!['BLLC','BCRP'].includes(firm.license.type) || !/^\d+(?:-\d+)?$/u.test(firm.license.number) || firm.license.number.length > 10))) throw new Error('invalid_trec_firm');
    ids.add(firm.firmId);
    const exact = records.filter(r => identity(r.legalName) === identity(firm.legalName) && r.mailingCountyCode === firm.mailingCountyCode && (!firm.license || (r.licenseType === firm.license.type && r.licenseNumber === firm.license.number)));
    // A duplicated license identity with conflicting name/county is not a uniquely supported match.
    const first = exact.length === 1 ? exact[0]! : null;
    const matches = first ? records.filter(r => r.licenseType === first.licenseType && r.licenseNumber === first.licenseNumber) : exact;
    const found = matches.length === 1 ? matches[0]! : null;
    // Return an explicit allowlist even if a caller supplied extra runtime fields.
    const record = found ? {licenseType:found.licenseType,licenseNumber:found.licenseNumber,legalName:found.legalName,
      status:found.status,originalLicenseDate:found.originalLicenseDate,expirationDate:found.expirationDate,
      mailingCountyCode:found.mailingCountyCode,physicalCountyCode:found.physicalCountyCode,agencyIdentifier:found.agencyIdentifier} : null;
    return {firmId:firm.firmId, outcome:matches.length === 0 ? 'unmatched' as const : matches.length > 1 ? 'ambiguous' as const : 'matched' as const,
      matchingRecords:matches.length, record, statusDescription:record ? TREC_STATUSES[record.status] : null,
      licenseExpiredAtEvaluation:record?.expirationDate ? record.expirationDate < now.toISOString().slice(0,10) : null};
  });
  return {provenance, purpose:'existing_firm_license_corroboration_only' as const,
    qualificationAuthority:false as const, admissionAuthority:false as const, outreachAuthority:false as const, results};
}
