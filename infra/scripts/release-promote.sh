#!/usr/bin/env bash
# Old name (P7, 26 September 2026): `images.sh promote <image-digests.json> [--app-only]`.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/images.sh" promote "$@"
