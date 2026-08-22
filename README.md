# RBA

RBA is an Electron application for evidence-grounded software planning and
durable, scriptable task execution. A user discusses a goal with a planning
agent, reviews generated behavioral evidence, writes a plan, commits tasks, and
runs each task through a project-defined TypeScript workflow.

## Development

RBA requires Node.js 22.12 or newer and the authenticated Claude CLI.

```sh
npm install
npm run dev
```

Run the automated checks with:

```sh
npm run quality
```

## Workflows

Workflows live in the selected project's `.rba/workflows` directory and match
`*.workflow.ts` (JavaScript module extensions are supported too). Opening the
workflow picker for a project without that directory creates an editable
starter workflow and `.rba/workflow.d.ts` declarations.

```ts
import { workflow } from '@rba/workflow';

export default workflow({
  id: 'implement-and-check',

  async run(ctx) {
    await ctx.agent('implement', {
      session: 'implementer',
      prompt: `Implement ${ctx.task.title}\n\n${ctx.task.spec}`,
    });

    const tests = await ctx.command('tests', {
      command: ['npm', 'test'],
      timeoutMs: 120_000,
    });

    if (!tests.ok) {
      await ctx.agent('fix-tests', {
        session: 'implementer',
        prompt: `Fix these test failures:\n\n${tests.stdout}\n${tests.stderr}`,
      });
    }

    return ctx.human('approval', {
      title: 'Review implementation',
      description: 'Inspect the cumulative diff before continuing.',
    });
  },
});
```

### Runtime operations

- `ctx.agent(id, options)` starts or resumes a named Claude session in the
  task's isolated Git worktree. It returns the session ID and final text.
- `ctx.command(id, options)` executes an argument-array command in the worktree
  and returns its exit status, stdout, and stderr. A non-zero exit is a normal
  `{ ok: false }` result, so the script controls its route.
- `ctx.human(id, options)` durably suspends the run until the user responds in
  RBA.
- `ctx.sleep(id, options)` creates a bounded durable delay.
- `ctx.workflow(id, definition, input)` composes another imported workflow and
  namespaces its operation IDs.

Normal TypeScript provides conditions, loops, functions, imports, and error
handling. Workflows can parse an agent's returned `text` with any bundled
validation library when they need structured outcomes.

### Durable replay

Every operation ID must be unique along one execution path. RBA snapshots the
compiled workflow when a run starts and records each operation's input and
output in SQLite. On resumption, the script runs again from the beginning and
completed operations return their recorded result instead of repeating their
side effects.

Use data-derived IDs for repeated operations:

```ts
for (const check of checks) {
  await ctx.command(`check:${check.name}`, { command: check.command });
}
```

Changing the type or input of a recorded operation is rejected during replay.
New runs always use the latest workflow source; existing runs retain their
snapshot. If RBA stops while an external operation is actively running, that
run is marked failed because the engine cannot prove whether the side effect
finished. If it stops between operations, the control flow resumes safely.

Workflow files are trusted project automation, like build and test scripts.
They execute in a child Node process for lifecycle isolation, but the child is
not a security sandbox. External side effects are performed by the Electron
host and recorded before control returns to the script.
