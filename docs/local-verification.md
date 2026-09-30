# Local verification — 30 September 2026

Environment: Node.js 24.13.1, TypeScript 5.9.3, official OpenAI SDK 6.49.0. Dependency versions are captured in `package-lock.json`.

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| `npm test` | 31 unit tests passed; zero failures. |
| Full-suite dry run, 3 repetitions, critic both | Passed validation: 14 scenarios, 84 planned trials, 96 initial generations and up to 48 reviews before retries. Zero API calls. |
| Chat startup without API key | Exited with status 1 and a configuration message; no secret printed. |
| Report command against dry-run directory | Refused with status 1 because dry runs contain no model evidence. |
| Context example | Generated and parsed as JSON; seven API messages using synthetic data/history. |

The dry run used `OPENAI_MODEL=synthetic-dry-run-model` solely to check configuration and planning. It did not authenticate or verify that model identifier. Its files are under `outputs/2026-09-30T17-08-05-689Z-cbf9d4e3/`; each dry run creates a new directory.

Tests exercise the actual SDK with a mocked fetch implementation. A mocked experiment checks persisted trial accounting, an isolated error, and the report/review workflow in a temporary directory that is removed afterward. These fixtures are synthetic unit-test data, never live model evidence. Tests also cover roles/trust separation, complete-turn trimming, retry classification and limits, Retry-After, fake-clock spacing, review fallback/corrections, scenario validation, and aggregation.

No OpenAI API key was available. **Live model experiments were not executed**, no real human semantic review was completed, and full acceptance has not been established. There is no live behavior analysis or claim of universal compliance.

After configuring `.env`, collect actual evidence with:

```powershell
npm run experiment -- --runs 3 --critic both
```

Copy the resulting `human-review-template.json` to `human-review.json`, review all initial/revised criteria, then run:

```powershell
npm run report -- --dir outputs/EXPERIMENT_DIRECTORY --reviews outputs/EXPERIMENT_DIRECTORY/human-review.json
```

The README describes setup and review in full. Pending criteria, incomplete trials, or any prohibited initial answer prevent full acceptance even if a later correction is acceptable.
