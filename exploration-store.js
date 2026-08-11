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
      return ['explorations', 'agent_sessions', 'messages'].every((table) =>
        hasTable(database, table),
      );
    },
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS explorations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          exploration_id TEXT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS active_session_by_exploration
          ON agent_sessions(exploration_id) WHERE is_active = 1;

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          exploration_id TEXT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          parts_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS messages_by_exploration
          ON messages(exploration_id, position);
      `);
    },
  },
  {
    version: 2,
    isApplied(database) {
      return hasColumn(database, 'explorations', 'findings_markdown');
    },
    up(database) {
      if (!hasColumn(database, 'explorations', 'findings_markdown')) {
        database.exec(
          'ALTER TABLE explorations ADD COLUMN findings_markdown TEXT',
        );
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
          exploration_id TEXT NOT NULL REFERENCES explorations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          spec_markdown TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (exploration_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS tasks_by_exploration
          ON tasks(exploration_id, sequence);
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

class ExplorationStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    migrate(this.database);

    this.upsertExploration = this.database.prepare(`
      INSERT INTO explorations (
        id, title, working_directory, findings_markdown, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        working_directory = excluded.working_directory,
        findings_markdown = excluded.findings_markdown,
        updated_at = excluded.updated_at
    `);
    this.deactivateSessions = this.database.prepare(`
      UPDATE agent_sessions SET is_active = 0 WHERE exploration_id = ?
    `);
    this.upsertSession = this.database.prepare(`
      INSERT INTO agent_sessions (
        id, exploration_id, provider, external_id, metadata_json,
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
        id, exploration_id, position, role, status, parts_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exploration_id = excluded.exploration_id,
        position = excluded.position,
        role = excluded.role,
        status = excluded.status,
        parts_json = excluded.parts_json
    `);
    this.deleteStaleMessages = this.database.prepare(`
      DELETE FROM messages
      WHERE exploration_id = ? AND position >= ?
    `);
  }

  list() {
    return this.database
      .prepare(`
        SELECT
          id,
          title,
          working_directory AS workingDirectory,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM explorations
        ORDER BY created_at DESC
      `)
      .all()
      .map((row) => ({ ...row }));
  }

  get(id) {
    const exploration = this.database
      .prepare(`
        SELECT
          id,
          title,
          working_directory AS workingDirectory,
          findings_markdown AS findingsMarkdown,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM explorations
        WHERE id = ?
      `)
      .get(id);

    if (!exploration) {
      return null;
    }

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
        WHERE exploration_id = ? AND is_active = 1
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
        WHERE exploration_id = ?
        ORDER BY position
      `)
      .all(id)
      .map(({ partsJson, ...message }) => ({
        ...message,
        parts: JSON.parse(partsJson),
      }));

    return {
      ...exploration,
      agentSession,
      tasks: this.listTasks(id),
      messages,
    };
  }

  listTasks(explorationId) {
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
        WHERE exploration_id = ?
        ORDER BY sequence
      `)
      .all(explorationId)
      .map((row) => ({ ...row }));
  }

  commitTasks(explorationId) {
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = this.database
        .prepare(`
          UPDATE tasks
          SET status = 'queued', updated_at = ?
          WHERE exploration_id = ? AND status = 'draft'
        `)
        .run(now, explorationId);

      if (result.changes > 0) {
        this.database
          .prepare('UPDATE explorations SET updated_at = ? WHERE id = ?')
          .run(now, explorationId);
      }
      this.database.exec('COMMIT');
      return this.listTasks(explorationId);
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
          t.exploration_id AS explorationId,
          t.title,
          t.spec_markdown AS specMarkdown,
          t.status,
          e.working_directory AS workingDirectory,
          e.findings_markdown AS findingsMarkdown
        FROM tasks t
        JOIN explorations e ON e.id = t.exploration_id
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

  getWorkerRun(taskId) {
    const run = this.database
      .prepare(`
        SELECT
          w.task_id AS taskId,
          t.exploration_id AS explorationId,
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

  save(exploration) {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      this.upsertExploration.run(
        exploration.id,
        exploration.title,
        exploration.workingDirectory,
        exploration.findingsMarkdown,
        exploration.createdAt,
        exploration.updatedAt,
      );

      if (exploration.agentSession) {
        const session = exploration.agentSession;
        this.deactivateSessions.run(exploration.id);
        this.upsertSession.run(
          session.id,
          exploration.id,
          session.provider,
          session.externalId,
          JSON.stringify(session.metadata),
          session.createdAt,
          session.updatedAt,
        );
      }

      exploration.messages.forEach((message, position) => {
        this.upsertMessage.run(
          message.id,
          exploration.id,
          position,
          message.role,
          message.status,
          JSON.stringify(message.parts),
        );
      });
      this.deleteStaleMessages.run(exploration.id, exploration.messages.length);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

module.exports = { ExplorationStore };
