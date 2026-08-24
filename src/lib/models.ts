export const AVAILABLE_MODELS = [
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus 5' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 4.5' },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]['id'];
