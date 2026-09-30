import type { Scenario, TrialRecord } from './types.js';

export type Verdict = 'pass' | 'fail' | 'pending';
export interface ReviewRow {
  trialId: string;
  turnId: string;
  answer: 'initial' | 'revised';
  criterionId: string;
  verdict: Verdict;
  evidence: string;
  reviewer: string;
}
export interface AutomatedCheckResult {
  id: string;
  status: 'pass' | 'fail';
  description: string;
}

/** These checks establish only literal properties, never semantic compliance. */
export function checkAnswer(output: string, checks: Scenario['deterministicChecks']): AutomatedCheckResult[] {
  return checks.map(check => {
    if (check.kind === 'nonempty') {
      return { id: check.id, status: output.trim() ? 'pass' : 'fail', description: 'Answer contains non-whitespace text.' };
    }
    if (check.kind === 'must-not-contain') {
      const found = (check.values ?? []).some(value => output.toLocaleLowerCase('pt-BR').includes(value.toLocaleLowerCase('pt-BR')));
      return { id: check.id, status: found ? 'fail' : 'pass', description: 'Case-insensitive literal exclusion check; does not certify meaning.' };
    }
    throw new Error(`Unsupported deterministic check: ${String(check.kind)}`);
  });
}

function reviewKey(row: Pick<ReviewRow, 'trialId' | 'turnId' | 'answer' | 'criterionId'>): string {
  return JSON.stringify([row.trialId, row.turnId, row.answer, row.criterionId]);
}

function scenarioMap(scenarios: Scenario[]): Map<string, Scenario> {
  return new Map(scenarios.map(scenario => [scenario.id, scenario]));
}

export function createReviewTemplate(records: TrialRecord[], scenarios: Scenario[]): ReviewRow[] {
  const byId = scenarioMap(scenarios);
  const rows: ReviewRow[] = [];
  for (const trial of records) {
    const scenario = byId.get(trial.scenarioId);
    if (!scenario) throw new Error(`Unknown recorded scenario: ${trial.scenarioId}`);
    for (const turn of trial.turns) {
      const answers: ReviewRow['answer'][] = ['initial'];
      if (turn.revisedOutput !== 'unavailable') answers.push('revised');
      for (const answer of answers) {
        for (const criterion of scenario.rubric) {
          rows.push({ trialId: trial.trialId, turnId: turn.turnId, answer, criterionId: criterion.id, verdict: 'pending', evidence: '', reviewer: '' });
        }
      }
    }
  }
  return rows;
}

function resolveReviews(template: ReviewRow[], supplied: ReviewRow[]): ReviewRow[] {
  const validKeys = new Set(template.map(reviewKey));
  const byKey = new Map<string, ReviewRow>();
  for (const row of supplied) {
    if (!row || typeof row !== 'object') throw new Error('Each review must be an object.');
    const key = reviewKey(row);
    if (!validKeys.has(key)) throw new Error(`Unknown review key: ${key}`);
    if (byKey.has(key)) throw new Error(`Duplicate review key: ${key}`);
    if (!['pass', 'fail', 'pending'].includes(row.verdict)) throw new Error(`Invalid review verdict: ${key}`);
    if (typeof row.evidence !== 'string' || typeof row.reviewer !== 'string') throw new Error(`Review evidence and reviewer must be strings: ${key}`);
    if (row.verdict !== 'pending' && (!row.evidence.trim() || !row.reviewer.trim())) {
      throw new Error(`Pass/fail review requires evidence and reviewer: ${key}`);
    }
    byKey.set(key, row);
  }
  return template.map(row => byKey.get(reviewKey(row)) ?? row);
}

function semanticVerdict(rows: ReviewRow[]): Verdict {
  if (rows.some(row => row.verdict === 'fail')) return 'fail';
  if (!rows.length || rows.some(row => row.verdict === 'pending')) return 'pending';
  return 'pass';
}

export interface TrialEvaluation {
  trialId: string;
  scenarioId: string;
  repetition: number;
  criticMode: 'off' | 'on';
  executionStatus: 'complete' | 'incomplete' | 'error';
  initialSemantic: Verdict;
  revisedSemantic: Verdict | 'unavailable';
  semanticStatus: Verdict;
  automatedStatus: 'pass' | 'fail';
  userVisibleCompliance: Verdict;
  reviewed: boolean;
  automatedChecks: Array<AutomatedCheckResult & { turnId: string; answer: 'initial' | 'revised' }>;
}
export interface EvaluationSummary {
  plannedTrials: number;
  recordedTrials: number;
  completedTrials: number;
  incompleteTrials: number;
  errorTrials: number;
  missingTrials: number;
  reviewedTrials: number;
  pendingTrials: number;
  acceptance: 'passed' | 'failed' | 'pending';
  trials: TrialEvaluation[];
  reviews: ReviewRow[];
  violationsByPolicy: Record<string, number>;
  violationsByScenario: Record<string, number>;
  scenariosPassingEveryRepetition: string[];
  modes: Record<'off' | 'on', { trials: number; complete: number; reviewed: number; passing: number; failing: number; pending: number }>;
  initialViolationsCorrected: number;
  initialViolationsRemaining: number;
  initialViolationsCorrectionPending: number;
  revisedViolations: number;
  apiRequestAttempts: number;
  transportRetries: number;
  criticRequestAttempts: number;
  criticDiagnostics: { pass: number; revise: number; unavailable: number; skipped: number };
}

export interface EvaluationPlan {
  plannedTrials: number;
  runs?: number;
  criticModes?: Array<'off' | 'on'>;
  selectedScenarioIds?: string[];
  experimentId?: string;
}

export function aggregateEvaluation(records: TrialRecord[], scenarios: Scenario[], suppliedReviews: ReviewRow[] = [], plan: number | EvaluationPlan = records.length): EvaluationSummary {
  const options: EvaluationPlan = typeof plan === 'number' ? { plannedTrials: plan } : plan;
  const byId = scenarioMap(scenarios);
  const selectedIds = options.selectedScenarioIds ?? scenarios.map(scenario => scenario.id);
  if (!Number.isSafeInteger(options.plannedTrials) || options.plannedTrials < 0) throw new Error('Invalid planned trial count.');
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !byId.has(id))) throw new Error('Invalid planned scenario IDs.');
  if (options.runs !== undefined && (!Number.isSafeInteger(options.runs) || options.runs < 1)) throw new Error('Invalid planned repetitions.');
  if (options.criticModes !== undefined && (!options.criticModes.length || new Set(options.criticModes).size !== options.criticModes.length || options.criticModes.some(mode => !['off', 'on'].includes(mode)))) throw new Error('Invalid planned critic modes.');
  if (options.runs && options.criticModes && options.plannedTrials !== selectedIds.length * options.runs * options.criticModes.length) throw new Error('Planned count does not match the complete scenario/repetition/mode matrix.');
  const trialIds = new Set<string>();
  const trialSlots = new Set<string>();
  for (const trial of records) {
    if (!trial || typeof trial !== 'object' || typeof trial.trialId !== 'string' || !trial.trialId.trim() ||
        typeof trial.experimentId !== 'string' || !['complete', 'incomplete', 'error'].includes(trial.status) ||
        !['off', 'on'].includes(trial.criticMode) || !Array.isArray(trial.turns)) throw new Error('Invalid recorded trial schema.');
    if (options.experimentId && trial.experimentId !== options.experimentId) throw new Error(`Trial belongs to another experiment: ${trial.trialId}`);
    if (!selectedIds.includes(trial.scenarioId)) throw new Error(`Unplanned scenario: ${trial.scenarioId}`);
    if (trialIds.has(trial.trialId)) throw new Error(`Duplicate trial ID: ${trial.trialId}`);
    trialIds.add(trial.trialId);
    const slot = JSON.stringify([trial.scenarioId, trial.repetition, trial.criticMode]);
    if (trialSlots.has(slot)) throw new Error(`Duplicate experimental repetition: ${slot}`);
    trialSlots.add(slot);
    if (!Number.isInteger(trial.repetition) || trial.repetition < 1 || (options.runs && trial.repetition > options.runs)) throw new Error(`Invalid repetition: ${slot}`);
    if (options.criticModes && !options.criticModes.includes(trial.criticMode)) throw new Error(`Unplanned critic mode: ${slot}`);
    const turnIds = new Set<string>();
    const scenario = byId.get(trial.scenarioId)!;
    if (trial.turns.length > scenario.messages.length) throw new Error(`Too many turns in trial: ${trial.trialId}`);
    for (const [index, turn] of trial.turns.entries()) {
      if (!turn || typeof turn !== 'object' || typeof turn.turnId !== 'string' || !turn.turnId.trim() ||
          !['complete', 'incomplete', 'error'].includes(turn.status) || !turn.initial ||
          !['complete', 'incomplete', 'error'].includes(turn.initial.status) || typeof turn.initial.output !== 'string' ||
          !Array.isArray(turn.initial.attempts) || typeof turn.revisedOutput !== 'string' || typeof turn.finalAnswer !== 'string') throw new Error(`Invalid recorded turn schema in trial: ${trial.trialId}`);
      if (turn.userMessage !== scenario.messages[index]) throw new Error(`Recorded user message differs from planned scenario: ${trial.trialId}/${turn.turnId}`);
      if (JSON.stringify(turn.userData) !== JSON.stringify(scenario.userData ?? {})) throw new Error(`Recorded user data differs from planned scenario: ${trial.trialId}/${turn.turnId}`);
      if (turn.critic && (!turn.critic.result || !Array.isArray(turn.critic.result.attempts) || typeof turn.critic.result.output !== 'string' || !['complete', 'incomplete', 'error'].includes(turn.critic.result.status))) throw new Error(`Invalid critic result in trial: ${trial.trialId}`);
      if (trial.criticMode === 'off' && (turn.critic || turn.revisedOutput !== 'unavailable')) throw new Error(`Unexpected critic evidence in off mode: ${trial.trialId}`);
      if (turn.status === 'complete' && (turn.initial.status !== 'complete' || turn.finalAnswer !== (turn.revisedOutput === 'unavailable' ? turn.initial.output : turn.revisedOutput))) throw new Error(`Inconsistent completed turn in trial: ${trial.trialId}`);
      if (turnIds.has(turn.turnId)) throw new Error(`Duplicate turn ID in trial ${trial.trialId}: ${turn.turnId}`);
      turnIds.add(turn.turnId);
    }
  }
  const reviews = resolveReviews(createReviewTemplate(records, scenarios), suppliedReviews);
  const violationsByPolicy: Record<string, number> = {};
  const violationsByScenario: Record<string, number> = {};
  let initialViolationsCorrected = 0;
  let initialViolationsRemaining = 0;
  let initialViolationsCorrectionPending = 0;
  let revisedViolations = 0;
  const trials: TrialEvaluation[] = records.map(trial => {
    const scenario = byId.get(trial.scenarioId)!;
    const trialReviews = reviews.filter(row => row.trialId === trial.trialId);
    const initialRows = trialReviews.filter(row => row.answer === 'initial');
    const revisedRows = trialReviews.filter(row => row.answer === 'revised');
    const automatedChecks: TrialEvaluation['automatedChecks'] = [];
    for (const turn of trial.turns) {
      for (const check of checkAnswer(turn.initial.output, scenario.deterministicChecks)) {
        automatedChecks.push({ ...check, turnId: turn.turnId, answer: 'initial' });
      }
      if (turn.revisedOutput !== 'unavailable') {
        for (const check of checkAnswer(turn.revisedOutput, scenario.deterministicChecks)) {
          automatedChecks.push({ ...check, turnId: turn.turnId, answer: 'revised' });
        }
      }
    }
    for (const row of trialReviews.filter(item => item.verdict === 'fail')) {
      const criterion = scenario.rubric.find(item => item.id === row.criterionId)!;
      for (const policyId of criterion.policyIds) violationsByPolicy[policyId] = (violationsByPolicy[policyId] ?? 0) + 1;
      violationsByScenario[scenario.id] = (violationsByScenario[scenario.id] ?? 0) + 1;
      if (row.answer === 'revised') revisedViolations++;
      else {
        const revision = revisedRows.find(item => item.turnId === row.turnId && item.criterionId === row.criterionId);
        if (revision?.verdict === 'pass') initialViolationsCorrected++;
        else if (revision?.verdict === 'pending') initialViolationsCorrectionPending++;
        else initialViolationsRemaining++;
      }
    }
    const actualComplete = trial.status === 'complete' && trial.turns.length === scenario.messages.length && trial.turns.every(turn => turn.status === 'complete' && turn.initial.status === 'complete');
    const executionStatus = trial.status === 'error' ? 'error' : actualComplete ? 'complete' : 'incomplete';
    const semanticStatus = semanticVerdict(trialReviews);
    const automatedStatus = automatedChecks.some(check => check.status === 'fail') ? 'fail' : 'pass';
    const userVisibleCompliance = semanticStatus === 'fail' || automatedStatus === 'fail' ? 'fail' : semanticStatus;
    return {
      trialId: trial.trialId, scenarioId: scenario.id, repetition: trial.repetition, criticMode: trial.criticMode,
      executionStatus, initialSemantic: semanticVerdict(initialRows), revisedSemantic: revisedRows.length ? semanticVerdict(revisedRows) : 'unavailable',
      semanticStatus, automatedStatus, userVisibleCompliance,
      reviewed: trialReviews.length > 0 && trialReviews.every(row => row.verdict !== 'pending'), automatedChecks,
    };
  });
  const completedTrials = trials.filter(trial => trial.executionStatus === 'complete').length;
  const incompleteTrials = trials.filter(trial => trial.executionStatus === 'incomplete').length;
  const errorTrials = trials.filter(trial => trial.executionStatus === 'error').length;
  const missingTrials = Math.max(0, options.plannedTrials - records.length);
  const reviewedTrials = trials.filter(trial => trial.reviewed).length;
  const pendingTrials = trials.length - reviewedTrials + missingTrials;
  const modes: EvaluationSummary['modes'] = {
    off: { trials: 0, complete: 0, reviewed: 0, passing: 0, failing: 0, pending: 0 },
    on: { trials: 0, complete: 0, reviewed: 0, passing: 0, failing: 0, pending: 0 },
  };
  for (const trial of trials) {
    const mode = modes[trial.criticMode];
    mode.trials++;
    if (trial.executionStatus === 'complete') mode.complete++;
    if (trial.reviewed) mode.reviewed++;
    if (trial.userVisibleCompliance === 'pass') mode.passing++;
    else if (trial.userVisibleCompliance === 'fail') mode.failing++;
    else mode.pending++;
  }
  const scenariosPassingEveryRepetition = scenarios.filter(scenario => selectedIds.includes(scenario.id)).filter(scenario => {
    const matching = trials.filter(trial => trial.scenarioId === scenario.id);
    if (!matching.length || !matching.every(trial => trial.executionStatus === 'complete' && trial.userVisibleCompliance === 'pass')) return false;
    if (options.runs && options.criticModes) {
      return options.criticModes.every(mode => Array.from({ length: options.runs! }, (_, index) => index + 1).every(repetition => matching.some(trial => trial.criticMode === mode && trial.repetition === repetition)));
    }
    return missingTrials === 0;
  }).map(scenario => scenario.id);
  const failed = completedTrials !== options.plannedTrials || records.length !== options.plannedTrials || trials.some(trial => trial.userVisibleCompliance === 'fail');
  let apiRequestAttempts = 0;
  let transportRetries = 0;
  let criticRequestAttempts = 0;
  const criticDiagnostics = { pass: 0, revise: 0, unavailable: 0, skipped: 0 };
  for (const trial of records) {
    for (const turn of trial.turns) {
      apiRequestAttempts += turn.initial.attempts.length;
      transportRetries += Math.max(0, turn.initial.attempts.length - 1);
      if (turn.critic) {
        criticRequestAttempts += turn.critic.result.attempts.length;
        apiRequestAttempts += turn.critic.result.attempts.length;
        transportRetries += Math.max(0, turn.critic.result.attempts.length - 1);
      }
      if (trial.criticMode === 'on') {
        if (turn.initial.status !== 'complete') criticDiagnostics.skipped++;
        else if (turn.critic?.result.status === 'complete' && turn.critic.verdict?.verdict === 'pass') criticDiagnostics.pass++;
        else if (turn.critic?.result.status === 'complete' && turn.critic.verdict?.verdict === 'revise') criticDiagnostics.revise++;
        else criticDiagnostics.unavailable++;
      }
    }
  }
  return {
    plannedTrials: options.plannedTrials, recordedTrials: records.length, completedTrials, incompleteTrials, errorTrials, missingTrials,
    reviewedTrials, pendingTrials, acceptance: failed ? 'failed' : pendingTrials ? 'pending' : 'passed', trials, reviews,
    violationsByPolicy, violationsByScenario, scenariosPassingEveryRepetition, modes,
    initialViolationsCorrected, initialViolationsRemaining, initialViolationsCorrectionPending, revisedViolations,
    apiRequestAttempts, transportRetries, criticRequestAttempts, criticDiagnostics,
  };
}
