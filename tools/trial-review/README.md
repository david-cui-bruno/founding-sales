# Trial review (slice S3T-E)

David's review of the ten-call shadow trial, on his own Mac, through Amazon Bedrock on AWS
credits: Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`, us-east-1, the `default` AWS
profile). No other provider, no retry, a cost cap. Not part of the app.

1. Make a key pair once (the private key stays on the Mac, passphrase-protected):

       mkdir -p ~/trial-review && cd ~/trial-review
       openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out trial-key.pem
       openssl pkey -in trial-key.pem -pubout | base64 | tr -d '\n' > trial-key.pub.b64

2. The coordinator runs the export on the operations task with that public key and saves the
   printed lines as `~/trial-review/trial-export.jsonl` (the lines are ciphertext only).
3. Decrypt (asks for the passphrase; writes `trial-calls.json`, mode 0600):

       node tools/trial-review/decrypt.mjs ~/trial-review/trial-export.jsonl ~/trial-review/trial-key.pem

4. Review (cap $3 by default; stops before passing it; stops on any error):

       node tools/trial-review/review.mjs ~/trial-review [--cap-usd 3] [--keep]

   It writes `verdicts.json` and prints ids, kinds, verdicts, categories and reasons only, after
   checking that no 8-word run of any transcript appears in them. Then `cleanup.sh` removes
   `trial-calls.json` and the export, success or failure, unless `--keep`.

Exit codes: 0 reviewed all; 1 stopped on an error; 3 the output repeated transcript wording
(nothing written); 4 stopped at the cap (what was reviewed is written); 5 cleanup failed.
