# AutoDyn Performance Lab 2.0

Vehicle performance analysis with sourced specifications, a deterministic physics engine and an optional AI build assistant.

- **Manual Setup** — pick a vehicle (year → make → model → trim), decode a VIN, or enter one manually. Basic Setup needs only power and curb weight; simple controls describe a modification. Optional **Advanced Settings** expose every modeling assumption (aero, gearing, tires, conditions).
- **AI Build Assistant** — an automotive specialist: answers questions about vehicles, components, maintenance, modifications and engineering, and turns build requests into a *proposal*; nothing changes until you press **Apply to simulation**. Off-topic requests are answered locally without calling Gemini. Conversations are saved automatically and can be reopened, renamed and deleted (Chat history).
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
| `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS` | Ceiling for any single answer (default 4096; each request asks only for its depth's budget — 1024 / 2048 / 4096) and provider timeout (default 20 s). Leave unset unless you need a lower cap. |
| `AI_RATE_LIMIT_PER_MINUTE`, `AI_RATE_LIMIT_PER_DAY`, `AI_GLOBAL_DAILY_LIMIT` | Defaults 5 / 40 per client, 300 global per day. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional persistent rate limiting across serverless instances. |

### Saved analyses and the working draft

- **Automatic saving.** Each completed run is stored with its exact inputs (SI units), vehicle identity and provenance, every result and chart series, the feasibility assessment, and the physics engine version. The workspace is linked to one saved analysis like an open document: re-running an identical configuration only refreshes its timestamp, re-running a changed configuration updates it, and **Duplicate** / **Save as…** keep a separate copy. With no linked analysis, an identical configuration already in history is reused instead of duplicated. Nothing is ever deleted to enforce a limit; a full storage is reported with **Retry**.
- **Historical snapshots.** An analysis computed by an older engine version is labeled *Historical* and shown exactly as stored. **Recalculate using current engine** saves the new result as a separate analysis; the original is only overwritten with an explicit **Replace original**.
- **Draft.** The working configuration is autosaved separately and offered on return (**Continue last session** / **Start fresh**) — never applied automatically. Stored drafts are schema-validated and physically sanitized (e.g. an impossible 1 lb curb weight is reset to the source value).
- **Backup.** *Export backup* writes a JSON file (`format: "autodyn-analyses"`, `formatVersion: 1`). Import validates the format and version, every record's structure and numbers, and rejects physically invalid inputs; derived fields are recomputed, conflicting IDs are reassigned, existing history is never modified, and imported results are checked against the current engine when opened. Files over 50 MB or 1,000 analyses are refused.
- Browser storage does not sync across devices and is lost when site data is cleared — export a backup to keep it.

### Automotive relevance gate (quota protection)

Every assistant message passes: request validation → duplicate/rate-limit checks → **local relevance classification** (`src/lib/ai/relevance.ts`, vocabulary in `lexicon.ts`) → Gemini only if allowed → output validation. The gate runs in the browser for instant feedback and, authoritatively, in `POST /api/assistant`, so direct API calls can't spend quota on off-topic text. No second model and no network call is used to classify.

Each message gets one outcome:

| Outcome | Meaning | Provider call |
|---|---|---|
| `AUTOMOTIVE` | Clearly about vehicles, parts, maintenance, modifications, engineering or AutoDyn results (weighted vocabulary: components, makes, models, engine/chassis codes, units, phrases, typo tolerance for long technical words). | Yes |
| `CONTEXTUAL_FOLLOWUP` | No explicit subject, but it reads as a follow-up ("What models are there?", "Which launches better?", "Is it legal?", "Why?") **and** this conversation has an established automotive subject. | Yes, with the subject |
| `AMBIGUOUS` | Subject unclear: a specific local question instead of a refusal — "Do you mean Jaguar cars or the animal?" for names that are also everyday words, "Which vehicle, part or repair do you want the cost of?" for a bare cost question; the generic prompt is the last resort. | No |
| `OFF_TOPIC` | Clearly unrelated (animals, recipes, essays, weather, finance, programming…) or an attempt to change the assistant's role. Explicit off-topic content overrides any earlier car discussion. | No |

- **Subject tracking** (`src/lib/ai/topic.ts`): a small typed structure — manufacturers, models, years, engine families, components — derived deterministically from the user's messages of the current conversation only (never another chat, and not the vehicle loaded in Manual Setup). Naming a new vehicle or asking a new general question starts a new subject; referring questions ("What about the supercharged models?", "Could spark plugs cause it?") refine it; an ambiguous name only counts once the car meaning is confirmed. It is rebuilt from stored messages, so reopened chats keep their subject. The header shows it ("Subject: Jaguar · V8").
- **Gemini context:** the recent turns of the current conversation plus, if it has scrolled out of that window, the message that established the subject; our local clarifying exchange stays in context (off-topic rejections don't). The server rebuilds the subject from the validated history and passes it as a data-only line with a follow-up hint. History entries that try to act as instructions (role labels, "ignore your rules"…) are dropped server-side; roles other than user/assistant are rejected.
- Ordinary automotive questions get intent `general` and never produce a simulation proposal; modification requests keep the Proposal → Review → Apply → Simulation flow.
- **Answer depth and structure** (`src/lib/ai/responsePlan.ts`): each allowed message is read locally for depth (brief for definitions and short yes/no questions, standard for explanations, detailed for multi-part, relationship, comparison or explicitly detailed requests), audience (beginner / technical), comparisons, recommendations, follow-ups and its distinct questions. That guide travels in the same single Gemini request (no extra calls) together with a matching output budget (1,024 / 2,048 / 4,096 tokens). Multi-part questions are listed so each part is answered separately and in order.
- **Formatting:** replies use a small Markdown subset (paragraphs, `###` headings, lists, bold, small tables) rendered by `src/lib/markdown.ts` + `components/assistant/Markdown.tsx` into React elements — never HTML strings, no clickable model links, raw HTML shown as text. Wide tables scroll inside their own box on phones. Replies over 6,000 characters are shortened at a paragraph, and an answer cut off at the token limit keeps its completed part; both are labeled.
- Rejections use the fixed text *"I'm here for cars, parts, and vehicle performance. Ask me something automotive-related."* and are marked *answered locally, no AI request*.
- **Limitations:** it is a heuristic, not language understanding. A terse first message with rare slang or model names may be asked to clarify; an off-topic question with no off-topic vocabulary that reads like a follow-up inside a car conversation can reach Gemini, whose system instruction keeps it in scope; requests that merely mention a car inside creative/off-topic tasks are rejected.

### Conversations

Stored locally in IndexedDB (stores `chats` and `chatMessages`, separate from saved analyses): ID, title, timestamps, the ordered transcript, the vehicle in context and IDs of saved analyses the chat produced. Saved after every change; the last open conversation reopens on return; its vehicle is only *offered* for loading. Records are schema-validated on read; damaged ones are skipped, never crash the list. No keys, credentials or server instructions are stored.

- **Context sent to Gemini:** only the current conversation — the 8 most recent eligible turns plus, when needed, the subject-establishing turn (≤ 10 messages, 8,000 characters, each ≤ 1,500; formatted answers are sent in a compact form), excluding off-topic rejections, failed and engine-summary messages. Older turns are not sent and the UI says so; nothing is summarized by AI.
- **Titles** are generated locally from the user's words and vehicle (e.g. "2015 C300 — +40 hp", "M340i vs C43 AMG"); never by an AI request. Users can rename.
- Each request carries its conversation ID; a reply that arrives after the user switched chats is filed into its own conversation, never the one on screen. Failed messages stay in the transcript with **Retry**.
- Deleting a chat (or all chats) never deletes saved analyses, and deleting an analysis shows it as unavailable in the chat.
- **Privacy:** transcripts live only in this browser, but messages sent to the assistant are processed by Google's Gemini API. The server does not log conversation text.

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

**Rate limiting (audited):** 5 requests/min and 40/day per client, 300/day overall (env-configurable), plus duplicate-request IDs, an 800-character message limit, bounded history and context, a 64 KB body limit, a 1,024-token output cap, a 15 s provider timeout and no automatic retries. After a rate-limit or quota response the composer pauses. Without `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` these counters are **in-memory per serverless instance** — best-effort, not a reliable global limit. Upstash's free tier makes them shared; it is never enabled automatically. The real cost guarantee is a Gemini project without billing (requests beyond the free quota fail with 429, which the app reports).

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
