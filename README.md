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

Configuration is validated before execution. A dry run permits a missing API key but still requires a model identifier and valid settings. It does not verify provider authentication or model availability.

## Chatbot

```powershell
npm run chat
```

| Command | Behavior |
| --- | --- |
| `/help` | Show commands |
| `/exit` | Cancel pending work and exit |
| `/clear` | Reset conversation history |
| `/retry` | Explicitly retry the last failed or incomplete user turn |
| `/critic on` | Enable one post-response review request |
| `/critic off` | Disable review; the default |

Only the latest 20 complete turns are retained in memory. Trusted instructions are rebuilt for every request and are never trimmed. A partial answer is never stored in conversation history. Interactive conversations are not written to disk by this application; their content is still sent to the API for generation.

Requests are serialized. Ctrl+C cancels pending work and closes the chatbot gracefully. Network failures, HTTP 429, and HTTP 5xx receive at most three transport retries, with exponential backoff, jitter, and `Retry-After` when supplied. Authentication, invalid-request, and exhausted-quota errors are not retried. The SDK's automatic retries are disabled. Every attempt, including review requests, respects the configured interval and timeout. Each generation has an overall deadline of four request timeouts plus 30 seconds; if `Retry-After` extends beyond that deadline, generation stops without retrying early. Once answer text is visible, stream failure produces an incomplete answer and no automatic replay; use `/retry` in chat.

Self-critique is a **post-response correction mechanism**: the initial streamed answer is already visible. A correction appears under `Resposta revisada`, and only the accepted final answer enters history. If review is unavailable, the completed original answer is kept and the limitation is printed. Review adds latency and API usage. Its verdict is diagnostic evidence, not independent proof; an initially prohibited answer remains a user-visible failure even after correction.

## Policies and context

Edit `system-prompt.txt` for global role and language instructions. Edit `config/policies.json` for company rules, keeping its stable policy IDs. `config/company-facts.json` supplies fictional trusted facts, and `scenarios/scenarios.json` defines the scenario suite. See [the policy document](docs/policies.md) and [the reusable context template](docs/context-template.md) for precedence, fictional company facts, a synthetic example, and trust boundaries.

```powershell
npm run context
```

This prints an assembled context using synthetic data. System/developer messages carry trusted instructions and facts; user data, conversation history, and the current message retain their lower-trust roles. Delimiters and provenance labels organize content; they are not a security guarantee. Critical cases still respect privacy and the prohibition on personalized investment recommendations. Escalation is a recommendation or simulation: there is no human-support integration.

## Experiments

The declarative suite contains 14 synthetic cases, including two multi-turn cases. Each trial begins a fresh session; only turns within that case share history. The runner records failures and continues with other trials. Transport retries are attempts within a trial, never replacement repetitions. Partial experimental responses are recorded as incomplete without automatic replay.

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

Tests use Node's built-in unit-test runner and cover context trust separation, history trimming, transport retry behavior, fake-clock rate limiting, scenario validation, and report accounting. They use synthetic fixtures and mocked responses. They do not call OpenAI or establish model compliance. No UI/widget tests are included.

No live outputs or behavioral conclusions are supplied when an API key is unavailable. After setting credentials, run `npm run experiment -- --runs 3 --critic both`, complete human review, and regenerate the report to obtain actual evidence.

See [local verification](docs/local-verification.md) for the checks performed on this implementation. The [assembled context example](docs/context-example.json) is synthetic and is excluded from model results. If PowerShell blocks `npm.ps1`, use `npm.cmd` for the commands above.

References: [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses), [OpenAI rate limits and backoff](https://developers.openai.com/api/docs/guides/rate-limits).
