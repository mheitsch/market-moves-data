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
   | `ETORO_USER_ID` | optional, the numeric eToro CID; leave empty to auto-resolve |

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
`x-request-id`.

- `GET /users/search?query=MrMagoon` — resolves username to userId
- `GET /users/{userId}/portfolio` — live portfolio
- `GET /trading/portfolio` — aggregated snapshot, used if the above returns nothing usable
- `GET /user-info/people/MrMagoon/gain` — the endpoint the old n8n workflow used, still the most reliable source for the YTD figure
- `GET /users/{userId}/gain/timeseries` — fallback for YTD

The script tries all of them and records what answered, so it degrades instead
of failing silently.
