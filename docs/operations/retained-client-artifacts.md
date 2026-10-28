# Retained client artifacts

[ADR0027](../adr/0027-web-product.md) retires the desktop product. Its source, packaging and publishing workflow are removed. The web app is the sole product; these artifacts are not a fallback workflow.

Keep the existing signed update/restore objects, including the installed881 restore copy, in the current S3/CloudFront resources. Existing API client-version refusals still reference the signed manifest at `releases/darwin-arm64/latest.json`; historical release records retain their `desktopCommitStamp` field and schema constraints. Preserve those readers, integrity rules and old UNKNOWN effects rather than altering accepted history during product cleanup.

Retirement condition: an explicitly approved artifact/data-retirement operation and, where required, reviewed replacement of the remaining server/history readers. Until then, do not destroy storage, publish a new native build, install the app or use it to complete a web journey. Normal protected API/worker releases and owner OFF remain independent.
