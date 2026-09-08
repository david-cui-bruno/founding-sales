import type { AppDatabase } from '../../db/database';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { cloudSourceEventSchema } from '../../../shared/contracts/cloudSourceEventContract';
import type { ContactReason, PortfolioContext } from '../../../shared/contracts/leadDetailContract';

type PropertyRow = { id: string; prospect_id: string; relationship: string | null; address_line_1: string;
  address_line_2: string | null; locality: string; region: string; country_code: string; door_count: number | null };
const normalize = (value: string | null) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const addressKey = (p: PropertyRow) => [p.country_code, p.region, p.locality, p.address_line_1, p.address_line_2].map(normalize).join('|');

/** Read-only, all associated prospects. Links are not automatically ownership.
 * Explicit stored relationship assertions and exact named public owner records
 * are the only role evidence. Repeated observations never multiply holdings.
 */
export function buildPortfolioContext(database: AppDatabase, personId: string): { portfolio: PortfolioContext; contactReason: ContactReason | null } {
  const raw = database.raw;
  const person = raw.prepare('SELECT display_name,aliases_json FROM persons WHERE id = ?').get(personId) as { display_name: string; aliases_json: string } | undefined;
  const names = person === undefined ? [] : [{ name: person.display_name }];
  if (person !== undefined) {
    try {
      const aliases: unknown = JSON.parse(person.aliases_json);
      if (Array.isArray(aliases)) names.push(...aliases.filter((alias): alias is string => typeof alias === 'string').map(name => ({ name })));
    } catch { /* Malformed aliases confer no additional identity evidence. */ }
  }
  const rows = raw.prepare(`SELECT p.id,l.prospect_id,l.relationship,p.address_line_1,p.address_line_2,
    p.locality,p.region,p.country_code,p.door_count FROM prospect_properties l
    JOIN prospects lead ON lead.id = l.prospect_id JOIN properties p ON p.id = l.property_id
    WHERE lead.person_id = ? ORDER BY p.id,l.prospect_id`).all(personId) as PropertyRow[];
  const sources = raw.prepare(`SELECT s.id,s.prospect_id,s.channel,s.source_record_json,p.display_name AS referrer_name FROM source_events s
    LEFT JOIN persons p ON p.id = s.referred_by_person_id
    WHERE s.person_id = ? ORDER BY s.observed_at DESC,s.id`).all(personId) as {
      id: string; prospect_id: string | null; channel: string; source_record_json: string; referrer_name: string | null;
    }[];
  const records = sources.flatMap(source => {
    if (!['parcel', 'registry', 'deed'].includes(source.channel)) return [];
    try {
      const parsed = cloudSourceEventSchema.safeParse(JSON.parse(source.source_record_json).sourceRecord?.cloudSourceEvent);
      if (!parsed.success || parsed.data.channel !== source.channel) return [];
      const event = parsed.data;
      const descriptor = event.entity.person;
      if (descriptor === null || ![descriptor.full_name, ...descriptor.org_names].some(name => name !== null
        && names.some(known => normalize(known.name) === normalize(name)))) return [];
      return [{ source, event }];
    } catch { return []; }
  });
  const groups = new Map<string, { rows: PropertyRow[]; owned: string[]; managed: string[] }>();
  for (const row of rows) {
    const key = addressKey(row);
    const group = groups.get(key) ?? { rows: [], owned: [], managed: [] };
    group.rows.push(row);
    if (row.relationship === 'owner' || row.relationship === 'property_owner') group.owned.push(`link:${row.prospect_id}:${row.id}`);
    if (row.relationship === 'manager' || row.relationship === 'property_manager') group.managed.push(`link:${row.prospect_id}:${row.id}`);
    for (const { source, event } of records) {
      if (source.prospect_id !== null && source.prospect_id !== row.prospect_id) continue;
      const property = event.entity.property;
      if (property === null || property.situs_address === null || row.address_line_2 !== null) continue;
      const address = property.situs_address;
      if (normalize(address.line1) !== normalize(row.address_line_1) || normalize(address.locality) !== normalize(row.locality)
        || normalize(address.region) !== normalize(row.region) || normalize(address.country_code) !== normalize(row.country_code)) continue;
      group.owned.push(`source:${source.id}`);
    }
    groups.set(key, group);
  }
  let ownedCount = 0; let managedCount = 0; let linkedCount = 0;
  let knownUnits = 0; let countKnown = false; let countConflict = false;
  const locations = new Set<string>();
  const facts: PortfolioContext['facts'] = [];
  let contactReason: ContactReason | null = null;
  const warmSource = sources.find(source => source.channel === 'referral' || source.channel === 'inbound_demo');
  if (warmSource !== undefined) {
    const text = warmSource.channel === 'inbound_demo' ? 'Requested a demo'
      : warmSource.referrer_name?.trim() ? `Introduced by ${titleCaseDisplayName(warmSource.referrer_name)}`
        : 'Recorded referral, referrer not recorded';
    const id = `source:${warmSource.id}:reason`;
    facts.push({ id, text });
    contactReason = { text, evidenceIds: [id] };
  }
  for (const group of groups.values()) {
    const first = group.rows[0]!;
    const owned = group.owned.length > 0;
    const managed = group.managed.length > 0;
    // Contradictory roles stay unexplained rather than choosing one silently.
    const role = owned && !managed ? 'owner' : managed && !owned ? 'manager' : 'unknown';
    if (role === 'owner') ownedCount++;
    else if (role === 'manager') managedCount++;
    else linkedCount++;
    const location = `${titleCaseDisplayName(first.locality.toUpperCase())}, ${first.region.toUpperCase()}`;
    locations.add(location);
    const counts = new Set(group.rows.map(row => row.door_count).filter((n): n is number => n !== null));
    if (role !== 'unknown') {
      if (counts.size === 1) { countKnown = true; knownUnits += [...counts][0]!; }
      if (counts.size > 1) countConflict = true;
    }
    const address = `${titleCaseDisplayName(first.address_line_1.toUpperCase())}${first.address_line_2 ? ` ${first.address_line_2}` : ''}, ${location}`;
    const id = `portfolio:${first.id}:${role}`;
    const text = role === 'owner' ? `Recorded owner of ${address}.`
      : role === 'manager' ? `Recorded manager of ${address}.`
        : `Linked property: ${address}. Ownership and management are not established.`;
    facts.push({ id, text });
    if (role !== 'unknown' && contactReason === null) contactReason = { text, evidenceIds: [id] };
  }
  const units = countKnown && !countConflict && Number.isSafeInteger(knownUnits) ? knownUnits : null;
  const summary = groups.size === 0 ? 'No known holdings recorded. Portfolio completeness is unknown.'
    : `${ownedCount} known owned · ${managedCount} known managed · ${linkedCount} other linked properties. ${units === null ? 'Unit count unknown.' : `${units} known units where recorded.`} Partial records, not a complete portfolio.`;
  return { portfolio: { role: ownedCount > 0 ? 'owner' : managedCount > 0 ? 'manager' : 'unknown',
    ownedCount, managedCount, linkedCount, knownUnits: units, locations: [...locations].sort(), summary,
    completeness: 'partial', facts: facts.slice(0, 100) }, contactReason };
}
