export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ClaudeStartRequest = {
  requestId: string;
  prompt: string;
  cwd: string;
};

export type ClaudeStreamEvent =
  | { type: 'text-delta'; requestId: string; text: string }
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
