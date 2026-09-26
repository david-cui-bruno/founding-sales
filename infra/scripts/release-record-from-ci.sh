#!/usr/bin/env bash
# Old name (P7, 26 September 2026): `record.sh from-ci`, same arguments and output.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/record.sh" from-ci "$@"
