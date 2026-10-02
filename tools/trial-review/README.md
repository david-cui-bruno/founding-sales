# Trial review (slice S3T-E, after the TE design reset)

David's review of the ten-call shadow trial, on his own Mac, through Amazon Bedrock on AWS
credits: Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`, us-east-1, the `default` AWS
profile). No other provider, no retry, a cost cap. Not part of the app. No plaintext and no free
text ever reaches the disk: one process decrypts in memory and writes only `verdicts.json`.

1. Once, make a passphrase-protected key pair (the private key never leaves the Mac). Choose a
   passphrase of at least 8 characters: the review refuses a shorter or blank one.

       mkdir -p ~/trial-review && cd ~/trial-review
       openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out trial-key.pem
       openssl pkey -in trial-key.pem -pubout | base64 | tr -d '\n' > trial-key.pub.b64

2. The coordinator runs the export on the operations task (exactly one of `--workspace-slug` or
   `--workspace-id`). The helper fetches the task's log from CloudWatch and prints it; the lines
   are ciphertext only:

       ~/conductor/scratch/fss-prod-ops-run.sh trial-export -- admin trial export \
         --public-key-pem-b64 "$(cat ~/trial-review/trial-key.pub.b64)" --workspace-slug <slug> \
         | tee ~/trial-review/trial-export.jsonl

   (If the helper's output was lost, the same lines are in the worker log group, stream
   `operations/operations/<task id>`: `aws logs get-log-events --log-group-name <group>
   --log-stream-name <stream> --start-from-head --output json | python3 -c 'import json,sys;
   [print(e["message"]) for e in json.load(sys.stdin)["events"]]' > ~/trial-review/trial-export.jsonl`.)

3. David, from a checkout of the repository (`npm ci` once, for the AWS SDK):

       node tools/trial-review/review.mjs --export ~/trial-review/trial-export.jsonl \
         --key ~/trial-review/trial-key.pem --cap-usd 3

   It asks for the passphrase, decrypts in memory, checks every suggestion's key and kind against
   the contract, sends one InvokeModel request per call, stops before the bounded cost could pass
   the cap, and writes one file into the export's folder (or `--out`):

   * `verdicts.json` (0600): ids, kinds and enums only: the suggestion's `kind`, its reporting
     `report_type` (`outcome:interested`, `stop`, `callback`, ...) and `proposed_value` (the
     outcome, or `none`), both from the export; David's `decision`; and the model's `verdict`,
     `category`, `reason_code` and `decision_matches_evidence`. The model writes no notes. The
     coordinator may read this.

   The export file is removed on every exit once the arguments parse (success, any failure, a
   wrong passphrase, Ctrl-C or any other signal); re-exporting is step 2 again. If it cannot be
   removed, the run says `E_CLEANUP` and exits 3: delete it by hand.

Reason codes: `supported_by_statement`, `no_supporting_statement`, `value_differs_from_statement`,
`statement_was_conditional`, `speaker_not_decision_maker`, `later_statement_reversed`,
`outcome_mislabelled`, `time_or_date_differs`, `scope_differs`, `transcript_unclear`, `other`.

Exit codes: 0 reviewed all; 1 stopped on an error; 2 bad arguments (nothing removed); 3 the
output repeated transcript wording (nothing written), or the export could not be removed
(`E_CLEANUP`); 4 stopped at the cap (what was reviewed is written); 13 Node stopped on an
unsettled wait (`E_INTERNAL`; the export is still removed); 130 interrupted. A failure prints only
a fixed code (`E_ARGS`, `E_INPUT_PARSE`, `E_KEY`, `E_KEY_UNPROTECTED`, `E_DECRYPT`, `E_PAYLOAD`,
`E_WRITE`, `E_BEDROCK`, `E_RESPONSE`, `E_SCHEMA`, `E_QUOTE`, `E_COST`, `E_CLEANUP`,
`E_INTERRUPTED`, `E_INTERNAL`). `E_PAYLOAD`: the export holds a suggestion key or kind the
contract does not allow (no key is printed). The key must need its passphrase: a PEM that loads
without one, or a file holding more than one PEM block, is refused, and so is a passphrase under
8 characters.

`bash tools/trial-review/cleanup.sh <folder>` is a manual sweep: it removes export files,
`verdicts.json`, and files older versions of the tool wrote.
