const { access, mkdir, readdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const DECLARATIONS = `
declare module '@rba/workflow' {
  export type TaskInput = {
    task: {
      id: string;
      title: string;
      spec: string;
      workingDirectory: string;
      workspace: string;
    };
  };
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
      timeoutMs?: number;
      mode?: 'read' | 'write';
    }): Promise<{ sessionId: string; text: string }>;
    human<T = { action: string; response: string | null }>(id: string, options: {
      title: string;
      description?: string;
      actions?: Array<{ id: string; label: string }>;
    }): Promise<T>;
    sleep(id: string, options: { milliseconds: number }): Promise<void>;
    workflow<ChildInput, ChildOutput>(
      id: string,
      definition: { run(context: WorkflowContext<ChildInput>): Promise<ChildOutput> },
      input: ChildInput,
    ): Promise<ChildOutput>;
  };
  export function workflow<Input = TaskInput, Output = unknown>(definition: {
    id: string;
    run(context: WorkflowContext<Input>): Promise<Output>;
  }): { id: string; run(context: WorkflowContext<Input>): Promise<Output> };
}
`;

const STARTER = `import { workflow } from '@rba/workflow';

export default workflow({
  id: 'implement-review',

  async run(ctx) {
    let prompt = \`Implement this task autonomously and then stop.\n\n# Task\n\n\${ctx.task.title}\n\n\${ctx.task.spec}\`;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ctx.agent(\`implement:\${attempt}\`, {
        session: 'implementer',
        prompt,
      });

      const review = await ctx.agent(\`review:\${attempt}\`, {
        session: 'reviewer',
        mode: 'read',
        includeDiff: true,
        prompt: 'Review the implementation against the task. Identify only material correctness, scope, and verification issues.',
      });

      const decision = await ctx.human(\`decision:\${attempt}\`, {
        title: 'Review implementation',
        description: review.text,
        actions: [
          { id: 'approve', label: 'Approve' },
          { id: 'revise', label: 'Request revision' },
        ],
      });

      if (decision.action === 'approve') return decision;
      prompt = \`Revise the implementation using this review:\n\n\${review.text}\n\nUser note:\n\${decision.response ?? '(none)'}\`;
    }

    throw new Error('The workflow reached its three-attempt revision limit.');
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
