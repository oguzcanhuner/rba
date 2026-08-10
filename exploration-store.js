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
