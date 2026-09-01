#!/usr/bin/env bash
# Scouting script used to enumerate the assessor class catalog before
# hard-coding RESIDENTIAL_RENTAL_CLASSES in src/taxroll.ts. Re-run when the
# roll year changes; diff against the comment in taxroll.ts.
set -euo pipefail
curl -s 'https://data.providenceri.gov/resource/6ub4-iebe.json?$select=class,short_desc,count(*)&$group=class,short_desc&$order=class&$limit=200' | python3 -m json.tool
