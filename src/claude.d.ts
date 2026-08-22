export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ClaudeStartRequest = {
  requestId: string;
  goalId: string;
  prompt: string;
  cwd: string;
  sessionId?: string;
};

export type ClaudeToolInput = Record<string, unknown> | null;

export type ClaudeStreamEvent =
  | { type: 'text-delta'; requestId: string; text: string }
  | {
      type: 'tool-start';
      requestId: string;
      tool: { id: string; name: string };
    }
  | {
      type: 'tool-input';
      requestId: string;
      tool: { id: string; input: ClaudeToolInput };
    }
  | {
      type: 'tool-result';
      requestId: string;
      tool: { id: string; isError: boolean };
    }
  | {
      type: 'audit-updated';
      requestId: string;
      artifacts: AuditArtifact[];
    }
  | {
      type: 'tasks-updated';
      requestId: string;
      tasks: Task[];
    }
  | {
      type: 'complete';
      requestId: string;
      sessionId: string;
    }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; requestId: string; message: string };

export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';
export type ToolStatus = 'running' | 'complete' | 'cancelled' | 'error';

export type DisplayTool = {
  id: string;
  name: string;
  input: ClaudeToolInput;
  status: ToolStatus;
};

export type DisplayPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'tool'; tool: DisplayTool };

export type DisplayMessage = {
  id: string;
  role: 'user' | 'assistant';
  status: MessageStatus;
  parts: DisplayPart[];
};

export type AgentSession = {
  id: string;
  provider: string;
  externalId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GoalSummary = {
  id: string;
  title: string;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
};

export type TestTraceAssertion = {
  name: string;
  status: string;
  durationMs: number | null;
  location: { line: number; column: number } | null;
  failures: string[];
};

export type TestTraceArtifact = {
  id: string;
  kind: 'test-trace';
  framework: string;
  testPath: string;
  testName: string | null;
  createdAt: string;
  success: boolean;
  durationMs: number;
  assertions: TestTraceAssertion[];
};

export type AuditArtifact = TestTraceArtifact;

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'working'
  | 'completed'
  | 'stopped'
  | 'failed';

export type Task = {
  id: string;
  sequence: number;
  title: string;
  specMarkdown: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type SidebarTask = Task & {
  goalId: string;
  goalTitle: string;
};

export type Goal = GoalSummary & {
  agentSession: AgentSession | null;
  findingsMarkdown: string | null;
  auditArtifacts: AuditArtifact[];
  planMarkdown: string | null;
  messages: DisplayMessage[];
};

/** What the store hands back on load. Tasks are owned by the task cache from
 * there on, and the store never writes them back from a goal save. */
export type GoalWithTasks = Goal & { tasks: Task[] };

export type WorkerRun = {
  taskId: string;
  goalId: string;
  title: string;
  status: Exclude<TaskStatus, 'draft' | 'queued'>;
  branch: string;
  worktree: string;
  baseRevision: string | null;
  sessionId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  messages: DisplayMessage[];
};

export type WorkerDiff = { patch: string };

export type WorkerEvent = { type: 'worker-updated'; run: WorkerRun };

export type WorkflowDefinition = { name: string; path: string };
export type WorkflowStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped';
export type WorkflowOperation = {
  id: string;
  runId: string;
  key: string;
  type: 'agent' | 'command' | 'human' | 'sleep';
  status: 'running' | 'waiting' | 'completed' | 'failed';
  attempt: number;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  messages: DisplayMessage[];
};
export type WorkflowRun = {
  id: string;
  taskId: string;
  workflowName: string;
  sourcePath: string;
  sourceHash: string;
  branch: string | null;
  worktree: string | null;
  baseRevision: string | null;
  status: WorkflowStatus;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  operations: WorkflowOperation[];
};
export type WorkflowEvent = {
  type: 'workflow-updated';
  run: WorkflowRun;
};

declare global {
  interface Window {
    claude: {
      start(request: ClaudeStartRequest): void;
      cancel(requestId: string): void;
      getDefaultDirectory(): Promise<string>;
      pickDirectory(): Promise<string | null>;
      onEvent(callback: (event: ClaudeStreamEvent) => void): () => void;
    };
    goals: {
      list(): Promise<GoalSummary[]>;
      get(id: string): Promise<GoalWithTasks | null>;
      save(goal: Goal): Promise<void>;
      commitTasks(goalId: string): Promise<Task[]>;
    };
    tasks: {
      list(): Promise<SidebarTask[]>;
    };
    workers: {
      get(taskId: string): Promise<WorkerRun | null>;
      start(taskId: string): Promise<WorkerRun>;
      stop(taskId: string): Promise<WorkerRun>;
      send(taskId: string, prompt: string): Promise<WorkerRun>;
      diff(taskId: string): Promise<WorkerDiff>;
      onEvent(callback: (event: WorkerEvent) => void): () => void;
    };
    workflows: {
      list(taskId: string): Promise<WorkflowDefinition[]>;
      get(taskId: string): Promise<WorkflowRun | null>;
      start(taskId: string, sourcePath: string): Promise<WorkflowRun>;
      resolve(runId: string, key: string, value: unknown): Promise<WorkflowRun>;
      stop(runId: string): Promise<WorkflowRun>;
      diff(taskId: string): Promise<WorkerDiff>;
      onEvent(callback: (event: WorkflowEvent) => void): () => void;
    };
  }
}
