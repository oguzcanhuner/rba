import { useEffect, useState } from 'react';
import type { Workflow, WorkflowSaveRequest } from '../claude';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

type WorkflowEditorDialogProps = {
  open: boolean;
  workflow: Workflow | null;
  onOpenChange: (open: boolean) => void;
  onSave: (request: WorkflowSaveRequest) => Promise<void>;
};

function definitionTemplate() {
  return JSON.stringify(
    {
      start: 'build',
      steps: {
        build: { run: 'npm run build', next: 'done' },
        done: { type: 'terminal' },
      },
    },
    null,
    2,
  );
}

/** A raw JSON editor for a workflow's definition. It is a deliberate floor
 * rather than a ceiling: it exists so a workflow is never unfixable without
 * an agent, sharing the same validator as the MCP authoring path so both
 * reject identically. */
export function WorkflowEditorDialog({
  open,
  workflow,
  onOpenChange,
  onSave,
}: WorkflowEditorDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [directory, setDirectory] = useState('');
  const [definitionText, setDefinitionText] = useState(definitionTemplate());
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(workflow?.name ?? '');
    setDescription(workflow?.description ?? '');
    setDirectory(workflow?.directory ?? '');
    setDefinitionText(
      JSON.stringify(
        workflow?.definition ?? JSON.parse(definitionTemplate()),
        null,
        2,
      ),
    );
    setErrors([]);
  }, [open, workflow]);

  async function handleSave() {
    setErrors([]);
    let definition: unknown;
    try {
      definition = JSON.parse(definitionText);
    } catch {
      setErrors(['The definition is not valid JSON.']);
      return;
    }
    if (!name.trim()) {
      setErrors(['Name is required.']);
      return;
    }

    setSaving(true);
    try {
      await onSave({
        id: workflow?.id,
        name: name.trim(),
        description: description.trim() || null,
        directory: directory.trim() || null,
        // biome-ignore lint/suspicious/noExplicitAny: validated main-process side
        definition: definition as any,
      });
      onOpenChange(false);
    } catch (error) {
      setErrors([
        error instanceof Error
          ? error.message
          : 'This workflow could not be saved.',
      ]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {workflow ? 'Edit workflow' : 'New workflow'}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Name</span>
            <input
              className="rounded-md border border-input bg-input/30 px-2 py-1.5 text-sm"
              value={name}
              disabled={Boolean(workflow)}
              onChange={(event) => setName(event.target.value)}
              placeholder="ship-task"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Description</span>
            <input
              className="rounded-md border border-input bg-input/30 px-2 py-1.5 text-sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Default directory</span>
            <input
              className="rounded-md border border-input bg-input/30 px-2 py-1.5 text-sm"
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              placeholder="/path/to/repo"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Definition (JSON)</span>
            <textarea
              className="h-64 rounded-md border border-input bg-input/30 p-2 font-mono text-xs"
              value={definitionText}
              onChange={(event) => setDefinitionText(event.target.value)}
              spellCheck={false}
            />
          </label>
          {errors.length > 0 && (
            <ul className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
