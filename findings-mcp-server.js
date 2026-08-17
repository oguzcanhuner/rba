const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const MAX_FINDINGS_LENGTH = 500_000;
const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_SPEC_LENGTH = 500_000;
const TASK_STATUSES = new Set(['draft', 'queued']);

class FindingsRepository {
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
      SELECT findings_markdown AS findingsMarkdown
      FROM goals
      WHERE id = ?
    `);
    this.updateStatement = this.database.prepare(`
      UPDATE goals
      SET findings_markdown = ?, updated_at = ?
      WHERE id = ?
    `);
  }

  read() {
    return this.readStatement.get(this.goalId)?.findingsMarkdown ?? null;
  }

  update(markdown) {
    if (typeof markdown !== 'string' || markdown.length > MAX_FINDINGS_LENGTH) {
      throw new Error('The findings Markdown is invalid.');
    }

    return (
      this.updateStatement.run(markdown, new Date().toISOString(), this.goalId)
        .changes > 0
    );
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
  const repository = new FindingsRepository(databasePath, goalId);
  const tasks = new TasksRepository(databasePath, goalId);
  const server = new McpServer({ name: 'rba-findings', version: '1.0.0' });

  server.registerTool(
    'read_findings',
    {
      title: 'Read findings',
      description:
        "Read the active goal's current findings Markdown before revising it.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: repository.read() ?? '(the findings document is empty)',
        },
      ],
    }),
  );

  server.registerTool(
    'read_tasks',
    {
      title: 'Read tasks',
      description:
        "Read the active goal's current task drafts and queued tasks before revising them.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const currentTasks = tasks.list();
      return {
        content: [
          {
            type: 'text',
            text:
              currentTasks.length === 0
                ? '(there are no tasks yet)'
                : JSON.stringify(currentTasks, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'add_task',
    {
      title: 'Add task',
      description:
        'Add a durable draft task to the active goal. The draft appears immediately for user review.',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(MAX_TASK_TITLE_LENGTH)
          .describe('A concise task title'),
        specMarkdown: z
          .string()
          .max(MAX_TASK_SPEC_LENGTH)
          .describe('The complete task specification in Markdown'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ title, specMarkdown }) => {
      const task = tasks.add({ title, specMarkdown });
      if (!task) {
        return {
          content: [{ type: 'text', text: 'The goal no longer exists.' }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Drafted task #${task.sequence} (${task.id}): ${task.title}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Revise the title or complete Markdown spec of an existing draft or queued task. Read tasks first.',
      inputSchema: {
        id: z.string().min(1).max(100).describe('The stable task ID'),
        title: z
          .string()
          .min(1)
          .max(MAX_TASK_TITLE_LENGTH)
          .optional()
          .describe('A replacement task title'),
        specMarkdown: z
          .string()
          .max(MAX_TASK_SPEC_LENGTH)
          .optional()
          .describe('The complete replacement task specification in Markdown'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id, title, specMarkdown }) => {
      const task = tasks.update(id, { title, specMarkdown });
      return task
        ? {
            content: [
              { type: 'text', text: `Updated task #${task.sequence}.` },
            ],
          }
        : {
            content: [{ type: 'text', text: 'The task no longer exists.' }],
            isError: true,
          };
    },
  );

  server.registerTool(
    'remove_task',
    {
      title: 'Remove task',
      description:
        'Remove a draft or queued task from the active goal. Read tasks first.',
      inputSchema: {
        id: z.string().min(1).max(100).describe('The stable task ID'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) =>
      tasks.remove(id)
        ? { content: [{ type: 'text', text: 'Task removed.' }] }
        : {
            content: [{ type: 'text', text: 'The task no longer exists.' }],
            isError: true,
          },
  );

  server.registerTool(
    'commit_tasks',
    {
      title: 'Commit tasks',
      description:
        "Promote all of the active goal's draft tasks to queued after the user confirms the breakdown.",
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async () => {
      const count = tasks.commit();
      return {
        content: [{ type: 'text', text: `Queued ${count} task(s).` }],
      };
    },
  );

  server.registerTool(
    'update_findings',
    {
      title: 'Update findings',
      description:
        "Replace the active goal's findings with the complete revised Markdown document.",
      inputSchema: {
        markdown: z
          .string()
          .max(MAX_FINDINGS_LENGTH)
          .describe('The full findings document in Markdown'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ markdown }) => {
      if (!repository.update(markdown)) {
        return {
          content: [{ type: 'text', text: 'The goal no longer exists.' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: 'Findings updated.' }],
      };
    },
  );

  const shutdown = async () => {
    await server.close();
    repository.close();
    tasks.close();
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
  FindingsRepository,
  TasksRepository,
  MAX_FINDINGS_LENGTH,
  MAX_TASK_SPEC_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  startServer,
};
