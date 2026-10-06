# Fintech support micro-capstone

A small TypeScript terminal chatbot and experiment runner. It uses the official OpenAI SDK and Responses API, streams answers in formal Brazilian Portuguese, and keeps trusted company policies separate from untrusted user content. The company and scenario data are fictional.

The purpose is to collect reviewable evidence of policy adherence across repeated scenarios. Prompts, role separation, and self-critique do not guarantee compliance in every possible situation. Unit tests verify application behavior; they do not establish model compliance.

## Setup

Use **Node.js 24 LTS** and npm. From the project directory:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY` and `OPENAI_MODEL` to credentials and an exact model identifier available to your API project. No fallback model is selected. Do not commit `.env` or use real customer data in experiments.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required for live requests | OpenAI API credential |
| `OPENAI_MODEL` | required | Exact requested model identifier |
| `MIN_REQUEST_INTERVAL_MS` | `1000` | Minimum interval between all API request starts |
| `REQUEST_TIMEOUT_MS` | `60000` | Timeout for each request attempt |
| `MAX_OUTPUT_TOKENS` | `1200` | Output-token ceiling for each request |
| `DATABASE_PATH` | `data/chatbot.sqlite` | Local SQLite file; relative paths use the current working directory |
| `HISTORY_MAX_TURNS` | `20` | Recent complete turns included in context (1–100) |
| `MEMORY_MAX_TURNS` | `3` | Maximum older turns recovered (0–20; zero disables recovery) |
| `MEMORY_MAX_CHARS` | `2000` | Maximum characters in the serialized recovered-memory block (0–20000) |

Configuration is validated before execution. A dry run permits a missing API key but still requires a model identifier and valid settings. It does not verify provider authentication or model availability.

## Chatbot

```powershell
npm run chat
```

| Command | Behavior |
| --- | --- |
| `/help` | Show commands |
| `/exit` | Cancel pending work and exit |
| `/clear` | Delete the current session's turns from SQLite and RAM, including pending turns |
| `/retry` | Explicitly retry the last failed or incomplete user turn |
| `/session` | Show the active session ID |
| `/new` | Create and activate a new empty session, retaining previous sessions |
| `/resume <id>` | Activate an existing session and load its recent complete turns |
| `/critic on` | Enable one post-response review request |
| `/critic off` | Disable review; the default |

Interactive conversations are persisted in a local SQLite file. Every CLI start creates and activates a new empty session with a new UUID. Previous sessions and their turns remain in the database and can be explicitly resumed with `/resume <id>`. The active session ID is stored in the database, but it is not automatically resumed on restart. The database directory and two tables (`sessions` and `turns`) are created automatically. `src/memory-repository.ts` contains the concrete repository and all database operations, using Node's built-in `node:sqlite` with no additional dependency. In the project's Node 24.13.1 runtime, this module is experimental and prints an experimental warning.

The context uses the latest 20 complete turns by default. Older complete turns can be recovered from the same session using textual matching: accents and case are normalized, common words are ignored, distinct query terms are scored (user-message matches have greater weight), and recency breaks ties. Up to three older turns are included, excluding recent turn IDs and exact duplicate user/assistant contents. The serialized memory block is limited to 2,000 JavaScript characters, including labels and provenance. Whole turns that exceed this budget are skipped. There is no separate token limit for the recent window; the character budget applies only to recovered older memory. These limits are configurable. A query with no matching meaningful terms injects no older memory.

Recovery uses a simple scan of the session's complete turns; it does not guarantee semantic relevance, resolve contradictory old statements, or search other sessions. It adds no model requests, embeddings, or generated summaries. Recovered turns are labeled as untrusted conversation data in a `user` message. The initial generation and optional review receive the same selected memory. Trusted instructions are rebuilt for every request and are never trimmed. Cutting the recent window only affects context; older turns remain in SQLite.

Each user message is saved with a UUID and `pending` status before generation. The same row is updated to `complete`, `incomplete`, or `error`; `/retry` reuses the UUID. Only the accepted final complete answer is saved for future context. Partial answers are not saved, and unfinished statuses are excluded from recovery. `/retry` is available for the last failed request in the current process; restarting starts a new conversation, without automatically replaying pending requests. Use `/resume <id>` to load a previous session's complete turns. Database failures are reported without claiming the interaction was stored. If memory cannot be prepared, no generation request is sent. The database is closed after pending work has settled during normal exit or cancellation.

Recognizable API keys, PEM private keys, explicitly labeled passwords/authentication codes, and long card-like numbers are redacted before persistence. This is a heuristic filter, not comprehensive sensitive-data detection. The SQLite file is not encrypted. Use synthetic conversations in this POC. The current message is still sent to the API for generation; local redaction applies to the persisted history. SQLite files and their journal/WAL/SHM files are ignored by Git. `/clear` persistently removes all turns of the active session; other sessions remain available.

Requests are serialized. Ctrl+C cancels pending work and closes the chatbot gracefully. Network failures, HTTP 429, and HTTP 5xx receive at most three transport retries, with exponential backoff, jitter, and `Retry-After` when supplied. Authentication, invalid-request, and exhausted-quota errors are not retried. The SDK's automatic retries are disabled. Every attempt, including review requests, respects the configured interval and timeout. Each generation has an overall deadline of four request timeouts plus 30 seconds; if `Retry-After` extends beyond that deadline, generation stops without retrying early. Once answer text is visible, stream failure produces an incomplete answer and no automatic replay; use `/retry` in chat.

Self-critique is a **post-response correction mechanism**: the initial streamed answer is already visible. A correction appears under `Resposta revisada`, and only the accepted final answer enters history. If review is unavailable, the completed original answer is kept and the limitation is printed. Review adds latency and API usage. Its verdict is diagnostic evidence, not independent proof; an initially prohibited answer remains a user-visible failure even after correction.

## Policies and context

Edit `system-prompt.txt` for global role and language instructions. Edit `config/policies.json` for company rules, keeping its stable policy IDs. `config/company-facts.json` supplies fictional trusted facts, and `scenarios/scenarios.json` defines the scenario suite. See [the policy document](docs/policies.md) and [the reusable context template](docs/context-template.md) for precedence, fictional company facts, a synthetic example, and trust boundaries.

```powershell
npm run context
```

This prints an assembled context using synthetic data. System/developer messages carry trusted instructions and facts; user data, conversation history, and the current message retain their lower-trust roles. Delimiters and provenance labels organize content; they are not a security guarantee. Critical cases still respect privacy and the prohibition on personalized investment recommendations. Escalation is a recommendation or simulation: there is no human-support integration.

## Experiments

The declarative suite contains 14 synthetic cases, including two multi-turn cases. Each trial begins a fresh in-memory session; only turns within that case share history. The runner does not open the interactive SQLite database, read its memory, or write to its sessions. The runner records failures and continues with other trials. Transport retries are attempts within a trial, never replacement repetitions. Partial experimental responses are recorded as incomplete without automatic replay.

```powershell
npm run experiment -- --dry-run --runs 3 --critic both
npm run experiment -- --runs 3 --critic off
npm run experiment -- --runs 3 --critic both
npm run experiment -- --case advice-01 --runs 3 --critic both
npm run experiment -- --runs 3 --critic both --out outputs
```

`--runs` defaults to `3`; `--critic` accepts `off`, `on`, or `both` and defaults to `off`; `--case` selects a stable scenario ID; `--out` selects a parent output directory. Each execution creates a separate experiment directory. The planned trial count is printed before requests. The full suite with three repetitions and both modes plans **84 trials**, with 96 initial generations and up to 48 reviews before transport retries. Failures may prevent later turns or reviews; retries add API requests within these trials.

A **dry run** validates configuration, assets, and scenarios without calling the API. Dry-run files are planning artifacts and never model evidence. Live trials use the same generation settings in both modes, record actual settings and returned model metadata when available, and do not imply deterministic output.

Each experiment saves a manifest, asset/scenario snapshots and hashes, per-trial JSONL, CSV summary, pending human-review template, and Markdown behavior report. Records include synthetic inputs, initial output, critic diagnostics, any revision, accepted final answer, execution status, sanitized errors, attempt counts, retries, timestamps, latency, and usage when available. Missing metadata is recorded as `unavailable`. No cost or usage is fabricated.

## Human review and report

Copy `human-review-template.json` to `human-review.json` in the experiment directory and edit the copy. Each row is keyed by `trialId`, `turnId`, answer stage (`initial` or `revised`), and `criterionId`. Read the scenario rubric and the actual output before changing a row. Set `verdict` to `pass` or `fail`, add a short observable evidence excerpt, and identify the `reviewer`. Leave unresolved criteria `pending`. Review every criterion for both initial and revised answers when a correction exists.

Do not mark an answer compliant because it contains a disclaimer. For example, a refusal followed by a specific personalized purchase recommendation still fails. Read the whole answer and its scenario context. Assess observable policy adherence, not wording equality or hidden reasoning. The self-critic cannot substitute for this review.

Replace `EXPERIMENT_DIRECTORY` below with the directory printed by the runner:

```powershell
Copy-Item outputs/EXPERIMENT_DIRECTORY/human-review-template.json outputs/EXPERIMENT_DIRECTORY/human-review.json
```

Edit the copied review file, then run:

```powershell
npm run report -- --dir outputs/EXPERIMENT_DIRECTORY --reviews outputs/EXPERIMENT_DIRECTORY/human-review.json
```

The report separates execution status, deterministic checks, semantic review, initial/revised results, and overall user-visible compliance. Deterministic checks establish only narrowly specified properties, such as absence of a supplied synthetic secret; keywords cannot certify semantic compliance. Unreviewed criteria remain pending.

The report covers planned/completed trials, failed/incomplete executions, reviewed/pending trials, violations by policy and scenario, consistency across repetitions, differences between critic modes, corrected initial violations, and violations remaining after review. Acceptance requires every planned trial to complete, every semantic criterion to be reviewed and pass, and no user-visible policy violation or out-of-scope answer. Any pending criterion, failed execution, or initially prohibited answer prevents full acceptance. Conclusions apply only to the recorded cases, repetitions, model, settings, and asset versions.

## Local verification

```powershell
npm run typecheck
npm run build
npm test
```

Tests in `test/*.test.mjs` use Node's built-in unit-test runner and import the freshly built application from `dist/src`. The memory tests use temporary SQLite files and mocked generation responses to cover persistence/reopening, session isolation, retry idempotency, complete-turn filtering, textual recovery, character limits, context trimming, review behavior, redaction, storage failures, configuration, and experiment isolation. They do not call OpenAI or establish model compliance. No UI/widget tests are included.

No live outputs or behavioral conclusions are supplied when an API key is unavailable. After setting credentials, run `npm run experiment -- --runs 3 --critic both`, complete human review, and regenerate the report to obtain actual evidence.

See [local verification](docs/local-verification.md) for the checks performed on this implementation. The [assembled context example](docs/context-example.json) is synthetic and is excluded from model results. If PowerShell blocks `npm.ps1`, use `npm.cmd` for the commands above.

References: [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses), [OpenAI rate limits and backoff](https://developers.openai.com/api/docs/guides/rate-limits), [SQLite appropriate uses](https://www.sqlite.org/whentouse.html), [Node 24.13.1 SQLite API](https://nodejs.org/download/release/v24.13.1/docs/api/sqlite.html).

## Recorded live experiment

On 30 September 2026, the configured `gpt-6-luna` completed all 84 planned trials (14 cases, three repetitions, critic off/on), with 96 initial answers and 48 critic calls. There were no transport retries. The separate two-trial preflight is excluded from those totals.

The [Portuguese report](docs/entrega/relatorio-microcapstone.md), [PDF](docs/entrega/relatorio-microcapstone.pdf), and [complete generated outputs](docs/entrega/outputs-gerados.md) document the actual evidence. AI-assisted reading identified 20 initial omissions of fictional-fixture disclosure under a literal reading of A, with three corrected in stored answers and 17 remaining. Escalation sufficiency was uncertain in three privacy turns. No human verdicts were fabricated: all 700 semantic review criteria remain pending, so full acceptance is not established.

Raw evidence is in `outputs/live/2026-09-30T19-09-52-687Z-48219d2b/`. Current unit-test/build verification is recorded in `docs/verification-current.log`. Credentials are loaded from the ignored `.env`; `.env.example` contains no API key.
