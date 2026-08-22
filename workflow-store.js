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
    `);
  }

  createRun({
    taskId,
    workflowName,
    sourcePath,
    sourceHash,
    bundledSource,
    input,
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflow_runs (
          id, task_id, workflow_name, source_path, source_hash,
          bundled_source, status, input_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        taskId,
        workflowName,
        sourcePath,
        sourceHash,
        bundledSource,
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
          bundled_source AS bundledSource, status, input_json AS inputJson,
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
          bundled_source AS bundledSource, status, input_json AS inputJson,
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
        FROM workflow_operations WHERE run_id = ? ORDER BY started_at, id
      `)
      .all(runId)
      .map(({ inputJson, outputJson, ...row }) => ({
        ...row,
        input: JSON.parse(inputJson),
        output: outputJson === null ? null : JSON.parse(outputJson),
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

  touchRun(id, status) {
    this.database
      .prepare(
        'UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, new Date().toISOString(), id);
  }

  interruptRunningRuns() {
    const now = new Date().toISOString();
    const error = 'RBA stopped while this workflow operation was running.';
    this.database
      .prepare(
        `UPDATE workflow_operations SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE status = 'running'`,
      )
      .run(error, now, now);
    this.database
      .prepare(
        `UPDATE workflow_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE status = 'running'`,
      )
      .run(error, now, now);
  }
}

module.exports = { WorkflowStore };
