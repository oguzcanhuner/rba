const { randomUUID } = require('node:crypto');

class WorkflowStore {
  constructor(database) {
    this.database = database;
    this.migrate();
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workflow_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        bundled_source TEXT NOT NULL,
        branch TEXT,
        worktree TEXT,
        base_revision TEXT,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS workflow_runs_by_task
        ON workflow_runs(task_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        operation_key TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, operation_key)
      );

      CREATE INDEX IF NOT EXISTS workflow_operations_by_run
        ON workflow_operations(run_id, started_at);

      CREATE TABLE IF NOT EXISTS workflow_agent_sessions (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        external_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, name)
      );

      CREATE TABLE IF NOT EXISTS workflow_operation_messages (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES workflow_operations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        parts_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS workflow_messages_by_operation
        ON workflow_operation_messages(operation_id, position);
    `);

    const columns = new Set(
      this.database
        .prepare('PRAGMA table_info(workflow_runs)')
        .all()
        .map(({ name }) => name),
    );
    for (const [name, type] of [
      ['branch', 'TEXT'],
      ['worktree', 'TEXT'],
      ['base_revision', 'TEXT'],
    ]) {
      if (!columns.has(name)) {
        this.database.exec(
          `ALTER TABLE workflow_runs ADD COLUMN ${name} ${type}`,
        );
      }
    }
  }

  createRun({
    taskId,
    workflowName,
    sourcePath,
    sourceHash,
    bundledSource,
    input,
    branch = null,
    worktree = null,
    baseRevision = null,
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflow_runs (
          id, task_id, workflow_name, source_path, source_hash,
          bundled_source, branch, worktree, base_revision, status,
          input_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        taskId,
        workflowName,
        sourcePath,
        sourceHash,
        bundledSource,
        branch,
        worktree,
        baseRevision,
        JSON.stringify(input),
        now,
        now,
      );
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.database
      .prepare(`
        SELECT id, task_id AS taskId, workflow_name AS workflowName,
          source_path AS sourcePath, source_hash AS sourceHash,
          bundled_source AS bundledSource, branch, worktree,
          base_revision AS baseRevision, status, input_json AS inputJson,
          output_json AS outputJson, error, started_at AS startedAt,
          updated_at AS updatedAt, finished_at AS finishedAt
        FROM workflow_runs WHERE id = ?
      `)
      .get(id);
    return row ? this.hydrateRun(row) : null;
  }

  getTaskRun(taskId) {
    const row = this.database
      .prepare(`
        SELECT id, task_id AS taskId, workflow_name AS workflowName,
          source_path AS sourcePath, source_hash AS sourceHash,
          bundled_source AS bundledSource, branch, worktree,
          base_revision AS baseRevision, status, input_json AS inputJson,
          output_json AS outputJson, error, started_at AS startedAt,
          updated_at AS updatedAt, finished_at AS finishedAt
        FROM workflow_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1
      `)
      .get(taskId);
    return row ? this.hydrateRun(row) : null;
  }

  hydrateRun(row) {
    const { bundledSource, inputJson, outputJson, ...fields } = row;
    return {
      ...fields,
      input: JSON.parse(inputJson),
      output: outputJson === null ? null : JSON.parse(outputJson),
      operations: this.listOperations(row.id),
      bundledSource,
    };
  }

  publicRun(run) {
    if (!run) return null;
    const { bundledSource, ...visible } = run;
    return visible;
  }

  listOperations(runId) {
    return this.database
      .prepare(`
        SELECT id, run_id AS runId, operation_key AS key,
          operation_type AS type, status, attempt, input_json AS inputJson,
          output_json AS outputJson, error, started_at AS startedAt,
          updated_at AS updatedAt, finished_at AS finishedAt
        FROM workflow_operations WHERE run_id = ? ORDER BY rowid
      `)
      .all(runId)
      .map(({ inputJson, outputJson, ...row }) => ({
        ...row,
        input: JSON.parse(inputJson),
        output: outputJson === null ? null : JSON.parse(outputJson),
        messages: this.listMessages(row.id),
      }));
  }

  getOperation(runId, key) {
    return (
      this.listOperations(runId).find((operation) => operation.key === key) ??
      null
    );
  }

  startOperation(runId, key, type, input, status = 'running') {
    const existing = this.getOperation(runId, key);
    if (existing) {
      if (
        existing.type !== type ||
        JSON.stringify(existing.input) !== JSON.stringify(input)
      ) {
        throw new Error(`Workflow operation \`${key}\` changed during replay.`);
      }
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflow_operations (
          id, run_id, operation_key, operation_type, status,
          input_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, runId, key, type, status, JSON.stringify(input), now, now);
    this.touchRun(runId, status === 'waiting' ? 'waiting' : 'running');
    return this.getOperation(runId, key);
  }

  completeOperation(runId, key, output) {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE workflow_operations SET status = 'completed', output_json = ?,
          error = NULL, updated_at = ?, finished_at = ?
        WHERE run_id = ? AND operation_key = ?
      `)
      .run(JSON.stringify(output), now, now, runId, key);
    if (result.changes === 0)
      throw new Error('The workflow operation no longer exists.');
    this.touchRun(runId, 'running');
    return this.getOperation(runId, key);
  }

  failOperation(runId, key, error) {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE workflow_operations SET status = 'failed', error = ?,
          updated_at = ?, finished_at = ? WHERE run_id = ? AND operation_key = ?
      `)
      .run(String(error), now, now, runId, key);
  }

  saveMessage(operationId, message, position = 0) {
    this.database
      .prepare(`
        INSERT INTO workflow_operation_messages (
          id, operation_id, position, role, status, parts_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET position = excluded.position,
          role = excluded.role, status = excluded.status,
          parts_json = excluded.parts_json
      `)
      .run(
        message.id,
        operationId,
        position,
        message.role,
        message.status,
        JSON.stringify(message.parts),
      );
  }

  listMessages(operationId) {
    return this.database
      .prepare(`
        SELECT id, role, status, parts_json AS partsJson
        FROM workflow_operation_messages WHERE operation_id = ? ORDER BY position
      `)
      .all(operationId)
      .map(({ partsJson, ...message }) => ({
        ...message,
        parts: JSON.parse(partsJson),
      }));
  }

  getAgentSession(runId, name) {
    return (
      this.database
        .prepare(
          'SELECT external_id AS externalId FROM workflow_agent_sessions WHERE run_id = ? AND name = ?',
        )
        .get(runId, name)?.externalId ?? null
    );
  }

  saveAgentSession(runId, name, externalId) {
    this.database
      .prepare(`
        INSERT INTO workflow_agent_sessions (run_id, name, external_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, name) DO UPDATE SET
          external_id = excluded.external_id, updated_at = excluded.updated_at
      `)
      .run(runId, name, externalId, new Date().toISOString());
  }

  finishRun(id, status, { output = null, error = null } = {}) {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE workflow_runs SET status = ?, output_json = ?, error = ?,
          updated_at = ?, finished_at = ? WHERE id = ?
      `)
      .run(
        status,
        output === null ? null : JSON.stringify(output),
        error,
        now,
        now,
        id,
      );
    return this.getRun(id);
  }

  setWorkspace(id, { branch, worktree, baseRevision, input }) {
    this.database
      .prepare(`
        UPDATE workflow_runs SET branch = ?, worktree = ?, base_revision = ?,
          input_json = ?, updated_at = ? WHERE id = ?
      `)
      .run(
        branch,
        worktree,
        baseRevision,
        JSON.stringify(input),
        new Date().toISOString(),
        id,
      );
    return this.getRun(id);
  }

  touchRun(id, status) {
    this.database
      .prepare(
        'UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, new Date().toISOString(), id);
  }

  updateTaskStatus(taskId, status) {
    this.database
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), taskId);
  }

  recoverInterruptedRuns() {
    const now = new Date().toISOString();
    const error = 'RBA stopped while this workflow operation was running.';
    const interruptedRunIds = this.database
      .prepare(
        "SELECT DISTINCT run_id AS runId FROM workflow_operations WHERE status = 'running'",
      )
      .all()
      .map(({ runId }) => runId);
    this.database
      .prepare(`
        UPDATE workflow_operations SET status = 'failed', error = ?,
          updated_at = ?, finished_at = ? WHERE status = 'running'
      `)
      .run(error, now, now);
    const failRun = this.database.prepare(`
      UPDATE workflow_runs SET status = 'failed', error = ?, updated_at = ?,
        finished_at = ? WHERE id = ?
    `);
    for (const runId of interruptedRunIds) {
      failRun.run(error, now, now, runId);
      const run = this.getRun(runId);
      if (run) this.updateTaskStatus(run.taskId, 'failed');
    }
    return this.listRunnableRuns();
  }

  listRunnableRuns() {
    return this.database
      .prepare(
        "SELECT id FROM workflow_runs WHERE status = 'running' ORDER BY started_at",
      )
      .all()
      .map(({ id }) => this.getRun(id));
  }
}

module.exports = { WorkflowStore };
