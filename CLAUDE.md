# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # Install dependencies
pnpm check            # Run the vaccine check script (node scripts/checkVaccines.js)
```

To run locally, create a `.env` file with:
```
SHELTERLUV_API_KEY=...
SLACK_BOT_TOKEN=...
SLACK_CHANNEL_ID=...
```

## Architecture

This is a single-script Node.js project. The only meaningful source file is `scripts/checkVaccines.js`.

**Flow:**
1. Fetch all in-custody dogs from Shelterluv API (paginated, 200/page, filtered to `Type === 'Dog'`)
2. For each dog, fetch three vaccine endpoint variants: all, scheduled (`?status=scheduled`), overdue (`?status=overdue`)
3. Filter out "stale" scheduled vaccines — scheduled entries within 60 days of a completed vaccine of the same type are dropped to avoid double-reporting
4. Classify each dog's 3 core vaccines (Rabies, DHPP/DAPP, Bordetella) into statuses: overdue / needsAttention (<14 days) / upcoming (<30 days) / current
5. Dogs with all 3 core vaccines current are batched into a single Slack summary block; dogs with any issue get individual detailed Slack messages
6. All messages POST to `SLACK_WEBHOOK_URL` as Slack Block Kit payloads

**Key constants** (top of script):
- `DAYS_BEFORE_DUE = 30` — outer window for "upcoming"
- `TWO_WEEKS_BEFORE_DUE = 14` — inner window for "needs attention"

**Automation:** GitHub Actions workflow (`.github/workflows/vaccine-check.yml`) runs `pnpm check` daily at 8 AM Pacific (16:00 UTC). Secrets `SHELTERLUV_API_KEY`, `SLACK_BOT_TOKEN`, and `SLACK_CHANNEL_ID` must be set in the repo's GitHub Actions secrets.
