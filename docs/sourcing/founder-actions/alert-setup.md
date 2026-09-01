# Alert Setup — point these at alerts@in.usecallie.com

The inbound pipe is live: mail to `alerts@in.usecallie.com` lands in S3 and is parsed
into SourceEvents within seconds. These signups take ~20 minutes total and turn on the
hot tier (FRBO listings + community posts). Do them from any browser.

## 1. Zillow by-owner rental alerts (~10 min)

Zillow has no "for rent by owner" saved-search email filter directly, but listing-type
filtering works on saved searches:

1. Create/sign in to a Zillow account using an email you control. Set the account's
   contact email to `alerts@in.usecallie.com` (or add a Gmail forward, see §4).
2. Search **Providence, RI rentals**. Filters: Home types = Apartments/Condos/Townhomes
   + Houses; "Listed by owner" if shown under "Other" filters (rental side shows
   "Listing type" on some markets; if absent, save the broad search — the parser
   classifies by-owner from the listing payload later).
3. Save search, enable **instant email alerts**.
4. Repeat for: Pawtucket, Cranston, East Providence, Warwick, Central Falls,
   North Providence, Woonsocket.

## 2. Apartments.com by-owner alerts (~5 min)

1. Account with `alerts@in.usecallie.com` as contact (or forward).
2. Search Providence RI, save search, enable email alerts. Repeat for the same city list.

## 3. F5Bot community keywords (~5 min)

1. Sign up at <https://f5bot.com> with `alerts@in.usecallie.com`.
2. Add keywords (F5Bot watches Reddit + Hacker News, emails on each hit):
   - `providence landlord`
   - `rhode island landlord`
   - `providence property management`
   - `rhode island rental property`
   - `providence tenant` (both-sides signal: landlords answer these threads)
   - `landlord recommend contractor providence`
3. Leave defaults (email per hit). The parser maps each hit to a `community` SourceEvent.

## 4. Alternative: Gmail forward (if a signup rejects the address)

Some services fight unusual addresses. Fallback: use your normal Gmail for signup, then
Gmail → Settings → Forwarding and POP/IMAP → add `alerts@in.usecallie.com` as a
forwarding address (confirmation mail will arrive in the S3 inbox — ask Jcode to fish
out the confirmation link), then create a filter: `from:(zillow.com OR apartments.com
OR f5bot.com)` → Forward. This also keeps copies in your Gmail.

## Verify it works

After any signup triggers its first alert, ask Jcode to check: the raw mail appears in
`s3://callie-sourcing-raw-mail-326255650484/raw-mail/` and a parsed event in
`s3://callie-sourcing-inbox-326255650484/events/`. Or just wait: parsed FRBO leads will
show up in the app once the inbox poller ships.
