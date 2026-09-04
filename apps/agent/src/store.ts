import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export class AgentStore {
  readonly database: DatabaseSync;

  constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path.join(stateDirectory, "agent.sqlite"));
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        job_id TEXT PRIMARY KEY,
        thread_id TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  threadFor(conversationId: string): string | undefined {
    const row = this.database.prepare(
      "SELECT thread_id FROM sessions WHERE conversation_id = ?"
    ).get(conversationId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  saveThread(conversationId: string, threadId: string): void {
    this.database.prepare(`
      INSERT INTO sessions(conversation_id, thread_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        updated_at = excluded.updated_at
    `).run(conversationId, threadId, new Date().toISOString());
  }

  save(jobId: string, status: string, threadId?: string, resultJson?: string): void {
    this.database.prepare(`
      INSERT INTO runs(job_id, thread_id, status, result_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        thread_id = COALESCE(excluded.thread_id, runs.thread_id),
        status = excluded.status,
        result_json = COALESCE(excluded.result_json, runs.result_json),
        updated_at = excluded.updated_at
    `).run(jobId, threadId ?? null, status, resultJson ?? null, new Date().toISOString());
  }

  close(): void {
    this.database.close();
  }
}
