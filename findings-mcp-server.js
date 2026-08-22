const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { runTestTrace } = require('./test-trace-service');

const MAX_AUDIT_LENGTH = 500_000;
const MAX_AUDIT_ARTIFACTS = 200;
const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_SPEC_LENGTH = 500_000;
const TASK_STATUSES = new Set(['draft', 'queued']);

class AuditRepository {
  constructor(filename, goalId) {
    if (!path.isAbsolute(filename)) {
      throw new Error('The goal database path must be absolute.');
    }
    if (
      typeof goalId !== 'string' ||
      goalId.length === 0 ||
      goalId.length > 100
    ) {
      throw new Error('The goal ID is invalid.');
    }

    this.goalId = goalId;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.workingDirectory = this.database
      .prepare(
        'SELECT working_directory AS workingDirectory FROM goals WHERE id = ?',
      )
      .get(this.goalId)?.workingDirectory;
    this.readStatement = this.database.prepare(`
      SELECT audit_artifacts_json AS auditArtifactsJson
      FROM goals
      WHERE id = ?
    `);
    this.updateStatement = this.database.prepare(`
      UPDATE goals
      SET audit_artifacts_json = ?, updated_at = ?
      WHERE id = ?
    `);
  }

  read() {
    const json = this.readStatement.get(this.goalId)?.auditArtifactsJson;
    const artifacts = json ? JSON.parse(json) : [];
    return artifacts.flatMap((artifact) => {
      if (!artifact || typeof artifact.id !== 'string') {
        return [];
      }
      if (artifact.kind === 'test-trace') {
        return [artifact];
      }
      return artifact.kind === 'vitest-trace'
        ? [{ ...artifact, kind: 'test-trace', framework: 'vitest' }]
        : [];
    });
  }

  remove(id) {
    const artifacts = this.read();
    const next = artifacts.filter((artifact) => artifact.id !== id);
    if (next.length === artifacts.length) {
      return false;
    }
    this.write(next);
    return true;
  }

  upsertTestTrace(trace) {
    const artifacts = this.read();
    const index = artifacts.findIndex(
      (artifact) =>
        artifact.kind === 'test-trace' &&
        artifact.framework === trace.framework &&
        artifact.testPath === trace.testPath &&
        artifact.testName === trace.testName,
    );
    const artifact = {
      id: index === -1 ? randomUUID() : artifacts[index].id,
      kind: 'test-trace',
      ...trace,
    };
    if (index === -1) {
      artifacts.push(artifact);
    } else {
      artifacts[index] = artifact;
    }
    this.write(artifacts);
    return artifact;
  }

  readForAgent() {
    return this.read().map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      framework: artifact.framework,
      testPath: artifact.testPath,
      testName: artifact.testName,
      createdAt: artifact.createdAt,
      success: artifact.success,
      assertionCount: artifact.assertions.length,
    }));
  }

  write(artifacts) {
    const json = JSON.stringify(artifacts);
    if (
      !Array.isArray(artifacts) ||
      artifacts.length > MAX_AUDIT_ARTIFACTS ||
      json.length > MAX_AUDIT_LENGTH
    ) {
      throw new Error('The audit artifacts are invalid.');
    }

    if (
      this.updateStatement.run(json, new Date().toISOString(), this.goalId)
        .changes === 0
    ) {
      throw new Error('The goal no longer exists.');
    }
  }

  close() {
    this.database.close();
  }
}

class PlanRepository {
  constructor(filename, goalId) {
    if (!path.isAbsolute(filename)) {
      throw new Error('The goal database path must be absolute.');
    }
    if (
      typeof goalId !== 'string' ||
      goalId.length === 0 ||
      goalId.length > 100
    ) {
      throw new Error('The goal ID is invalid.');
    }

    this.goalId = goalId;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.readStatement = this.database.prepare(`
      SELECT plan_markdown AS planMarkdown
      FROM goals
      WHERE id = ?
    `);
  }

  read() {
    return this.readStatement.get(this.goalId)?.planMarkdown ?? null;
  }

  close() {
    this.database.close();
  }
}

class TasksRepository {
  constructor(filename, goalId) {
    if (!path.isAbsolute(filename)) {
      throw new Error('The goal database path must be absolute.');
    }
    if (
      typeof goalId !== 'string' ||
      goalId.length === 0 ||
      goalId.length > 100
    ) {
      throw new Error('The goal ID is invalid.');
    }

    this.goalId = goalId;
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  list() {
    return this.database
      .prepare(`
        SELECT
          id,
          sequence,
          title,
          spec_markdown AS specMarkdown,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM tasks
        WHERE goal_id = ?
        ORDER BY sequence
      `)
      .all(this.goalId)
      .map((row) => ({ ...row }));
  }

  add({ title, specMarkdown }) {
    this.validateTitle(title);
    this.validateSpec(specMarkdown);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!this.goalExists()) {
        this.database.exec('ROLLBACK');
        return null;
      }

      const { sequence } = this.database
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM tasks
          WHERE goal_id = ?
        `)
        .get(this.goalId);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(`
          INSERT INTO tasks (
            id, goal_id, sequence, title, spec_markdown, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
        `)
        .run(id, this.goalId, sequence, title, specMarkdown, now, now);
      this.touchGoal(now);
      this.database.exec('COMMIT');
      return this.get(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  update(id, fields) {
    this.validateId(id);
    if (fields.title === undefined && fields.specMarkdown === undefined) {
      throw new Error('A task update must change the title or spec.');
    }
    if (fields.title !== undefined) {
      this.validateTitle(fields.title);
    }
    if (fields.specMarkdown !== undefined) {
      this.validateSpec(fields.specMarkdown);
    }

    const task = this.get(id);
    if (!task || !TASK_STATUSES.has(task.status)) {
      return null;
    }

    const now = new Date().toISOString();
    const title = fields.title ?? task.title;
    const specMarkdown = fields.specMarkdown ?? task.specMarkdown;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(`
          UPDATE tasks
          SET title = ?, spec_markdown = ?, updated_at = ?
          WHERE id = ? AND goal_id = ?
        `)
        .run(title, specMarkdown, now, id, this.goalId);
      this.touchGoal(now);
      this.database.exec('COMMIT');
      return this.get(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  remove(id) {
    this.validateId(id);
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(`
          DELETE FROM tasks
          WHERE id = ? AND goal_id = ? AND status IN ('draft', 'queued')
        `)
        .run(id, this.goalId);
      if (result.changes > 0) {
        this.touchGoal(now);
      }
      this.database.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  commit() {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(`
          UPDATE tasks
          SET status = 'queued', updated_at = ?
          WHERE goal_id = ? AND status = 'draft'
        `)
        .run(now, this.goalId);
      if (result.changes > 0) {
        this.touchGoal(now);
      }
      this.database.exec('COMMIT');
      return result.changes;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(id) {
    this.validateId(id);
    const row = this.database
      .prepare(`
        SELECT
          id,
          sequence,
          title,
          spec_markdown AS specMarkdown,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM tasks
        WHERE id = ? AND goal_id = ?
      `)
      .get(id, this.goalId);
    return row ? { ...row } : null;
  }

  goalExists() {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM goals WHERE id = ?')
        .get(this.goalId),
    );
  }

  touchGoal(now) {
    this.database
      .prepare('UPDATE goals SET updated_at = ? WHERE id = ?')
      .run(now, this.goalId);
  }

  validateId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
      throw new Error('The task ID is invalid.');
    }
  }

  validateTitle(title) {
    if (
      typeof title !== 'string' ||
      title.trim().length === 0 ||
      title.length > MAX_TASK_TITLE_LENGTH
    ) {
      throw new Error('The task title is invalid.');
    }
  }

  validateSpec(specMarkdown) {
    if (
      typeof specMarkdown !== 'string' ||
      specMarkdown.length > MAX_TASK_SPEC_LENGTH
    ) {
      throw new Error('The task spec is invalid.');
    }
  }

  close() {
    this.database.close();
  }
}

async function startServer({ databasePath, goalId }) {
  const repository = new AuditRepository(databasePath, goalId);
  const plan = new PlanRepository(databasePath, goalId);
  const server = new McpServer({ name: 'rba-findings', version: '1.0.0' });

  server.registerTool(
    'read_artifacts',
    {
      title: 'Read audit artifacts',
      description: "Read the generated test traces in the active goal's audit.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(repository.readForAgent(), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'read_plan',
    {
      title: 'Read plan',
      description:
        "Read the user's current plan. This document is user-owned and read-only.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: plan.read() ?? '(the user has not written a plan yet)',
        },
      ],
    }),
  );

  server.registerTool(
    'add_test_trace',
    {
      title: 'Run and add test trace',
      description:
        'Detect the test framework, run one test file or named test, and add its structured execution result to the audit.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (filePath) =>
              !path.isAbsolute(filePath) &&
              !filePath.split(/[\\/]/).includes('..'),
            'The path must stay within the workspace.',
          ),
        testName: z.string().min(1).max(500).optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ path: testPath, testName }) => {
      const trace = await runTestTrace({
        workingDirectory: repository.workingDirectory,
        testPath,
        testName,
      });
      const artifact = repository.upsertTestTrace(trace);
      return {
        content: [
          {
            type: 'text',
            text: `Added ${artifact.framework} test trace ${artifact.id} (${artifact.assertions.length} test(s)).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'remove_artifact',
    {
      title: 'Remove audit artifact',
      description:
        'Remove an artifact that is no longer relevant. Read artifacts first.',
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) =>
      repository.remove(id)
        ? { content: [{ type: 'text', text: `Removed artifact ${id}.` }] }
        : {
            content: [{ type: 'text', text: 'The artifact no longer exists.' }],
            isError: true,
          },
  );

  const shutdown = async () => {
    await server.close();
    repository.close();
    plan.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  startServer({
    databasePath: process.env.RBA_GOAL_DATABASE,
    goalId: process.env.RBA_GOAL_ID,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  AuditRepository,
  PlanRepository,
  TasksRepository,
  MAX_AUDIT_LENGTH,
  MAX_AUDIT_ARTIFACTS,
  MAX_TASK_SPEC_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  startServer,
};
