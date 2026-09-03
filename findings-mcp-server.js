const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const {
  validateWorkflowName,
  validateDefinition,
  normaliseDefinition,
} = require('./workflow-spec');
const { GoalStore } = require('./goal-store');

const execFileAsync = promisify(execFile);
const GIT_COMMAND_OPTIONS = { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 };

const MAX_ARTIFACT_TITLE_LENGTH = 200;
const MAX_ARTIFACT_HTML_LENGTH = 1_000_000;
const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_SPEC_LENGTH = 500_000;
const TASK_STATUSES = new Set(['draft', 'queued']);

class ArtifactsRepository {
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
        SELECT id, title, html, created_at AS createdAt, updated_at AS updatedAt
        FROM artifacts
        WHERE goal_id = ?
        ORDER BY created_at, id
      `)
      .all(this.goalId)
      .map((row) => ({ ...row }));
  }

  create({ title, html }) {
    this.validateTitle(title);
    this.validateHtml(html);
    if (!this.goalExists()) {
      return null;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO artifacts (id, goal_id, title, html, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, this.goalId, title, html, now, now);
    this.touchGoal(now);
    return this.get(id);
  }

  update(id, fields) {
    this.validateId(id);
    if (fields.title === undefined && fields.html === undefined) {
      throw new Error('An artifact update must change the title or HTML.');
    }
    if (fields.title !== undefined) this.validateTitle(fields.title);
    if (fields.html !== undefined) this.validateHtml(fields.html);

    const artifact = this.get(id);
    if (!artifact) return null;
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE artifacts SET title = ?, html = ?, updated_at = ?
        WHERE id = ? AND goal_id = ?
      `)
      .run(
        fields.title ?? artifact.title,
        fields.html ?? artifact.html,
        now,
        id,
        this.goalId,
      );
    this.touchGoal(now);
    return this.get(id);
  }

  remove(id) {
    this.validateId(id);
    const result = this.database
      .prepare('DELETE FROM artifacts WHERE id = ? AND goal_id = ?')
      .run(id, this.goalId);
    if (result.changes > 0) this.touchGoal(new Date().toISOString());
    return result.changes > 0;
  }

  get(id) {
    const row = this.database
      .prepare(`
        SELECT id, title, html, created_at AS createdAt, updated_at AS updatedAt
        FROM artifacts WHERE id = ? AND goal_id = ?
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
      throw new Error('The artifact ID is invalid.');
    }
  }

  validateTitle(title) {
    if (
      typeof title !== 'string' ||
      title.trim().length === 0 ||
      title.length > MAX_ARTIFACT_TITLE_LENGTH
    ) {
      throw new Error('The artifact title is invalid.');
    }
  }

  validateHtml(html) {
    if (typeof html !== 'string' || html.length > MAX_ARTIFACT_HTML_LENGTH) {
      throw new Error('The artifact HTML is invalid.');
    }
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

const MAX_WORKFLOW_DEFINITION_LENGTH = 100_000;
const MAX_WORKFLOW_DESCRIPTION_LENGTH = 2000;
const MAX_WORKFLOW_DIRECTORY_LENGTH = 4096;

/** Workflows are global to the user rather than scoped to a goal, so this
 * repository (unlike the ones above) ignores RBA_GOAL_ID entirely. */
class WorkflowsRepository {
  constructor(filename) {
    if (!path.isAbsolute(filename)) {
      throw new Error('The goal database path must be absolute.');
    }
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
          w.id, w.name, w.description, w.directory,
          w.definition_json AS definitionJson,
          w.created_at AS createdAt, w.updated_at AS updatedAt,
          r.status AS latestRunStatus, r.started_at AS latestRunStartedAt
        FROM workflows w
        LEFT JOIN workflow_runs r ON r.id = (
          SELECT id FROM workflow_runs
          WHERE workflow_id = w.id
          ORDER BY started_at DESC
          LIMIT 1
        )
        ORDER BY w.name
      `)
      .all()
      .map(({ definitionJson, ...row }) => {
        const definition = JSON.parse(definitionJson);
        return {
          name: row.name,
          description: row.description,
          directory: row.directory,
          stepCount: Object.keys(definition.steps ?? {}).length,
          latestRunStatus: row.latestRunStatus,
          latestRunStartedAt: row.latestRunStartedAt,
        };
      });
  }

  getByName(name) {
    const row = this.database
      .prepare(`
        SELECT id, name, description, directory,
               definition_json AS definitionJson,
               created_at AS createdAt, updated_at AS updatedAt
        FROM workflows WHERE name = ?
      `)
      .get(name);
    if (!row) return null;
    const { definitionJson, ...rest } = row;
    return { ...rest, definition: JSON.parse(definitionJson) };
  }

  register({ name, description, directory, definition }) {
    this.validateName(name);
    this.validateDescription(description);
    this.validateDirectory(directory);
    const normalisedDefinition = normaliseDefinition(definition);
    this.validateDefinitionSize(normalisedDefinition);
    const validation = validateDefinition(normalisedDefinition);
    if (!validation.ok) {
      const error = new Error(validation.errors.join(' '));
      error.isValidationError = true;
      throw error;
    }

    if (this.getByName(name)) {
      throw new Error(
        `A workflow named \`${name}\` already exists; use update_workflow.`,
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflows (
          id, name, description, directory, definition_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        name,
        description ?? null,
        directory ?? null,
        JSON.stringify(normalisedDefinition),
        now,
        now,
      );
    return {
      ...this.getByName(name),
      stepCount: Object.keys(normalisedDefinition.steps).length,
    };
  }

  update(name, { description, directory, definition }) {
    const workflow = this.getByName(name);
    if (!workflow) {
      return null;
    }

    let normalisedDefinition = workflow.definition;
    if (definition !== undefined) {
      normalisedDefinition = normaliseDefinition(definition);
      this.validateDefinitionSize(normalisedDefinition);
      const validation = validateDefinition(normalisedDefinition);
      if (!validation.ok) {
        const error = new Error(validation.errors.join(' '));
        error.isValidationError = true;
        throw error;
      }
    }
    if (description !== undefined) this.validateDescription(description);
    if (directory !== undefined) this.validateDirectory(directory);

    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE workflows
        SET description = ?, directory = ?, definition_json = ?, updated_at = ?
        WHERE name = ?
      `)
      .run(
        description !== undefined ? description : workflow.description,
        directory !== undefined ? directory : workflow.directory,
        JSON.stringify(normalisedDefinition),
        now,
        name,
      );
    const updated = this.getByName(name);
    return {
      ...updated,
      stepCount: Object.keys(updated.definition.steps).length,
    };
  }

  remove(name) {
    const running = this.database
      .prepare(`
        SELECT 1
        FROM workflow_runs r
        JOIN workflows w ON w.id = r.workflow_id
        WHERE w.name = ? AND r.status = 'running'
        LIMIT 1
      `)
      .get(name);
    if (running) {
      throw new Error('A running workflow cannot be removed.');
    }
    const result = this.database
      .prepare('DELETE FROM workflows WHERE name = ?')
      .run(name);
    return result.changes > 0;
  }

  validateName(name) {
    if (!validateWorkflowName(name)) {
      throw new Error(
        'The workflow name must use only lowercase letters, digits, `-`, or `_` (1-64 characters).',
      );
    }
  }

  validateDescription(description) {
    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== 'string' ||
        description.length > MAX_WORKFLOW_DESCRIPTION_LENGTH)
    ) {
      throw new Error('The workflow description is invalid.');
    }
  }

  validateDirectory(directory) {
    if (
      directory !== undefined &&
      directory !== null &&
      (typeof directory !== 'string' ||
        directory.length === 0 ||
        directory.length > MAX_WORKFLOW_DIRECTORY_LENGTH)
    ) {
      throw new Error('The workflow directory is invalid.');
    }
  }

  validateDefinitionSize(definition) {
    if (JSON.stringify(definition).length > MAX_WORKFLOW_DEFINITION_LENGTH) {
      throw new Error(
        `The workflow definition exceeds ${MAX_WORKFLOW_DEFINITION_LENGTH} bytes.`,
      );
    }
  }

  close() {
    this.database.close();
  }
}

const ATTENTION_REASONS = {
  RUN_FAILED: 'the worker run failed or was stopped',
  MERGED_BUT_NOT_ANCESTOR:
    "the task is marked merged but its branch isn't an ancestor of the base",
  ANCESTOR_BUT_NOT_MERGED:
    "the branch is an ancestor of the base but the task isn't marked merged",
  FINISHED_BUT_STILL_WORKING:
    'the worker run finished but the task is still marked working',
};

class WorkStateReader {
  constructor(filename, goalId, { runCommand = execFileAsync } = {}) {
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
    this.runCommand = runCommand;
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.store = new GoalStore(filename);
  }

  getWorkingDirectory() {
    const row = this.database
      .prepare(
        'SELECT working_directory AS workingDirectory FROM goals WHERE id = ?',
      )
      .get(this.goalId);
    return row ? row.workingDirectory : null;
  }

  async resolveBaseTip(root) {
    try {
      const { stdout } = await this.runCommand(
        'git',
        ['-C', root, 'rev-parse', 'HEAD'],
        GIT_COMMAND_OPTIONS,
      );
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async branchExists(root, branch) {
    try {
      await this.runCommand(
        'git',
        [
          '-C',
          root,
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ],
        GIT_COMMAND_OPTIONS,
      );
      return true;
    } catch {
      return false;
    }
  }

  async resolveGitState(root, branch, baseTip) {
    const git = {
      branchExists: false,
      mergedIntoBase: null,
      commitsAhead: null,
      filesChanged: null,
      error: null,
    };

    const exists = await this.branchExists(root, branch);
    git.branchExists = exists;
    if (!exists) {
      return git;
    }
    if (baseTip === null) {
      git.error = 'Could not resolve the base tip.';
      return git;
    }

    try {
      await this.runCommand(
        'git',
        ['-C', root, 'merge-base', '--is-ancestor', branch, baseTip],
        GIT_COMMAND_OPTIONS,
      );
      git.mergedIntoBase = true;
    } catch (error) {
      if (typeof error?.code === 'number' && error.code === 1) {
        git.mergedIntoBase = false;
      } else {
        git.error = error instanceof Error ? error.message : String(error);
        return git;
      }
    }

    try {
      const { stdout: countOutput } = await this.runCommand(
        'git',
        ['-C', root, 'rev-list', '--count', `${baseTip}..${branch}`],
        GIT_COMMAND_OPTIONS,
      );
      git.commitsAhead = Number.parseInt(countOutput.trim(), 10);

      const { stdout: mergeBaseOutput } = await this.runCommand(
        'git',
        ['-C', root, 'merge-base', branch, baseTip],
        GIT_COMMAND_OPTIONS,
      );
      const mergeBase = mergeBaseOutput.trim();
      const { stdout: diffOutput } = await this.runCommand(
        'git',
        ['-C', root, 'diff', '--name-only', `${mergeBase}..${branch}`],
        GIT_COMMAND_OPTIONS,
      );
      git.filesChanged = diffOutput
        .split('\n')
        .filter((line) => line.length > 0).length;
    } catch (error) {
      git.error = error instanceof Error ? error.message : String(error);
    }

    return git;
  }

  attentionFor(task) {
    if (
      task.run &&
      (task.run.status === 'failed' || task.run.status === 'stopped')
    ) {
      return ATTENTION_REASONS.RUN_FAILED;
    }
    if (task.status === 'merged' && task.git?.mergedIntoBase === false) {
      return ATTENTION_REASONS.MERGED_BUT_NOT_ANCESTOR;
    }
    if (task.status !== 'merged' && task.git?.mergedIntoBase === true) {
      return ATTENTION_REASONS.ANCESTOR_BUT_NOT_MERGED;
    }
    if (task.run && task.run.finishedAt !== null && task.status === 'working') {
      return ATTENTION_REASONS.FINISHED_BUT_STILL_WORKING;
    }
    return null;
  }

  async read() {
    const tasks = this.store.listWorkStateForGoal(this.goalId);
    const root = this.getWorkingDirectory();
    const baseTip = root === null ? null : await this.resolveBaseTip(root);

    const result = [];
    for (const task of tasks) {
      let git = null;
      if (task.run?.branch && root !== null) {
        git = await this.resolveGitState(root, task.run.branch, baseTip);
      }

      const entry = {
        id: task.id,
        sequence: task.sequence,
        title: task.title,
        status: task.status,
        run: task.run,
        git,
        startable: task.status === 'queued' && task.run === null,
      };
      entry.attention = this.attentionFor(entry);
      result.push(entry);
    }
    return result;
  }

  close() {
    this.database.close();
    this.store.close();
  }
}

async function startServer({ databasePath, goalId }) {
  const artifacts = new ArtifactsRepository(databasePath, goalId);
  const tasks = new TasksRepository(databasePath, goalId);
  const workflows = new WorkflowsRepository(databasePath);
  const workState = new WorkStateReader(databasePath, goalId);
  const server = new McpServer({ name: 'rba-planner', version: '1.0.0' });

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description: "List the active goal's saved HTML artifacts.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const current = artifacts.list();
      return {
        content: [
          {
            type: 'text',
            text:
              current.length === 0
                ? '(there are no artifacts)'
                : JSON.stringify(current, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_artifact',
    {
      title: 'Create artifact',
      description: 'Save a new HTML artifact requested by the user.',
      inputSchema: {
        title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH),
        html: z.string().max(MAX_ARTIFACT_HTML_LENGTH),
      },
      annotations: { destructiveHint: false },
    },
    async ({ title, html }) => {
      const artifact = artifacts.create({ title, html });
      return artifact
        ? {
            content: [
              {
                type: 'text',
                text: `Created artifact ${artifact.title} (${artifact.id}).`,
              },
            ],
          }
        : {
            content: [{ type: 'text', text: 'The goal no longer exists.' }],
            isError: true,
          };
    },
  );

  server.registerTool(
    'update_artifact',
    {
      title: 'Update artifact',
      description:
        'Replace the title or HTML of a saved artifact. List artifacts first.',
      inputSchema: {
        id: z.string().min(1).max(100),
        title: z.string().min(1).max(MAX_ARTIFACT_TITLE_LENGTH).optional(),
        html: z.string().max(MAX_ARTIFACT_HTML_LENGTH).optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id, title, html }) => {
      const artifact = artifacts.update(id, { title, html });
      return artifact
        ? {
            content: [
              { type: 'text', text: `Updated artifact ${artifact.title}.` },
            ],
          }
        : {
            content: [{ type: 'text', text: 'The artifact no longer exists.' }],
            isError: true,
          };
    },
  );

  server.registerTool(
    'remove_artifact',
    {
      title: 'Remove artifact',
      description: 'Remove a saved artifact. List artifacts first.',
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) =>
      artifacts.remove(id)
        ? { content: [{ type: 'text', text: 'Artifact removed.' }] }
        : {
            content: [{ type: 'text', text: 'The artifact no longer exists.' }],
            isError: true,
          },
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
    'read_work_state',
    {
      title: 'Read work state',
      description:
        "Read the active goal's tasks with their worker runs and real " +
        'git branch state, to advise on what to work on next.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entries = await workState.read();
      const summary = entries
        .map((entry) => {
          const branch = entry.run?.branch ?? null;
          const flag = entry.attention
            ? ` [attention: ${entry.attention}]`
            : '';
          return `#${entry.sequence} ${entry.title} — status: ${entry.status}${
            branch ? `, branch: ${branch}` : ''
          }${entry.startable ? ', startable' : ''}${flag}`;
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              entries.length === 0
                ? '(there are no tasks yet)'
                : `${summary}\n\n${JSON.stringify(entries, null, 2)}`,
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
    'list_workflows',
    {
      title: 'List workflows',
      description:
        "List the user's registered workflows: named, reusable shell-step sequences they run outside the agent.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const current = workflows.list();
      return {
        content: [
          {
            type: 'text',
            text:
              current.length === 0
                ? '(there are no workflows yet)'
                : JSON.stringify(current, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get workflow',
      description:
        'Read a workflow’s complete definition, so it can be revised rather than blindly overwritten.',
      inputSchema: { name: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const workflow = workflows.getByName(name);
      return workflow
        ? {
            content: [
              { type: 'text', text: JSON.stringify(workflow, null, 2) },
            ],
          }
        : {
            content: [{ type: 'text', text: 'No workflow has that name.' }],
            isError: true,
          };
    },
  );

  server.registerTool(
    'register_workflow',
    {
      title: 'Register workflow',
      description:
        'Register a new global workflow: a `start` step plus a map of named shell steps. Workflows belong to the user, not this repository. Validate first with validate_workflow if unsure.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .describe('lowercase letters, digits, `-`, or `_`'),
        description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).optional(),
        directory: z
          .string()
          .max(MAX_WORKFLOW_DIRECTORY_LENGTH)
          .optional()
          .describe('Optional default working directory for runs'),
        definition: z
          .object({ start: z.string(), steps: z.record(z.string(), z.any()) })
          .describe('{ start, steps: { <name>: Step } }'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ name, description, directory, definition }) => {
      try {
        const workflow = workflows.register({
          name,
          description,
          directory,
          definition,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Registered ${workflow.name} (${workflow.stepCount} steps). Terminal step: ${Object.entries(
                workflow.definition.steps,
              )
                .filter(([, step]) => step.type === 'terminal')
                .map(([stepName]) => stepName)
                .join(', ')}.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'update_workflow',
    {
      title: 'Update workflow',
      description:
        'Partially revise an existing workflow. Read get_workflow first. Changing the definition revalidates it.',
      inputSchema: {
        name: z.string().min(1).max(64),
        description: z.string().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).optional(),
        directory: z.string().max(MAX_WORKFLOW_DIRECTORY_LENGTH).optional(),
        definition: z
          .object({ start: z.string(), steps: z.record(z.string(), z.any()) })
          .optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ name, description, directory, definition }) => {
      try {
        const workflow = workflows.update(name, {
          description,
          directory,
          definition,
        });
        return workflow
          ? {
              content: [
                {
                  type: 'text',
                  text: `Updated ${workflow.name} (${workflow.stepCount} steps).`,
                },
              ],
            }
          : {
              content: [{ type: 'text', text: 'No workflow has that name.' }],
              isError: true,
            };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'remove_workflow',
    {
      title: 'Remove workflow',
      description: 'Remove a registered workflow.',
      inputSchema: { name: z.string().min(1).max(64) },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ name }) => {
      try {
        return workflows.remove(name)
          ? { content: [{ type: 'text', text: 'Workflow removed.' }] }
          : {
              content: [{ type: 'text', text: 'No workflow has that name.' }],
              isError: true,
            };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'validate_workflow',
    {
      title: 'Validate workflow',
      description:
        'Validate a draft workflow definition without storing it, so it can be checked mid-conversation.',
      inputSchema: {
        definition: z.object({
          start: z.string(),
          steps: z.record(z.string(), z.any()),
        }),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ definition }) => {
      const normalised = normaliseDefinition(definition);
      const result = validateDefinition(normalised);
      return result.ok
        ? { content: [{ type: 'text', text: 'The definition is valid.' }] }
        : {
            content: [{ type: 'text', text: result.errors.join('\n') }],
            isError: true,
          };
    },
  );

  const shutdown = async () => {
    await server.close();
    artifacts.close();
    tasks.close();
    workflows.close();
    workState.close();
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
  ArtifactsRepository,
  TasksRepository,
  WorkflowsRepository,
  WorkStateReader,
  MAX_ARTIFACT_HTML_LENGTH,
  MAX_ARTIFACT_TITLE_LENGTH,
  MAX_TASK_SPEC_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  startServer,
};
