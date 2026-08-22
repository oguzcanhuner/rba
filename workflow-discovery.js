const { access, mkdir, readdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const DECLARATIONS = `
declare module '@rba/workflow' {
  export type CommandResult = {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  };
  export type WorkflowContext<Input = unknown> = {
    input: Input;
    task: Input extends { task: infer Task } ? Task : unknown;
    command(id: string, options: {
      command: string[];
      cwd?: string;
      timeoutMs?: number;
    }): Promise<CommandResult>;
    agent(id: string, options: {
      prompt: string;
      session?: string;
      includeDiff?: boolean;
    }): Promise<{ sessionId: string; text: string }>;
    human<T = unknown>(id: string, options: {
      title: string;
      description?: string;
    }): Promise<T>;
    sleep(id: string, options: { milliseconds: number }): Promise<void>;
  };
  export function workflow<Input = unknown, Output = unknown>(definition: {
    id: string;
    run(context: WorkflowContext<Input>): Promise<Output>;
  }): { id: string; run(context: WorkflowContext<Input>): Promise<Output> };
}
`;

const STARTER = `import { workflow } from '@rba/workflow';

export default workflow({
  id: 'implement',

  async run(ctx) {
    await ctx.agent('implement', {
      session: 'implementer',
      prompt: \`Implement this task autonomously and then stop.\n\n# Task\n\n\${ctx.task.title}\n\n\${ctx.task.spec}\`,
    });

    return ctx.human('approval', {
      title: 'Review implementation',
      description: 'Inspect the diff and approve or return a note to the workflow.',
    });
  },
});
`;

function workflowDirectory(projectDirectory) {
  return path.join(projectDirectory, '.rba', 'workflows');
}

async function ensureStarterWorkflow(projectDirectory) {
  const directory = workflowDirectory(projectDirectory);
  await mkdir(directory, { recursive: true });
  const declarations = path.join(projectDirectory, '.rba', 'workflow.d.ts');
  const starter = path.join(directory, 'implement.workflow.ts');
  await writeFile(declarations, DECLARATIONS, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await writeFile(starter, STARTER, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return starter;
}

async function listWorkflows(projectDirectory) {
  const directory = workflowDirectory(projectDirectory);
  try {
    await access(directory);
  } catch {
    await ensureStarterWorkflow(projectDirectory);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.workflow\.(?:js|mjs|cjs|ts|mts|cts)$/.test(entry.name),
    )
    .map((entry) => ({
      name: entry.name.replace(/\.workflow\.[^.]+$/, ''),
      path: path.join(directory, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

module.exports = {
  ensureStarterWorkflow,
  listWorkflows,
  workflowDirectory,
};
