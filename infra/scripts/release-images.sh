#!/usr/bin/env bash
# Old name (P7, 26 September 2026): `images.sh`, same subcommands and output, except
# `record`: since P6 (27 September 2026) it needs --api-range MIN-MAX and --worker-range
# MIN-MAX, the ranges the images run verified each image against, and refuses a call
# without them rather than defaulting them. Its one caller, greenfield-images.yml, calls
# images.sh and passes both.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/images.sh" "$@"
