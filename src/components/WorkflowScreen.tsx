import { useEffect, useMemo, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type {
  SidebarTask,
  WorkflowDefinition,
  WorkflowOperation,
  WorkflowRun,
} from '../claude';
import { workerToolLabel } from '../lib/toolLabels';
import { MarkdownContent } from './MarkdownContent';
import { MessageThread } from './MessageThread';
import { Button } from './ui/button';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from './ui/resizable';
import { Textarea } from './ui/textarea';
import { parseWorkerDiff, WorkerDiff, WorkerFileTree } from './WorkerDiff';

type Props = {
  task: SidebarTask;
  run: WorkflowRun | null;
  definitions: WorkflowDefinition[];
  diff: string;
  error: string | null;
  isStarting: boolean;
  onBack: () => void;
  onStart: (sourcePath: string) => void;
  onResolve: (key: string, value: unknown) => void;
  onStop: () => void;
};

function operationTitle(operation: WorkflowOperation) {
  const title = operation.input.title;
  return typeof title === 'string' ? title : operation.key;
}

function OperationDetail({
  operation,
  onResolve,
}: {
  operation: WorkflowOperation | null;
  onResolve: (key: string, value: unknown) => void;
}) {
  const [response, setResponse] = useState('');
  if (!operation) {
    return (
      <p className="workflow-empty">
        The workflow has not started an operation yet.
      </p>
    );
  }
  if (operation.type === 'agent') {
    return (
      <div className="workflow-operation-detail">
        <MessageThread
          assistantLabel={operationTitle(operation)}
          messages={operation.messages}
          toolLabel={workerToolLabel}
        />
        {operation.error && (
          <div className="error-message">{operation.error}</div>
        )}
      </div>
    );
  }
  if (operation.type === 'command') {
    const output = operation.output as {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    } | null;
    return (
      <div className="workflow-command">
        <code>
          {(operation.input.command as string[] | undefined)?.join(' ')}
        </code>
        {output && (
          <pre>{[output.stdout, output.stderr].filter(Boolean).join('\n')}</pre>
        )}
        {operation.error && (
          <div className="error-message">{operation.error}</div>
        )}
      </div>
    );
  }
  if (operation.type === 'human' && operation.status === 'waiting') {
    const actions = Array.isArray(operation.input.actions)
      ? (
          operation.input.actions as Array<{ id: string; label: string }>
        ).filter(
          (action) =>
            typeof action.id === 'string' && typeof action.label === 'string',
        )
      : [{ id: 'continue', label: 'Continue workflow' }];
    return (
      <div className="workflow-human">
        <h3>{operationTitle(operation)}</h3>
        {typeof operation.input.description === 'string' && (
          <p>{operation.input.description}</p>
        )}
        <Textarea
          aria-label="Workflow response"
          placeholder="Optional response for the workflow"
          value={response}
          onChange={(event) => setResponse(event.target.value)}
        />
        <div className="workflow-human__actions">
          {actions.map((action) => (
            <Button
              type="button"
              variant={action.id === 'reject' ? 'secondary' : 'default'}
              key={action.id}
              onClick={() =>
                onResolve(operation.key, {
                  action: action.id,
                  response: response.trim() || null,
                })
              }
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="workflow-operation-detail">
      <pre>{JSON.stringify(operation.output, null, 2)}</pre>
    </div>
  );
}

export function WorkflowScreen({
  task,
  run,
  definitions,
  diff,
  error,
  isStarting,
  onBack,
  onStart,
  onResolve,
  onStop,
}: Props) {
  const layout = useDefaultLayout({
    id: 'rba.workflow-workspace',
    panelIds: ['changes', 'workflow'],
    storage: window.localStorage,
  });
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [selectedOperation, setSelectedOperation] = useState<string | null>(
    null,
  );
  const files = useMemo(() => parseWorkerDiff(diff), [diff]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedWorkflow && definitions[0])
      setSelectedWorkflow(definitions[0].path);
  }, [definitions, selectedWorkflow]);

  useEffect(() => {
    const current = run?.operations.at(-1);
    if (
      current &&
      !run?.operations.some(({ id }) => id === selectedOperation)
    ) {
      setSelectedOperation(current.id);
    }
  }, [run, selectedOperation]);

  useEffect(() => {
    if (files.length === 0) setSelectedFile(null);
    else if (
      !selectedFile ||
      !files.some(({ path }) => path === selectedFile)
    ) {
      setSelectedFile(files[0].path);
    }
  }, [files, selectedFile]);

  if (!run) {
    return (
      <section className="worker-screen">
        <header className="worker-screen__header">
          <Button type="button" size="sm" variant="ghost" onClick={onBack}>
            ← Back
          </Button>
          <h1>{task.title}</h1>
          <span className="worker-status worker-status--queued">● queued</span>
        </header>
        <main className="task-ready">
          <div className="task-ready__content">
            <p className="task-ready__source">From {task.goalTitle}</p>
            <MarkdownContent className="typeset-task">
              {task.specMarkdown || 'No specification.'}
            </MarkdownContent>
            <section
              className="workflow-picker"
              aria-labelledby="workflow-picker-title"
            >
              <h2 id="workflow-picker-title">Workflow</h2>
              <p>
                Scripts are loaded from <code>.rba/workflows</code>.
              </p>
              <div className="workflow-picker__options">
                {definitions.map((definition) => (
                  <Button
                    type="button"
                    variant={
                      selectedWorkflow === definition.path
                        ? 'default'
                        : 'outline'
                    }
                    key={definition.path}
                    onClick={() => setSelectedWorkflow(definition.path)}
                  >
                    {definition.name}
                  </Button>
                ))}
              </div>
            </section>
            {error && <div className="error-message">{error}</div>}
            <Button
              type="button"
              disabled={isStarting || !selectedWorkflow}
              onClick={() => onStart(selectedWorkflow)}
            >
              {isStarting ? 'Starting…' : 'Run workflow'}
            </Button>
          </div>
        </main>
      </section>
    );
  }

  const operation =
    run.operations.find(({ id }) => id === selectedOperation) ??
    run.operations.at(-1) ??
    null;

  return (
    <section className="worker-screen">
      <header className="worker-screen__header">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h1>{task.title}</h1>
        <span className={`worker-status worker-status--${run.status}`}>
          ● {run.workflowName} · {run.status}
        </span>
      </header>
      <ResizablePanelGroup
        className="workspace worker-workspace"
        defaultLayout={layout.defaultLayout}
        id="rba.workflow-workspace"
        onLayoutChanged={layout.onLayoutChanged}
        orientation="horizontal"
      >
        <ResizablePanel defaultSize={65} id="changes" minSize={35}>
          <section className="worker-review" aria-label="Workflow changes">
            <WorkerFileTree
              files={files}
              selected={selectedFile}
              onPick={setSelectedFile}
            />
            <WorkerDiff files={files} selected={selectedFile} />
          </section>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={35} id="workflow" minSize={28}>
          <section className="workflow-panel">
            <header className="workflow-panel__header">
              <h2>Run</h2>
              {['running', 'waiting'].includes(run.status) && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={onStop}
                >
                  Stop
                </Button>
              )}
            </header>
            <nav className="workflow-timeline" aria-label="Workflow operations">
              {run.operations.map((item) => (
                <button
                  type="button"
                  className="workflow-timeline__item"
                  aria-current={item.id === operation?.id ? 'step' : undefined}
                  key={item.id}
                  onClick={() => setSelectedOperation(item.id)}
                >
                  <span
                    className={`workflow-dot workflow-dot--${item.status}`}
                  />
                  <span>{operationTitle(item)}</span>
                  <small>
                    {item.type} · {item.status}
                  </small>
                </button>
              ))}
            </nav>
            <div className="workflow-panel__detail">
              <OperationDetail operation={operation} onResolve={onResolve} />
              {run.error && <div className="error-message">{run.error}</div>}
              {error && <div className="error-message">{error}</div>}
            </div>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}
