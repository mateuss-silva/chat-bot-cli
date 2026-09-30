import { readFile } from 'node:fs/promises';
import { object, strings } from './config.js';
import type { ScenarioSuite } from './types.js';

export async function loadScenarios(path: string, policyIds: string[]): Promise<ScenarioSuite> {
  const suite: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!object(suite) || typeof suite.version !== 'string' || suite.synthetic !== true || !Array.isArray(suite.scenarios) || !suite.scenarios.length) {
    throw new Error('Suite inválida: use versão, synthetic=true e cenários.');
  }
  const ids = new Set<string>();
  for (const s of suite.scenarios) {
    if (!object(s) || typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id) || ids.has(s.id) ||
        typeof s.title !== 'string' || !s.title.trim() || typeof s.riskCategory !== 'string' || !s.riskCategory.trim() ||
        !strings(s.messages) || !s.messages.length || !strings(s.policyIds) || !s.policyIds.length || !s.policyIds.every(id => policyIds.includes(id)) ||
        !strings(s.expectedBehavior) || !s.expectedBehavior.length || !strings(s.prohibitedBehavior) || !s.prohibitedBehavior.length ||
        typeof s.escalationRequired !== 'boolean' || (s.userData !== undefined && !object(s.userData)) ||
        !Array.isArray(s.rubric) || !s.rubric.length || !Array.isArray(s.deterministicChecks)) throw new Error('Cenário inválido.');
    ids.add(s.id);
    const criterionIds = new Set<string>();
    for (const c of s.rubric) {
      if (!object(c) || typeof c.id !== 'string' || !c.id.trim() || criterionIds.has(c.id) || typeof c.description !== 'string' || !c.description.trim() ||
          !strings(c.policyIds) || !c.policyIds.length || !c.policyIds.every(id => policyIds.includes(id))) throw new Error(`Rubrica inválida: ${s.id}.`);
      criterionIds.add(c.id);
    }
    const checkIds = new Set<string>();
    for (const c of s.deterministicChecks) {
      if (!object(c) || typeof c.id !== 'string' || !c.id.trim() || checkIds.has(c.id) ||
          !['nonempty', 'must-not-contain'].includes(String(c.kind)) ||
          (c.kind === 'must-not-contain' && (!strings(c.values) || !c.values.length))) throw new Error(`Check inválido: ${s.id}.`);
      checkIds.add(c.id);
    }
  }
  return suite as unknown as ScenarioSuite;
}
