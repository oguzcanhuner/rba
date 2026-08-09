export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ClaudeStartRequest = {
  requestId: string;
  prompt: string;
  cwd: string;
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
      type: 'complete';
      requestId: string;
      sessionId: string;
    }
  | { type: 'cancelled'; requestId: string }
  | { type: 'error'; requestId: string; message: string };

declare global {
  interface Window {
    claude: {
      start(request: ClaudeStartRequest): void;
      cancel(requestId: string): void;
      getDefaultDirectory(): Promise<string>;
      pickDirectory(): Promise<string | null>;
      onEvent(callback: (event: ClaudeStreamEvent) => void): () => void;
    };
  }
}
