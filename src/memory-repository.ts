import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionStatus, MemoryTurn } from './types.js';

export interface Session {
  id: string; createdAt: string; updatedAt: string; isActive: boolean;
}
export interface SavedTurn {
  id: string; sessionId: string; userMessage: string;
  assistantMessage: string | null; status: ExecutionStatus | 'pending';
}

const stopWords = new Set(('a ao aos as com da das de do dos e em eu isso isto ja me meu meus minha minhas ' +
  'na nas nao no nos o os ou para pela pelo por qual que se sem sobre sua suas seu seus um uma voce ' +
  'como pode poderia quero preciso gostaria favor agora antes tambem').split(' '));

function terms(text: string): Set<string> {
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter(word => word.length >= 3 && !stopWords.has(word)));
}

// Heuristics cover recognizable secrets, not every possible sensitive value.
function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[CHAVE REMOVIDA]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[CHAVE REMOVIDA]')
    .replace(/((?:senha|password|pin|token|c[oó]digo(?:\s+de\s+(?:autentica[cç][aã]o|acesso))?|chave\s+privada)\s*(?::|=|é)\s*)([^\s,;]+)/gi, '$1[DADO REMOVIDO]')
    .replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, '[NÚMERO REMOVIDO]');
}

const turnColumns = 'id, session_id AS sessionId, user_message AS user, assistant_message AS assistant, created_at AS createdAt';

export class MemoryRepository {
  private readonly database: DatabaseSync;

  constructor(path = 'data/chatbot.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON sessions(is_active) WHERE is_active = 1;
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          user_message TEXT NOT NULL,
          assistant_message TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'incomplete', 'error')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (status <> 'complete' OR (assistant_message IS NOT NULL AND length(trim(assistant_message)) > 0))
        );
        CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, status, created_at);
      `);
    } catch (error) { this.database.close(); throw error; }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  getSession(id: string): Session | undefined {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? { id: String(row.id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      isActive: row.is_active === 1 } : undefined;
  }

  getOrCreateActiveSession(): Session {
    const row = this.database.prepare('SELECT id FROM sessions WHERE is_active = 1').get();
    return row ? this.getSession(String(row.id))! : this.createSession();
  }

  createSession(): Session {
    return this.transaction(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database.prepare('UPDATE sessions SET is_active = 0 WHERE is_active = 1').run();
      this.database.prepare('INSERT INTO sessions (id, created_at, updated_at, is_active) VALUES (?, ?, ?, 1)').run(id, now, now);
      return this.getSession(id)!;
    });
  }

  setActiveSession(id: string): Session {
    if (!this.getSession(id)) throw new Error('Sessão não encontrada.');
    return this.transaction(() => {
      this.database.prepare('UPDATE sessions SET is_active = 0 WHERE is_active = 1').run();
      this.database.prepare('UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      return this.getSession(id)!;
    });
  }

  saveTurn(turn: SavedTurn): void {
    const user = redact(turn.userMessage);
    const assistant = turn.status === 'complete' && turn.assistantMessage !== null ? redact(turn.assistantMessage) : null;
    this.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT INTO turns (id, session_id, user_message, assistant_message, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET assistant_message = excluded.assistant_message,
          status = excluded.status, updated_at = excluded.updated_at
        WHERE turns.session_id = excluded.session_id AND turns.user_message = excluded.user_message
      `).run(turn.id, turn.sessionId, user, assistant, turn.status, now, now);
      if (result.changes !== 1) throw new Error('O turno pertence a outra sessão ou mensagem.');
      this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, turn.sessionId);
    });
  }

  getRecentTurns(sessionId: string, limit = 20): MemoryTurn[] {
    if (limit <= 0) return [];
    const rows = this.database.prepare(`SELECT ${turnColumns} FROM turns
      WHERE session_id = ? AND status = 'complete'
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(sessionId, limit);
    return (rows as unknown as MemoryTurn[]).reverse();
  }

  findRelevantTurns(sessionId: string, query: string, excludeIds: readonly string[] = [], limit = 3): MemoryTurn[] {
    const queryTerms = [...terms(query)].slice(0, 32);
    if (limit <= 0 || !queryTerms.length) return [];
    const excluded = new Set(excludeIds);
    const rows = this.database.prepare(`SELECT ${turnColumns} FROM turns
      WHERE session_id = ? AND status = 'complete' ORDER BY created_at DESC, rowid DESC`).all(sessionId);
    const turns = rows as unknown as MemoryTurn[];
    const contentKey = (turn: MemoryTurn) => JSON.stringify([turn.user, turn.assistant]);
    const seen = new Set(turns.filter(turn => excluded.has(turn.id)).map(contentKey));
    return turns
      .filter(turn => !excluded.has(turn.id))
      .map(turn => {
        const userTerms = terms(turn.user);
        const answerTerms = terms(turn.assistant);
        const score = queryTerms.reduce((sum, word) => sum + (userTerms.has(word) ? 2 : 0) + (answerTerms.has(word) ? 1 : 0), 0);
        return { turn, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.turn.createdAt.localeCompare(a.turn.createdAt))
      .filter(({ turn }) => {
        const key = contentKey(turn);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit).map(item => item.turn);
  }

  clearSession(sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error('Sessão não encontrada.');
    this.transaction(() => {
      this.database.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
      this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
    });
  }

  close(): void { if (this.database.isOpen) this.database.close(); }
}
