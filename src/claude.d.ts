export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ClaudeStartRequest = {
  requestId: string;
  explorationId: string;
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
      type: 'findings-updated';
      requestId: string;
      markdown: string;
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

export type ExplorationSummary = {
  id: string;
  title: string;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
};

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

export type Exploration = ExplorationSummary & {
  agentSession: AgentSession | null;
  findingsMarkdown: string | null;
  tasks: Task[];
  messages: DisplayMessage[];
};

export type WorkerRun = {
  taskId: string;
  explorationId: string;
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

declare global {
  interface Window {
    claude: {
      start(request: ClaudeStartRequest): void;
      cancel(requestId: string): void;
      getDefaultDirectory(): Promise<string>;
      pickDirectory(): Promise<string | null>;
      onEvent(callback: (event: ClaudeStreamEvent) => void): () => void;
    };
    explorations: {
      list(): Promise<ExplorationSummary[]>;
      get(id: string): Promise<Exploration | null>;
      save(exploration: Exploration): Promise<void>;
      commitTasks(explorationId: string): Promise<Task[]>;
    };
    workers: {
      get(taskId: string): Promise<WorkerRun | null>;
      start(taskId: string): Promise<WorkerRun>;
      stop(taskId: string): Promise<WorkerRun>;
      send(taskId: string, prompt: string): Promise<WorkerRun>;
      diff(taskId: string): Promise<WorkerDiff>;
      onEvent(callback: (event: WorkerEvent) => void): () => void;
    };
  }
}
