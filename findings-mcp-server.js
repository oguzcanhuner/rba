const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StdioServerTransport,
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const MAX_FINDINGS_LENGTH = 500_000;

class FindingsRepository {
  constructor(filename, explorationId) {
    if (!path.isAbsolute(filename)) {
      throw new Error('The exploration database path must be absolute.');
    }
    if (
      typeof explorationId !== 'string' ||
      explorationId.length === 0 ||
      explorationId.length > 100
    ) {
      throw new Error('The exploration ID is invalid.');
    }

    this.explorationId = explorationId;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.readStatement = this.database.prepare(`
      SELECT findings_markdown AS findingsMarkdown
      FROM explorations
      WHERE id = ?
    `);
    this.updateStatement = this.database.prepare(`
      UPDATE explorations
      SET findings_markdown = ?, updated_at = ?
      WHERE id = ?
    `);
  }

  read() {
    return this.readStatement.get(this.explorationId)?.findingsMarkdown ?? null;
  }

  update(markdown) {
    if (typeof markdown !== 'string' || markdown.length > MAX_FINDINGS_LENGTH) {
      throw new Error('The findings Markdown is invalid.');
    }

    return (
      this.updateStatement.run(
        markdown,
        new Date().toISOString(),
        this.explorationId,
      ).changes > 0
    );
  }

  close() {
    this.database.close();
  }
}

async function startServer({ databasePath, explorationId }) {
  const repository = new FindingsRepository(databasePath, explorationId);
  const server = new McpServer({ name: 'rba-findings', version: '1.0.0' });

  server.registerTool(
    'read_findings',
    {
      title: 'Read findings',
      description:
        "Read the active exploration's current findings Markdown before revising it.",
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
    'update_findings',
    {
      title: 'Update findings',
      description:
        "Replace the active exploration's findings with the complete revised Markdown document.",
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
          content: [
            { type: 'text', text: 'The exploration no longer exists.' },
          ],
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
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  startServer({
    databasePath: process.env.RBA_EXPLORATION_DATABASE,
    explorationId: process.env.RBA_EXPLORATION_ID,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { FindingsRepository, MAX_FINDINGS_LENGTH, startServer };
