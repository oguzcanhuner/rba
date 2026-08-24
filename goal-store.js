const { DatabaseSync } = require('node:sqlite');

function hasTable(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function hasColumn(database, table, column) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(({ name }) => name === column);
}

const migrations = [
  {
    version: 1,
    isApplied(database) {
      return ['goals', 'agent_sessions', 'messages'].every((table) =>
        hasTable(database, table),
      );
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS active_session_by_goal
          ON agent_sessions(goal_id) WHERE is_active = 1;

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          parts_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS messages_by_goal
          ON messages(goal_id, position);
      `);
    },
  },
  {
    version: 2,
    isApplied(database) {
      return hasColumn(database, 'goals', 'findings_markdown');
    },
    up(database) {
      if (!hasColumn(database, 'goals', 'findings_markdown')) {
        database.exec('ALTER TABLE goals ADD COLUMN findings_markdown TEXT');
      }
    },
  },
  {
    version: 3,
    isApplied(database) {
      return hasTable(database, 'tasks');
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          spec_markdown TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (goal_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS tasks_by_goal
          ON tasks(goal_id, sequence);
      `);
    },
  },
  {
    version: 4,
    isApplied(database) {
      return ['worker_runs', 'worker_messages'].every((table) =>
        hasTable(database, table),
      );
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS worker_runs (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          branch TEXT NOT NULL,
          worktree TEXT NOT NULL,
          base_revision TEXT,
          session_id TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS worker_messages (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          parts_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS worker_messages_by_task
          ON worker_messages(task_id, position);
      `);
    },
  },
  {
    version: 5,
    isApplied(database) {
      return hasColumn(database, 'worker_runs', 'base_revision');
    },
    up(database) {
      if (!hasColumn(database, 'worker_runs', 'base_revision')) {
        database.exec('ALTER TABLE worker_runs ADD COLUMN base_revision TEXT');
      }
    },
  },
  {
    // Versions 6 and 7 were used by the removed evidence-planning model.
    // Keep this migration distinct so existing databases also receive it.
    version: 8,
    isApplied(database) {
      return hasTable(database, 'artifacts');
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          html TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS artifacts_by_goal
          ON artifacts(goal_id, created_at);
      `);
    },
  },
  {
    version: 9,
    isApplied(database) {
      return hasTable(database, 'settings');
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 10,
    isApplied(database) {
      return hasColumn(database, 'goals', 'unread');
    },
    up(database) {
      if (!hasColumn(database, 'goals', 'unread')) {
        database.exec(
          'ALTER TABLE goals ADD COLUMN unread INTEGER NOT NULL DEFAULT 0',
        );
      }
    },
  },
];

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY
    )
  `);

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map(({ version }) => version),
  );
  const recordMigration = database.prepare(
    'INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)',
  );

  for (const migration of migrations) {
    if (
      appliedVersions.has(migration.version) &&
      migration.isApplied(database)
    ) {
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      migration.up(database);
      recordMigration.run(migration.version);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

class GoalStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    migrate(this.database);

    this.upsertGoal = this.database.prepare(`
      INSERT INTO goals (
        id, title, working_directory, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        working_directory = excluded.working_directory,
        updated_at = excluded.updated_at
    `);
    this.deactivateSessions = this.database.prepare(`
      UPDATE agent_sessions SET is_active = 0 WHERE goal_id = ?
    `);
    this.upsertSession = this.database.prepare(`
      INSERT INTO agent_sessions (
        id, goal_id, provider, external_id, metadata_json,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        external_id = excluded.external_id,
        metadata_json = excluded.metadata_json,
        is_active = 1,
        updated_at = excluded.updated_at
    `);
    this.upsertMessage = this.database.prepare(`
      INSERT INTO messages (
        id, goal_id, position, role, status, parts_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal_id = excluded.goal_id,
        position = excluded.position,
        role = excluded.role,
        status = excluded.status,
        parts_json = excluded.parts_json
    `);
    this.deleteStaleMessages = this.database.prepare(`
      DELETE FROM messages
      WHERE goal_id = ? AND position >= ?
    `);
    this.upsertSetting = this.database.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.markGoalUnread = this.database.prepare(`
      UPDATE goals SET unread = 1 WHERE id = ?
    `);
    this.markGoalRead = this.database.prepare(`
      UPDATE goals SET unread = 0 WHERE id = ?
    `);
  }

  getSettings() {
    const rows = this.database.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries(
      rows.map(({ key, value }) => [key, value]),
    );
    return {
      plannerModel: settings.plannerModel ?? 'sonnet',
      workerModel: settings.workerModel ?? 'sonnet',
    };
  }

  updateSettings(partial) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (partial.plannerModel !== undefined) {
        this.upsertSetting.run('plannerModel', partial.plannerModel);
      }
      if (partial.workerModel !== undefined) {
        this.upsertSetting.run('workerModel', partial.workerModel);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getSettings();
  }

  list() {
    return this.database
      .prepare(`
        SELECT
          id,
          title,
          working_directory AS workingDirectory,
          created_at AS createdAt,
          updated_at AS updatedAt,
          unread
        FROM goals
        ORDER BY created_at DESC
      `)
      .all()
      .map((row) => ({ ...row, unread: Boolean(row.unread) }));
  }

  get(id) {
    const goal = this.database
      .prepare(`
        SELECT
          id,
          title,
          working_directory AS workingDirectory,
          created_at AS createdAt,
          updated_at AS updatedAt,
          unread
        FROM goals
        WHERE id = ?
      `)
      .get(id);

    if (!goal) {
      return null;
    }
    goal.unread = Boolean(goal.unread);

    const sessionRow = this.database
      .prepare(`
        SELECT
          id,
          provider,
          external_id AS externalId,
          metadata_json AS metadataJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM agent_sessions
        WHERE goal_id = ? AND is_active = 1
      `)
      .get(id);
    let agentSession = null;
    if (sessionRow) {
      const { metadataJson, ...session } = sessionRow;
      agentSession = {
        ...session,
        metadata: JSON.parse(metadataJson),
      };
    }

    const messages = this.database
      .prepare(`
        SELECT id, role, status, parts_json AS partsJson
        FROM messages
        WHERE goal_id = ?
        ORDER BY position
      `)
      .all(id)
      .map(({ partsJson, ...message }) => ({
        ...message,
        parts: JSON.parse(partsJson),
      }));

    return {
      ...goal,
      agentSession,
      artifacts: this.listArtifacts(id),
      tasks: this.listTasks(id),
      messages,
    };
  }

  listArtifacts(goalId) {
    return this.database
      .prepare(`
        SELECT
          id,
          title,
          html,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM artifacts
        WHERE goal_id = ?
        ORDER BY created_at, id
      `)
      .all(goalId)
      .map((row) => ({ ...row }));
  }

  getArtifact(id) {
    const row = this.database
      .prepare(`
        SELECT id, goal_id AS goalId, title, html,
               created_at AS createdAt, updated_at AS updatedAt
        FROM artifacts
        WHERE id = ?
      `)
      .get(id);
    return row ? { ...row } : null;
  }

  listTasks(goalId) {
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
      .all(goalId)
      .map((row) => ({ ...row }));
  }

  listCommittedTasks() {
    return this.database
      .prepare(`
        SELECT
          t.id,
          t.goal_id AS goalId,
          e.title AS goalTitle,
          t.sequence,
          t.title,
          t.spec_markdown AS specMarkdown,
          t.status,
          t.created_at AS createdAt,
          t.updated_at AS updatedAt
        FROM tasks t
        JOIN goals e ON e.id = t.goal_id
        WHERE t.status <> 'draft'
        ORDER BY t.created_at DESC
      `)
      .all()
      .map((row) => ({ ...row }));
  }

  commitTasks(goalId) {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = this.database
        .prepare(`
          UPDATE tasks
          SET status = 'queued', updated_at = ?
          WHERE goal_id = ? AND status = 'draft'
        `)
        .run(now, goalId);

      if (result.changes > 0) {
        this.database
          .prepare('UPDATE goals SET updated_at = ? WHERE id = ?')
          .run(now, goalId);
      }
      this.database.exec('COMMIT');
      return this.listTasks(goalId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getTaskForWorker(taskId) {
    const row = this.database
      .prepare(`
        SELECT
          t.id,
          t.goal_id AS goalId,
          t.title,
          t.spec_markdown AS specMarkdown,
          t.status,
          e.working_directory AS workingDirectory
        FROM tasks t
        JOIN goals e ON e.id = t.goal_id
        WHERE t.id = ?
      `)
      .get(taskId);
    return row ? { ...row } : null;
  }

  createWorkerRun(
    taskId,
    { branch, worktree, baseRevision = null, startedAt },
  ) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.database
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(taskId);
      if (!task) {
        throw new Error('The task no longer exists.');
      }
      if (task.status !== 'queued') {
        throw new Error('Only queued tasks can be started.');
      }

      this.database
        .prepare(`
          INSERT INTO worker_runs (
            task_id, status, branch, worktree, base_revision, started_at
          ) VALUES (?, 'working', ?, ?, ?, ?)
        `)
        .run(taskId, branch, worktree, baseRevision, startedAt);
      this.database
        .prepare(
          `UPDATE tasks SET status = 'working', updated_at = ? WHERE id = ?`,
        )
        .run(startedAt, taskId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getWorkerRun(taskId);
  }

  saveWorkerMessage(taskId, message, position = 0) {
    this.database
      .prepare(`
        INSERT INTO worker_messages (
          id, task_id, position, role, status, parts_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          position = excluded.position,
          role = excluded.role,
          status = excluded.status,
          parts_json = excluded.parts_json
      `)
      .run(
        message.id,
        taskId,
        position,
        message.role,
        message.status,
        JSON.stringify(message.parts),
      );
  }

  beginWorkerTurn(taskId, userMessage, assistantMessage) {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const run = this.database
        .prepare(
          'SELECT session_id AS sessionId FROM worker_runs WHERE task_id = ?',
        )
        .get(taskId);
      if (!run?.sessionId) {
        throw new Error('This worker cannot receive another message yet.');
      }

      const { position } = this.database
        .prepare(
          `SELECT COALESCE(MAX(position), -1) + 1 AS position
           FROM worker_messages WHERE task_id = ?`,
        )
        .get(taskId);
      const insertMessage = this.database.prepare(`
        INSERT INTO worker_messages (
          id, task_id, position, role, status, parts_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertMessage.run(
        userMessage.id,
        taskId,
        position,
        userMessage.role,
        userMessage.status,
        JSON.stringify(userMessage.parts),
      );
      insertMessage.run(
        assistantMessage.id,
        taskId,
        position + 1,
        assistantMessage.role,
        assistantMessage.status,
        JSON.stringify(assistantMessage.parts),
      );
      this.database
        .prepare(`
          UPDATE worker_runs
          SET status = 'working', error = NULL, finished_at = NULL
          WHERE task_id = ?
        `)
        .run(taskId);
      this.database
        .prepare(
          `UPDATE tasks SET status = 'working', updated_at = ? WHERE id = ?`,
        )
        .run(now, taskId);
      this.database.exec('COMMIT');
      return {
        run: this.getWorkerRun(taskId),
        assistantPosition: position + 1,
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  updateWorkerRun(taskId, { status, sessionId = null, error = null }) {
    const now = new Date().toISOString();
    const finishedAt = status === 'working' ? null : now;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(`
          UPDATE worker_runs
          SET status = ?, session_id = COALESCE(?, session_id),
              error = ?, finished_at = ?
          WHERE task_id = ?
        `)
        .run(status, sessionId, error, finishedAt, taskId);
      if (result.changes === 0) {
        throw new Error('The worker no longer exists.');
      }
      this.database
        .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, taskId);
      this.database.exec('COMMIT');
    } catch (updateError) {
      this.database.exec('ROLLBACK');
      throw updateError;
    }
    return this.getWorkerRun(taskId);
  }

  /** Marks a task as fully closed once its branch has been merged, without
   * touching the underlying worker run. Allowed once the agent's run has
   * left the working state, since a partial diff might still get manually
   * merged or cherry-picked. */
  completeTask(taskId) {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE tasks SET status = 'merged', updated_at = ?
        WHERE id = ? AND status IN ('completed', 'stopped', 'failed')
      `)
      .run(now, taskId);
    if (result.changes === 0) {
      throw new Error('This task cannot be marked as merged.');
    }
  }

  getWorkerRun(taskId) {
    const run = this.database
      .prepare(`
        SELECT
          w.task_id AS taskId,
          t.goal_id AS goalId,
          t.title,
          w.status,
          w.branch,
          w.worktree,
          w.base_revision AS baseRevision,
          w.session_id AS sessionId,
          w.error,
          w.started_at AS startedAt,
          w.finished_at AS finishedAt
        FROM worker_runs w
        JOIN tasks t ON t.id = w.task_id
        WHERE w.task_id = ?
      `)
      .get(taskId);
    if (!run) {
      return null;
    }

    const messages = this.database
      .prepare(`
        SELECT id, role, status, parts_json AS partsJson
        FROM worker_messages
        WHERE task_id = ?
        ORDER BY position
      `)
      .all(taskId)
      .map(({ partsJson, ...message }) => ({
        ...message,
        parts: JSON.parse(partsJson),
      }));
    return { ...run, messages };
  }

  interruptWorkingRuns() {
    const now = new Date().toISOString();
    const failureMessage = 'RBA stopped before this worker finished.';
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const interruptedMessages = this.database
        .prepare(`
          SELECT m.id, m.parts_json AS partsJson
          FROM worker_messages m
          JOIN worker_runs w ON w.task_id = m.task_id
          WHERE w.status = 'working'
        `)
        .all();
      const updateMessage = this.database.prepare(`
        UPDATE worker_messages
        SET status = 'error', parts_json = ?
        WHERE id = ?
      `);
      for (const { id, partsJson } of interruptedMessages) {
        const parts = JSON.parse(partsJson).map((part) =>
          part.type === 'tool' && part.tool.status === 'running'
            ? { ...part, tool: { ...part.tool, status: 'error' } }
            : part,
        );
        updateMessage.run(JSON.stringify(parts), id);
      }
      this.database
        .prepare(`
          UPDATE worker_runs
          SET status = 'failed', error = ?, finished_at = ?
          WHERE status = 'working'
        `)
        .run(failureMessage, now);
      this.database
        .prepare(`
          UPDATE tasks
          SET status = 'failed', updated_at = ?
          WHERE status = 'working'
        `)
        .run(now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  save(goal) {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      this.upsertGoal.run(
        goal.id,
        goal.title,
        goal.workingDirectory,
        goal.createdAt,
        goal.updatedAt,
      );

      if (goal.agentSession) {
        const session = goal.agentSession;
        this.deactivateSessions.run(goal.id);
        this.upsertSession.run(
          session.id,
          goal.id,
          session.provider,
          session.externalId,
          JSON.stringify(session.metadata),
          session.createdAt,
          session.updatedAt,
        );
      }

      goal.messages.forEach((message, position) => {
        this.upsertMessage.run(
          message.id,
          goal.id,
          position,
          message.role,
          message.status,
          JSON.stringify(message.parts),
        );
      });
      this.deleteStaleMessages.run(goal.id, goal.messages.length);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  markUnread(goalId) {
    this.markGoalUnread.run(goalId);
  }

  markRead(goalId) {
    this.markGoalRead.run(goalId);
  }

  close() {
    this.database.close();
  }
}

module.exports = { GoalStore };
