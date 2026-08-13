# market-moves-data

Always-on data feed for the daily "Market Moves" eToro post. Replaces the n8n
workflow "Yahoo Finance > eToro Daily Market Moves".

## Why this exists

The Cowork cloud sandbox that writes the post can only reach an allowlist of
hosts. `public-api.etoro.com` is not on it, so the post task cannot call the
eToro API itself. GitHub Actions can, runs for free on a cron, and
`raw.githubusercontent.com` **is** reachable from the sandbox. So the Action
fetches, commits, and the post task reads.

Nothing here depends on a laptop being switched on.

```
GitHub Actions (05:00 UTC)          Cowork scheduled task (05:30 UTC)
  eToro API  ->  data/latest.json  ->  reads raw.githubusercontent.com
                                       researches the day's story
                                       writes + QCs the post
                                       delivers to the Claude app + push
```

## Setup (one time, ~5 minutes)

1. Create the repo (public is fine and simplest, the data below is already
   visible on the eToro profile; use private only if you also want to wire up a
   read token).

2. Copy in `scripts/snapshot.mjs` and `.github/workflows/etoro-snapshot.yml`.

3. Settings → Secrets and variables → Actions → New repository secret:

   | Secret | Where to get it |
   |---|---|
   | `ETORO_API_KEY` | the `x-api-key` header value from the old n8n HTTP node |
   | `ETORO_USER_KEY` | the `x-user-key` header value from the same node |

   Paste these yourself. They never need to pass through a chat.

4. Actions tab → "eToro snapshot" → Run workflow. Check `data/latest.md`:
   it prints the HTTP status of every endpoint that was tried, so a wrong key or
   a renamed endpoint is visible immediately.

5. Tell Claude the raw URL:
   `https://raw.githubusercontent.com/<user>/market-moves-data/main/data/latest.json`

## What gets committed

`data/latest.json`

```json
{
  "generatedAt": "2026-08-14T05:00:11.000Z",
  "ytd": 92.57,
  "ytdFormatted": "92.57%",
  "positionCount": 22,
  "tickers": ["NVDA", "AVGO", "SNDK", "..."],
  "positions": [{ "ticker": "NVDA", "name": "NVIDIA Corporation", "investedPct": 0.41 }],
  "diagnostics": { "/users/{id}/portfolio": 200 }
}
```

No account balances, no cash values, no keys. `data/latest.md` is the same thing
in readable form plus the endpoint status table.

Set `INCLUDE_RAW=1` in the workflow env to also dump the untouched API
responses to `data/raw.json` while debugging. Turn it off again on a public repo.

## Endpoints used

Base `https://public-api.etoro.com/api/v1`, headers `x-api-key`, `x-user-key`,
`x-request-id` (a fresh UUID per request).

- `GET /user-info/people/{username}/gain` — yearly gains, the YTD figure
- `GET /user-info/people/{username}/portfolio/live` — positions as `instrumentId` + `investmentPct`
- `GET /market-data/instruments?instrumentIds=1,2,3` — `instrumentId` → `symbolFull` (the ticker)

Endpoints that do **not** exist on this API, so nobody tries them again:
`/market/instruments/{id}`, `/users/search`, `/trading/portfolio`, `/users/{id}/portfolio`.

### The instrumentIds trap

`instrumentIds` is declared `style: form, explode: false` in the
[OpenAPI spec](https://api-portal.etoro.com/api-reference/openapi.json), i.e.
**one** parameter carrying a comma separated list. Repeating the parameter
(`?instrumentIds=1&instrumentIds=2`) returns HTTP 200 with exactly one
instrument — the server keeps only the last occurrence. That is what made 21 of
22 tickers show up as `#1005` placeholders while everything looked healthy.

`scripts/snapshot.mjs` tries comma, encoded comma, brackets and repeated in that
order, keeps the first that resolves every id, and falls back to one request per
instrument (unambiguous under any serialization, ~22 requests, well inside the
120 req / 60 s market data budget). `diagnostics.symbolSerialization` records
which one actually worked, so a silent change on eToro's side is visible in the
next snapshot.

`scripts/check-snapshot.mjs` runs after the commit and fails the workflow if any
ticker is still an unresolved id — fresh data still lands, but the run goes red
instead of feeding placeholders to the post task.
