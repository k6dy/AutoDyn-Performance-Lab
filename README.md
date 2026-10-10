# AutoDyn Performance Lab 2.0

Vehicle performance analysis with sourced specifications, a deterministic physics engine and an optional AI build assistant.

- **Manual Setup** — pick a vehicle (year → make → model → trim), decode a VIN, or enter one manually. Basic Setup needs only power and curb weight; simple controls describe a modification. Optional **Advanced Settings** expose every modeling assumption (aero, gearing, tires, conditions).
- **AI Build Assistant** — describe a vehicle or build in plain language. Gemini interprets the request into a *proposal*; nothing changes until you press **Apply to simulation**.
- **Results** — one shared workspace for both modes: metrics with uncertainty ranges, Stock vs. Modified deltas, charts, deterministic engineering analysis, provenance, and JSON/CSV/print export.
- **Saved Analyses** — every completed analysis is kept automatically in this browser (IndexedDB), with search, sort, open, rename, duplicate, delete, delete all, and JSON backup export/import. **New Analysis** resets the workspace without touching saved history.

Both modes feed the **same** physics engine (`src/lib/physics`). The AI never produces performance numbers or vehicle specifications.

## Architecture

| Layer | Location | Notes |
|---|---|---|
| Vehicle data | `src/lib/vehicles`, `src/data/vehicle-index.json` | CarAPI dataset (2015–2020 US trims) + NHTSA vPIC (identification any year, VIN decode). Every value carries provenance: **Verified / User-provided / Estimated / Unavailable**. |
| Scenario state | `src/lib/domain`, `src/state` | SI units internally. Modified = Stock + overrides (Stock is never mutated). Pure reducer with revision-based staleness. |
| Physics | `src/lib/physics` | Resolver fills missing inputs with labeled estimates → time-step simulation → uncertainty band, sensitivity, mass sweep, change attribution. |
| AI interpretation | `src/lib/ai`, `src/app/api/assistant` | Server-only Gemini call with JSON-schema output, zod validation, vehicle resolution against the dataset, numeric guard, rate limits. |
| Persistence | `src/lib/persistence` | Local-first: saved analyses in IndexedDB (metadata and results in separate stores, zod-validated on read), the working draft in localStorage. No accounts, no server storage. |
| Presentation | `src/components` | Manual Setup, AI Build Assistant, Results, Saved Analyses. |

### Physics model (summary)

Longitudinal point-mass model on a level road: synthesized full-load torque curve that preserves rated peak power and torque at their rpm points; gear-by-gear wheel force with drivetrain efficiency; traction limit μ·N on the driven axle with load transfer (h/L); aerodynamic drag ½ρC<sub>d</sub>Av² with air density from temperature and elevation; rolling resistance; rotational-inertia mass factor; optimal-force upshifts with torque interruption; clutch/torque-converter launch. Electric vehicles use constant torque → constant power through a single reduction. Hybrids use combined system output (labeled limitation).

Outputs: 0–60 mph, 0–100 km/h, 0–100 mph, quarter-mile ET/trap, 50–70 mph, peak g, traction-limited share, theoretical top speed — each with an indicative range from input uncertainty. Peak power and curb mass are required; AutoDyn never guesses them.

## Environment variables

See `.env.example`. All are optional — without them the app is fully functional and the assistant shows *"AI assistance is temporarily unavailable. Manual Setup is still ready to use."*

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Server-side Gemini key. Create it in Google AI Studio in a project **without billing** so usage can only ever be free tier. |
| `GEMINI_MODEL` | Default `gemini-3.5-flash-lite` (free tier at time of writing). |
| `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS` | Per-request output cap (default 1024) and timeout (default 15 s). |
| `AI_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_DAY`, `AI_GLOBAL_DAILY_LIMIT` | Defaults 5 / 40 per client, 300 global per day. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional persistent rate limiting across serverless instances. |

### Saved analyses and the working draft

- **Automatic saving.** Each completed run is stored with its exact inputs (SI units), vehicle identity and provenance, every result and chart series, the feasibility assessment, and the physics engine version. The workspace is linked to one saved analysis like an open document: re-running an identical configuration only refreshes its timestamp, re-running a changed configuration updates it, and **Duplicate** / **Save as…** keep a separate copy. With no linked analysis, an identical configuration already in history is reused instead of duplicated. Nothing is ever deleted to enforce a limit; a full storage is reported with **Retry**.
- **Historical snapshots.** An analysis computed by an older engine version is labeled *Historical* and shown exactly as stored. **Recalculate using current engine** saves the new result as a separate analysis; the original is only overwritten with an explicit **Replace original**.
- **Draft.** The working configuration is autosaved separately and offered on return (**Continue last session** / **Start fresh**) — never applied automatically. Stored drafts are schema-validated and physically sanitized (e.g. an impossible 1 lb curb weight is reset to the source value).
- **Backup.** *Export backup* writes a JSON file (`format: "autodyn-analyses"`, `formatVersion: 1`). Import validates the format and version, every record's structure and numbers, and rejects physically invalid inputs; derived fields are recomputed, conflicting IDs are reassigned, existing history is never modified, and imported results are checked against the current engine when opened. Files over 50 MB or 1,000 analyses are refused.
- Browser storage does not sync across devices and is lost when site data is cleared — export a backup to keep it.

### Engineering feasibility

`src/lib/feasibility` classifies each scenario as **Feasible**, **Questionable**, **Non-feasible** or **Insufficient data** from deterministic checks (data provenance, power/torque consistency, specific output, traction bound vs. drive force, grip level, drag area, speed range, acceleration envelope, optional claims and component ratings, model validity range). Non-feasible always names the violated bound (e.g. a claimed 0–60 below the traction-limited minimum, a claimed top speed above the power-limited maximum, torque above a stated driveline rating). Invalid inputs are input errors, never a feasibility status. No AI is involved; the assistant only explains the result.

### Checking the AI connection

`GET /api/assistant/health` reports `configured`, `env` (presence of `GEMINI_API_KEY` / `GEMINI_MODEL`, never values), `model`, `deployment` (`environment / branch / commit / url / project`), configuration notes (including misnamed variables such as `GOOGLE_API_KEY`) and the last real provider result. It never calls Google.

| Request | What it does | Quota |
|---|---|---|
| `?probe=1` from the app itself (Test connection) | Fetches the configured model's metadata: proves the key is accepted and the model is visible to the API project. Cached per instance, 3/min per client. | None (no generation) |
| `?probe=1` with `Authorization: Bearer $AI_DIAGNOSTICS_TOKEN` | One real, bounded `generateContent` call in the production format (structured output validated). Add `&models=1` to list visible Flash-Lite models. 2/min, 20/day per instance; disabled unless the token (≥16 chars) is set. | Yes (1 request) |

`provider.status` is one of `ok`, `not_configured`, `invalid_key`, `key_restricted`, `model_unavailable`, `model_unsupported`, `quota`, `provider_rate_limited`, `timeout`, `network`, `server_error`, `request_rejected` or `invalid_output`. Sanitized details are logged server-side as `[assistant] provider_error {...}`.

**Live verification (do this yourself on the Preview):** set `AI_DIAGNOSTICS_TOKEN` in the Vercel project, redeploy, then

```bash
curl -s -H "Authorization: Bearer $AI_DIAGNOSTICS_TOKEN" "https://<preview-host>/api/assistant/health?probe=1&models=1"
```

Expect `"probe":"generation"` and `"provider":{"status":"ok",...}`. Protected Previews (Vercel Authentication) also need a bypass header or `vercel curl`.

Vercel attaches environment variables when a deployment is **created**: variables added later never reach existing deployments. Several Vercel projects (`autodyn`, `auto-dyn-performance`, `autodynperformance`) build this repository — the variables must exist on the project that serves the URL being tested, for the **Preview** environment (all branches or `autodyn-v2`), and that branch must be redeployed afterwards.

**Rate-limit tradeoff:** without Upstash the limiter is in-memory per server instance — on Vercel that is best-effort, not global. The real cost guarantee is the billing-free Gemini project (requests beyond the free quota fail with 429, which the app handles).

## Scripts

```bash
npm run build       # production build
npm run check       # typecheck + lint + tests
npm test            # vitest (no network, no API key; Gemini is mocked)
npm run test:e2e    # real-browser layout checks (360/390 px) on the production build via installed Edge/Chrome
npm run verify      # all of the above + production build
npm run data:build  # regenerate src/data/vehicle-index.json from src/data/carapi/*.csv
```

## Limitations

Results are theoretical estimates, not guarantees of real-world performance and not guidance for high-speed driving. AutoDyn does not assess durability, safety, emissions compliance or road legality of modifications. Speed limiters, launch/traction control and tire slip curves are not modeled.
