#!/usr/bin/env python3
"""Throwaway builder: python3 build_review.py RESULTS.json OUTPUT.html.

Embeds actual fixed-context comparison results in the self-contained review page.
No network, model calls, grading or production use. Serve only the output folder.
Input: {cases:[{caseId,question,source,observations,arms:{baseline:[],proposed:[]}}],budget,status}.
Optional review fields are displayed verbatim, never treated as approval.
"""
import json
import pathlib
import re
import sys

results = json.loads(pathlib.Path(sys.argv[1]).read_text())
if not isinstance(results.get('cases'), list):
    raise ValueError('results.cases must be an array')
template = pathlib.Path(__file__).with_name('review.html').read_text()
payload = json.dumps(results, ensure_ascii=True).replace('&', r'\u0026').replace('<', r'\u003c').replace('>', r'\u003e')
output, count = re.subn(r'(<script id="comparison-data" type="application/json">).*?(</script>)', lambda match: match[1] + payload + match[2], template, count=1, flags=re.S)
if count != 1:
    raise ValueError('comparison data marker missing')
path = pathlib.Path(sys.argv[2])
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(output)
print(f'Wrote self-contained throwaway comparison: {path}')
