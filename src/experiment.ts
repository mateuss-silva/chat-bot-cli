import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { buildContext, History, loadAssets, sha256 } from './context.js';
import { loadScenarios } from './scenarios.js';
import { ApiRequester } from './transport.js';
import { executeTurn } from './service.js';
import { checkAnswer } from './evaluation.js';
import { writeReport } from './report.js';
import type { CriticMode, Manifest, TrialRecord } from './types.js';

export interface ExperimentOptions { runs: number; modes: CriticMode[]; caseId?: string; out: string; dryRun: boolean }
export function parseOptions(args: string[]): ExperimentOptions {
  const result: ExperimentOptions = { runs: 3, modes: ['off'], out: 'outputs', dryRun: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(`Argumento duplicado: ${flag}.`);
    seen.add(flag);
    if (flag === '--dry-run') { result.dryRun = true; continue; }
    if (!['--runs', '--critic', '--case', '--out'].includes(flag)) throw new Error(`Argumento inválido: ${flag}.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Falta o valor de ${flag}.`);
    if (flag === '--runs') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error('--runs deve ser um inteiro positivo.');
      result.runs = Number(value);
    } else if (flag === '--critic') {
      if (!['off', 'on', 'both'].includes(value)) throw new Error('--critic aceita off, on ou both.');
      result.modes = value === 'both' ? ['off', 'on'] : [value as CriticMode];
    } else if (flag === '--case') result.caseId = value;
    else result.out = value;
  }
  return result;
}

export async function experimentMain(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  const config = loadConfig(options.dryRun);
  const assets = await loadAssets();
  const suitePath = resolve('scenarios/scenarios.json');
  const suite = await loadScenarios(suitePath, assets.policies.policies.map(p => p.id));
  const scenarios = options.caseId ? suite.scenarios.filter(s => s.id === options.caseId) : suite.scenarios;
  if (!scenarios.length) throw new Error('ID de cenário não encontrado.');
  const plannedTrials = scenarios.length * options.runs * options.modes.length;
  if (!Number.isSafeInteger(plannedTrials)) throw new Error('Quantidade de trials inválida.');
  const generationRequests = scenarios.reduce((n, s) => n + s.messages.length, 0) * options.runs * options.modes.length;
  const reviewsPlanned = options.modes.includes('on') ? scenarios.reduce((n, s) => n + s.messages.length, 0) * options.runs : 0;
  console.log(`${options.dryRun ? 'DRY RUN — sem evidência de modelo' : 'Experimento real'}: ${plannedTrials} trials planejados; ${generationRequests} gerações, até ${reviewsPlanned} revisões antes de retries. Revisão e retries aumentam uso e latência da API.`);
  const experimentId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(options.out, experimentId);
  await mkdir(join(directory, 'trials'), { recursive: true });
  await mkdir(join(directory, 'assets'));
  const suiteText = await readFile(suitePath, 'utf8');
  if (JSON.stringify(JSON.parse(suiteText)) !== JSON.stringify(suite)) throw new Error('Suite alterada durante a leitura. Execute novamente.');
  const manifest: Manifest = {
    experimentId, plannedTrials, requestedModel: config.model, criticModes: options.modes, runs: options.runs,
    selectedScenarioIds: scenarios.map(s => s.id),
    assets: { ...assets.fingerprints, scenarios: { version: suite.version, sha256: sha256(suiteText) },
      criticWorkflow: { version: '1.0.0', sha256: sha256(executeTurn.toString()) } },
    settings: { generation: { model: config.model, max_output_tokens: config.maxOutputTokens, stream: true,
      store: false, truncation: 'disabled (API default)', temperature: 'model default; not supplied', top_p: 'model default; not supplied' },
      critic: { sameGenerationSettings: true, textFormat: 'strict json_schema: policy_review v1' },
      minimumRequestIntervalMs: config.minIntervalMs, requestTimeoutMs: config.timeoutMs, sdkRetries: 0, applicationMaxRetries: 3,
      operationDeadlineMs: config.timeoutMs * 4 + 30000, nodeVersion: process.version },
    startedAt: new Date().toISOString(), finishedAt: 'unavailable', dryRun: options.dryRun
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(directory, 'scenarios.json'), JSON.stringify(scenarios, null, 2));
  for (const [target, content] of [ ['system-prompt.txt', assets.prompt], ['policies.json', assets.sourceTexts.policies],
    ['company-facts.json', assets.sourceTexts.facts], ['scenario-suite.json', suiteText],
    ['context-builder.js.txt', buildContext.toString()], ['critic-workflow.js.txt', executeTurn.toString()] ] as const) {
    await writeFile(join(directory, 'assets', target), content);
  }
  if (options.dryRun) {
    manifest.finishedAt = new Date().toISOString();
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(directory, 'dry-run.md'), `# DRY RUN\n\nConfiguração e ${scenarios.length} cenários validados. ${plannedTrials} trials apenas planejados. Zero chamadas de API, zero outputs de modelo, zero evidência de conformidade. Autenticação e disponibilidade do modelo não foram verificadas.\n`);
    console.log(`DRY RUN concluído: ${directory}`);
    return;
  }
  const requester = new ApiRequester(config);
  const records: TrialRecord[] = [];
  const controller = new AbortController();
  const cancel = () => { console.log('\nCancelando; resultados já obtidos serão preservados.'); controller.abort(); };
  process.once('SIGINT', cancel);
  try {
    outer: for (const scenario of scenarios) {
      for (let repetition = 1; repetition <= options.runs; repetition++) {
        for (const mode of options.modes) {
          if (controller.signal.aborted) break outer;
          const trialId = `${scenario.id}-r${repetition}-${mode}`;
          console.log(`[${records.length + 1}/${plannedTrials}] ${trialId}`);
          const record: TrialRecord = { experimentId, trialId, scenarioId: scenario.id, repetition, criticMode: mode,
            status: 'complete', turns: [], startedAt: new Date().toISOString(), finishedAt: 'unavailable' };
          const history = new History();
          for (let t = 0; t < scenario.messages.length; t++) {
            const turn = await executeTurn(requester, assets, history, scenario.messages[t]!, scenario.userData ?? {},
              mode === 'on', `${trialId}-t${t + 1}`, controller.signal);
            record.turns.push(turn);
            if (turn.status !== 'complete') { record.status = turn.status; break; }
          }
          record.finishedAt = new Date().toISOString();
          records.push(record);
          // Each immutable JSONL record contains one trial, including both answer stages.
          const evidence = { ...record, requestedModel: config.model, assets: manifest.assets, settings: manifest.settings,
            apiRequestAttempts: record.turns.reduce((n, t) => n + t.initial.attempts.length + (t.critic?.result.attempts.length ?? 0), 0),
            transportRetries: record.turns.reduce((n, t) => n + Math.max(0, t.initial.attempts.length - 1) + Math.max(0, (t.critic?.result.attempts.length ?? 1) - 1), 0),
            automatedChecks: record.turns.map(t => ({ turnId: t.turnId, initial: checkAnswer(t.initial.output, scenario.deterministicChecks),
              revised: t.revisedOutput === 'unavailable' ? 'unavailable' : checkAnswer(t.revisedOutput, scenario.deterministicChecks) })),
            humanVerdicts: 'pending', costs: 'unavailable' };
          await appendFile(join(directory, 'trials', `${trialId}.jsonl`), JSON.stringify(evidence) + '\n');
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    manifest.finishedAt = new Date().toISOString();
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const summary = await writeReport(directory, manifest, records, scenarios);
    console.log(`Resultados: ${directory}\nTrials completos: ${summary.completedTrials}/${plannedTrials}. Revisão humana pendente: ${summary.pendingTrials}. Aceitação: ${summary.acceptance}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  experimentMain().catch(error => {
    // Local validation messages only, never provider messages.
    console.error(error instanceof Error && /^(Argumento|Falta|--|ID de|Quantidade|Configure|Configuração|Arquivo|Políticas|Fixture|Suite|Cenário|Rubrica|Check)/.test(error.message)
      ? error.message : 'Experimento interrompido por um erro local. Consulte os arquivos preservados.');
    process.exitCode = 1;
  });
}
