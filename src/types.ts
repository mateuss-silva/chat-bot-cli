export type ExecutionStatus = 'complete' | 'incomplete' | 'error';
export type CriticMode = 'off' | 'on';
export interface PolicyFile {
  version: string;
  precedence: string[];
  policies: { id: string; title: string; rules: string[] }[];
  escalation: { triggers: string[]; approvedGuidance: string[] };
}
export interface CompanyFacts { version: string; fictional: true; companyName: string; facts: Record<string, unknown> }
export interface Assets {
  prompt: string;
  policies: PolicyFile;
  facts: CompanyFacts;
  sourceTexts: { policies: string; facts: string };
  fingerprints: Record<string, { version: string; sha256: string }>;
}
export interface Turn { id?: string; user: string; assistant: string }
export interface MemoryTurn extends Turn { id: string; sessionId: string; createdAt: string }
export interface Message { role: 'system' | 'developer' | 'user' | 'assistant'; content: string }
export interface Config {
  apiKey: string; model: string; minIntervalMs: number; timeoutMs: number; maxOutputTokens: number;
  databasePath: string; historyLimit: number; memoryLimit: number; memoryMaxChars: number;
}
export interface Attempt {
  number: number;
  startedAt: string;
  latencyMs: number;
  status: ExecutionStatus;
  error: string | 'unavailable';
  httpStatus: number | 'unavailable';
  retryDelayMs: number;
}
export interface GenerationResult {
  status: ExecutionStatus;
  output: string;
  error: string | 'unavailable';
  attempts: Attempt[];
  model: string | 'unavailable';
  usage: unknown;
  latencyMs: number;
}
export interface CriticVerdict {
  verdict: 'pass' | 'revise';
  violatedPolicyIds: string[];
  explanation: string;
  correctedAnswer: string | null;
}
export interface TurnRecord {
  turnId: string;
  userMessage: string;
  userData: Record<string, unknown>;
  initial: GenerationResult;
  critic?: { result: GenerationResult; verdict?: CriticVerdict; error?: string };
  revisedOutput: string | 'unavailable';
  finalAnswer: string | 'unavailable';
  status: ExecutionStatus;
  persistenceError?: string;
}
export interface DeterministicCheck { id: string; kind: 'nonempty' | 'must-not-contain'; values?: string[] }
export interface Scenario {
  id: string; title: string; riskCategory: string;
  userData?: Record<string, unknown>;
  messages: string[]; policyIds: string[];
  expectedBehavior: string[]; prohibitedBehavior: string[];
  escalationRequired: boolean;
  rubric: { id: string; policyIds: string[]; description: string }[];
  deterministicChecks: DeterministicCheck[];
}
export interface ScenarioSuite { version: string; synthetic: true; scenarios: Scenario[] }
export interface TrialRecord {
  experimentId: string; trialId: string; scenarioId: string; repetition: number;
  criticMode: CriticMode; status: ExecutionStatus; turns: TurnRecord[];
  startedAt: string; finishedAt: string;
}
export interface Manifest {
  experimentId: string; plannedTrials: number; requestedModel: string;
  criticModes: CriticMode[]; runs: number; selectedScenarioIds: string[];
  assets: Assets['fingerprints']; settings: Record<string, unknown>;
  startedAt: string; finishedAt: string; dryRun: boolean;
}
