# AutoDyn Performance Lab 2.0

Vehicle performance analysis with sourced specifications, a deterministic physics engine and an optional AI build assistant.

- **Manual Setup** — pick a vehicle (year → make → model → trim), decode a VIN, or enter one manually. Basic Setup needs only power and curb weight; simple controls describe a modification. Optional **Advanced Settings** expose every modeling assumption (aero, gearing, tires, conditions).
- **AI Build Assistant** — describe a vehicle or build in plain language. Gemini interprets the request into a *proposal*; nothing changes until you press **Apply to simulation**.
- **Results** — one shared workspace for both modes: metrics with uncertainty ranges, Stock vs. Modified deltas, charts, deterministic engineering analysis, provenance, and JSON/CSV/print export.

Both modes feed the **same** physics engine (`src/lib/physics`). The AI never produces performance numbers or vehicle specifications.

## Architecture

| Layer | Location | Notes |
|---|---|---|
| Vehicle data | `src/lib/vehicles`, `src/data/vehicle-index.json` | CarAPI dataset (2015–2020 US trims) + NHTSA vPIC (identification any year, VIN decode). Every value carries provenance: **Verified / User-provided / Estimated / Unavailable**. |
| Scenario state | `src/lib/domain`, `src/state` | SI units internally. Modified = Stock + overrides (Stock is never mutated). Pure reducer with revision-based staleness. |
| Physics | `src/lib/physics` | Resolver fills missing inputs with labeled estimates → time-step simulation → uncertainty band, sensitivity, mass sweep, change attribution. |
| AI interpretation | `src/lib/ai`, `src/app/api/assistant` | Server-only Gemini call with JSON-schema output, zod validation, vehicle resolution against the dataset, numeric guard, rate limits. |
| Presentation | `src/components` | Manual Setup, AI Build Assistant, Results. |

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

### Engineering feasibility

`src/lib/feasibility` classifies each scenario as **Feasible**, **Questionable**, **Non-feasible** or **Insufficient data** from deterministic checks (data provenance, power/torque consistency, specific output, traction bound vs. drive force, grip level, drag area, speed range, acceleration envelope, optional claims and component ratings, model validity range). Non-feasible always names the violated bound (e.g. a claimed 0–60 below the traction-limited minimum, a claimed top speed above the power-limited maximum, torque above a stated driveline rating). Invalid inputs are input errors, never a feasibility status. No AI is involved; the assistant only explains the result.

### Checking the AI connection

`GET /api/assistant/health?probe=1` (same-origin, rate-limited and cached; or with `Authorization: Bearer $AI_DIAGNOSTICS_TOKEN` to force it and add `&models=1` to list the Flash-Lite models the project can see) makes one real, bounded Gemini request in the production request format and reports `configured`, `model`, the deployment's `environment / branch / commit`, and `provider.status`: `ok`, `not_configured`, `invalid_key`, `model_unavailable`, `quota`, `timeout`, `network`, `server_error`, `request_rejected` or `invalid_output`. The key is never returned; sanitized details are logged server-side as `[assistant] provider_error {...}`. The assistant runs this check automatically once per browser session (also via **Test connection**).

Vercel applies environment-variable changes only to **new** deployments: after adding `GEMINI_API_KEY`, redeploy the latest `autodyn-v2` deployment (not `main`).

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
