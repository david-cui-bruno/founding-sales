const shaPattern = /^[a-f0-9]{40}$/;
const fail = () => { throw new Error('RELEASE_PROVENANCE_FAILED'); };
function validateReleaseMarker(marker) {
  if (!marker || Array.isArray(marker) || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(['builtAt', 'commitSha', 'format', 'version'])
    || marker.format !== 'callie-release' || marker.version !== 1 || !shaPattern.test(marker.commitSha)
    || typeof marker.builtAt !== 'string' || !Number.isFinite(Date.parse(marker.builtAt))
    || new Date(marker.builtAt).toISOString() !== marker.builtAt) fail();
  return marker;
}
exports.validateReleaseMarker = validateReleaseMarker;
