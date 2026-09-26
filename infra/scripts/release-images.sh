#!/usr/bin/env bash
# Old name (P7, 26 September 2026): `images.sh`, same subcommands and output.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/images.sh" "$@"
