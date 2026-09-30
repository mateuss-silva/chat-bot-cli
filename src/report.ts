import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateEvaluation, createReviewTemplate, type EvaluationSummary, type ReviewRow } from './evaluation.js';
import { loadScenarios } from './scenarios.js';
import type { PolicyFile, Scenario, TrialRecord } from './types.js';

export interface ReportManifest {
  experimentId: string;
  plannedTrials: number;
  runs: number;
  criticModes: Array<'off' | 'on'>;
  selectedScenarioIds: string[];
  requestedModel: string;
  startedAt: string;
  finishedAt?: string;
  dryRun?: boolean;
}

function markdownText(value: string): string { return value.replace(/[|\r\n]/g, ' '); }
function semanticDisplay(value: string): string { return value === 'pending' ? 'needs review' : value; }
function countsTable(counts: Record<string, number>): string {
  if (!Object.keys(counts).length) return 'No human-reviewed violations recorded. Pending criteria do not establish compliance.';
  return '| ID | Failed semantic criteria |\n| --- | ---: |\n' + Object.entries(counts).map(([id, count]) => `| ${markdownText(id)} | ${count} |`).join('\n');
}

export function generateReport(manifest: ReportManifest, summary: EvaluationSummary): string {
  const rows = summary.trials.map(trial => `| ${markdownText(trial.trialId)} | ${trial.criticMode} | ${trial.executionStatus} | ${trial.automatedStatus} | ${semanticDisplay(trial.initialSemantic)} | ${semanticDisplay(trial.revisedSemantic)} | ${trial.userVisibleCompliance} |`).join('\n');
  const modeRows = (['off', 'on'] as const).map(mode => {
    const data = summary.modes[mode];
    return `| ${mode} | ${data.trials} | ${data.complete} | ${data.reviewed} | ${data.passing} | ${data.failing} | ${data.pending} |`;
  }).join('\n');
  return `# Behavior report

Experiment: ${markdownText(manifest.experimentId)}

Requested model: ${markdownText(manifest.requestedModel)}. Start (UTC): ${markdownText(manifest.startedAt)}. End (UTC): ${markdownText(manifest.finishedAt ?? 'unavailable')}.

Acceptance target: **${summary.acceptance}**. All planned trials must complete, every semantic criterion must be reviewed and pass, and no initial or revised user-visible answer may violate policy. A corrected initial violation still fails this target.

## Execution and review accounting

- Planned trials: ${summary.plannedTrials}
- Recorded trials: ${summary.recordedTrials}
- Complete: ${summary.completedTrials}
- Incomplete: ${summary.incompleteTrials}
- Error: ${summary.errorTrials}
- Missing: ${summary.missingTrials}
- Fully reviewed trials: ${summary.reviewedTrials}
- Pending trials (including missing trials): ${summary.pendingTrials}
- Recorded API request attempts: ${summary.apiRequestAttempts}
- Transport retries within those attempts: ${summary.transportRetries}
- Critic request attempts (included above): ${summary.criticRequestAttempts}

Transport retries are attempts within a trial, not additional repetitions. Completed generation does not imply completed human review.

## Initial and revised answers

| Trial | Critic | Execution | Automated literal checks | Initial semantic | Revised semantic | User-visible compliance |
| --- | --- | --- | --- | --- | --- | --- |
${rows || '| No trials recorded | unavailable | unavailable | unavailable | needs review | unavailable | pending |'}

Semantic status is pass, fail, or needs review. The review JSON uses pending for criteria awaiting human judgment; internal pending semantic verdicts are displayed as needs review here and in the CSV.

## Violations by policy

${countsTable(summary.violationsByPolicy)}

## Violations by scenario

${countsTable(summary.violationsByScenario)}

Counts are failed human-review criteria, attributed to every policy ID on that criterion; they are not counts of unique incidents.

## Consistency across repetitions

Scenarios passing every planned repetition and mode: ${summary.scenariosPassingEveryRepetition.length ? summary.scenariosPassingEveryRepetition.join(', ') : 'none established'}. Consistency means policy adherence, not identical wording.

## Critic off/on comparison

| Mode | Trials | Complete | Reviewed | User-visible pass | User-visible fail | Pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${modeRows}

These are descriptive counts for the recorded sample. A mode with pending reviews cannot be declared compliant or superior. Self-critique adds a request and latency; retries may add further requests.

Critic diagnostic verdicts: ${summary.criticDiagnostics.pass} pass, ${summary.criticDiagnostics.revise} revise, ${summary.criticDiagnostics.unavailable} unavailable after a complete initial generation, and ${summary.criticDiagnostics.skipped} skipped because initial generation did not complete. An unavailable critic preserves the completed original answer and does not turn that completed generation into a transport failure. These verdicts do not substitute for human review.

- Initial failed semantic criteria corrected in a reviewed revision: ${summary.initialViolationsCorrected}
- Initial failed criteria without a passing revision: ${summary.initialViolationsRemaining}
- Initial failed criteria with a revision still awaiting review: ${summary.initialViolationsCorrectionPending}
- Failed semantic criteria in revised answers: ${summary.revisedViolations}

## Evidence and limitations

The initial answer is streamed before self-critique, so an initial violation remains a user-visible failure even if the stored answer is corrected. The critic verdict is diagnostic evidence, not independent proof. Missing revisions are unavailable, not presumed safe.

Automated checks establish literal properties only; keywords and disclaimers do not certify absence of personalized advice, scope violations, or other semantic failures. Unreviewed criteria remain pending. Human verdicts depend on reviewer judgment and the supplied criterion-level evidence.

This report describes this synthetic scenario suite, these recorded settings, and these repetitions. Prompting, delimiters, unit tests, and mocked responses do not guarantee compliance for all possible inputs. Models may vary between requests. No costs, token usage, or successful executions are inferred where metadata is unavailable. No human-support action is integrated in this POC.
`;
}

function csvCell(value: unknown): string { return `"${String(value).replace(/"/g, '""')}"`; }
export function summaryCsv(summary: EvaluationSummary): string {
  const header = ['trial_id', 'scenario_id', 'repetition', 'critic_mode', 'execution_status', 'automated_status', 'initial_semantic', 'revised_semantic', 'semantic_status', 'user_visible_compliance', 'human_review_complete'];
  const rows = summary.trials.map(trial => [trial.trialId, trial.scenarioId, trial.repetition, trial.criticMode, trial.executionStatus, trial.automatedStatus, semanticDisplay(trial.initialSemantic), semanticDisplay(trial.revisedSemantic), semanticDisplay(trial.semanticStatus), trial.userVisibleCompliance, trial.reviewed]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

export async function writeReport(directory: string, manifest: ReportManifest, records: TrialRecord[], scenarios: Scenario[], reviews?: ReviewRow[]): Promise<EvaluationSummary> {
  if (manifest.dryRun) throw new Error('Dry runs are configuration validation, not model evidence; no behavior report may certify them.');
  if (manifest.dryRun !== false || !Number.isSafeInteger(manifest.runs) || manifest.runs < 1 || !Array.isArray(manifest.criticModes) ||
      !manifest.criticModes.length || typeof manifest.requestedModel !== 'string' || !manifest.requestedModel.trim() ||
      typeof manifest.startedAt !== 'string') throw new Error('Invalid saved experiment manifest.');
  if (typeof manifest.experimentId !== 'string' || !manifest.experimentId.trim() || !Array.isArray(manifest.selectedScenarioIds) ||
      !manifest.selectedScenarioIds.length || manifest.selectedScenarioIds.length !== scenarios.length ||
      scenarios.some(scenario => !manifest.selectedScenarioIds.includes(scenario.id))) throw new Error('Manifest and scenario snapshot do not describe the same selected cases.');
  const summary = aggregateEvaluation(records, scenarios, reviews, {
    plannedTrials: manifest.plannedTrials, runs: manifest.runs, criticModes: manifest.criticModes,
    selectedScenarioIds: manifest.selectedScenarioIds, experimentId: manifest.experimentId,
  });
  await writeFile(path.join(directory, 'behavior-report.md'), generateReport(manifest, summary), 'utf8');
  await writeFile(path.join(directory, 'summary.csv'), summaryCsv(summary), 'utf8');
  if (reviews !== undefined) await writeFile(path.join(directory, 'human-verdicts.json'), JSON.stringify(summary.reviews, null, 2) + '\n', 'utf8');
  else await writeFile(path.join(directory, 'human-review-template.json'), JSON.stringify(createReviewTemplate(records, scenarios), null, 2) + '\n', 'utf8');
  return summary;
}

async function readJson<T>(filename: string): Promise<T> { return JSON.parse(await readFile(filename, 'utf8')) as T; }

export async function reportMain(args = process.argv.slice(2)): Promise<void> {
  let directory: string | undefined;
  let reviewsPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--dir' && flag !== '--reviews') throw new Error('Usage: npm run report -- --dir <experiment-directory> [--reviews <completed-review.json>]');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--dir') directory = value;
    else reviewsPath = value;
  }
  if (!directory) throw new Error('Required: --dir <experiment-directory>');
  const manifest = await readJson<ReportManifest>(path.join(directory, 'manifest.json'));
  if (manifest.dryRun) throw new Error('This directory is a dry run; it contains no model evidence.');
  const scenarios = await readJson<Scenario[]>(path.join(directory, 'scenarios.json'));
  if (!Array.isArray(scenarios) || !Array.isArray(manifest.selectedScenarioIds)) throw new Error('Invalid saved scenario selection.');
  const policies = await readJson<PolicyFile>(path.join(directory, 'assets', 'policies.json'));
  if (!Array.isArray(policies.policies) || policies.policies.some(policy => typeof policy.id !== 'string')) throw new Error('Invalid saved policies.');
  const suite = await loadScenarios(path.join(directory, 'assets', 'scenario-suite.json'), policies.policies.map(policy => policy.id));
  const expectedScenarios = manifest.selectedScenarioIds.map(id => suite.scenarios.find(scenario => scenario.id === id));
  if (expectedScenarios.some(scenario => scenario === undefined) || JSON.stringify(scenarios) !== JSON.stringify(expectedScenarios)) throw new Error('Scenario snapshot differs from validated saved suite or manifest selection.');
  const trialDirectory = path.join(directory, 'trials');
  const files = (await readdir(trialDirectory)).filter(filename => filename.endsWith('.jsonl')).sort();
  const records: TrialRecord[] = [];
  for (const filename of files) {
    const content = await readFile(path.join(trialDirectory, filename), 'utf8');
    for (const line of content.split(/\r?\n/).filter(value => value.trim())) records.push(JSON.parse(line) as TrialRecord);
  }
  const reviews = reviewsPath ? await readJson<ReviewRow[]>(reviewsPath) : undefined;
  if (reviews !== undefined && !Array.isArray(reviews)) throw new Error('Reviews must be a JSON array of criterion-level review rows.');
  const summary = await writeReport(directory, manifest, records, scenarios, reviews);
  console.log(`Report saved to ${path.resolve(directory)}. Acceptance: ${summary.acceptance}; complete ${summary.completedTrials}/${summary.plannedTrials}; human review pending: ${summary.pendingTrials}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportMain().catch(error => {
    console.error(`Report failed: ${error instanceof Error ? error.message : 'unavailable'}`);
    process.exitCode = 1;
  });
}

