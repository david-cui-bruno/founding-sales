# Certificate authorities the images trust in addition to Node's own

## rds-global-bundle.pem

The public bundle of every Amazon RDS certificate authority, all regions, as AWS
publishes it at <https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem>.
Fetched 2026-09-23; 108 certificates; sha256 `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`.
`test/release/databaseTls.check.ts` pins both numbers.

Why it is here: `infra/modules/database` sets `rds.force_ssl = 1`, so the database
refuses any connection that is not TLS, and the `pg` driver verifies the server's
certificate against Node's bundled roots, which do not include Amazon RDS. Both images
set `PGSSLMODE=verify-full` and `NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem`
(Dockerfile.api, Dockerfile.worker), so every connection the API, the worker, `fss
migrate`, the drill and the operations task make is encrypted and the server is the
one the hostname names.

To refresh (AWS rotates these rarely; the bundle contains the successors well ahead):

```bash
curl -sS -o certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
shasum -a 256 certs/rds-global-bundle.pem; grep -c 'BEGIN CERTIFICATE' certs/rds-global-bundle.pem
```

and update the two numbers in the test and in this file.
