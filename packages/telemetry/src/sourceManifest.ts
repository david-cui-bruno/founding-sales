const canonicalSource = /^(?:apps\/(?:api|worker|web)\/src|packages\/(?:contracts|telemetry)\/src|packages\/domain\/(?:crm|db|jobs|today|src|policy|suppression|classification|mail|outbound|dial|sequences|templates|settings|dashboard|funnel|research|social|sourcing|outreach|replies|notifications|retention|release|business|calls|calling|meetings|restore))\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/;

/** The image build writes exact private code locations; never infer membership from a directory. */
export function parseSourceManifest(json: string): Readonly<Record<string, true | undefined>> | undefined {
  try {
    const values: unknown = JSON.parse(json);
    if (!Array.isArray(values) || values.length === 0 || values.length > 50_000) return undefined;
    const approved: Record<string, true | undefined> = {};
    for (const value of values) {
      if (typeof value !== 'string' || value.length > 512 || !canonicalSource.test(value)) return undefined;
      approved[value] = true;
    }
    return Object.freeze(approved);
  } catch {
    return undefined;
  }
}
