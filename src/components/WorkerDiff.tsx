import { createElement, type ReactNode } from 'react';
import { highlightLine, languageForPath } from '../highlight';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

type DiffLine = {
  content: string;
  id: string;
  kind: 'addition' | 'context' | 'deletion' | 'hunk' | 'metadata';
};

export type DiffFile = {
  additions: number;
  deletions: number;
  lines: DiffLine[];
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
};

type FileTreeNode = {
  children: Map<string, FileTreeNode>;
  file?: DiffFile & { index: number };
  name: string;
};

function displayPath(value: string) {
  const path = value.replace(/^"|"$/g, '');
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function parseFile(section: string): DiffFile | null {
  const headerPath = section.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2];
  const source = section.match(/^--- (.+)$/m)?.[1];
  const destination = section.match(/^\+\+\+ (.+)$/m)?.[1];
  const renamedTo = section.match(/^rename to (.+)$/m)?.[1];
  const path = renamedTo
    ? displayPath(renamedTo)
    : destination && destination !== '/dev/null'
      ? displayPath(destination)
      : source && source !== '/dev/null'
        ? displayPath(source)
        : headerPath
          ? displayPath(headerPath)
          : null;
  if (!path) {
    return null;
  }

  const status = renamedTo
    ? 'renamed'
    : source === '/dev/null'
      ? 'added'
      : destination === '/dev/null'
        ? 'deleted'
        : 'modified';
  const lines: DiffLine[] = [];
  let inHunk = false;
  let additions = 0;
  let deletions = 0;

  function addLine(line: Omit<DiffLine, 'id'>) {
    lines.push({ ...line, id: `${lines.length}-${line.content}` });
  }

  for (const content of section.split('\n').slice(1)) {
    if (content.startsWith('@@')) {
      inHunk = true;
      addLine({ content, kind: 'hunk' });
    } else if (inHunk && content.startsWith('+')) {
      additions += 1;
      addLine({ content, kind: 'addition' });
    } else if (inHunk && content.startsWith('-')) {
      deletions += 1;
      addLine({ content, kind: 'deletion' });
    } else if (inHunk && content.startsWith(' ')) {
      addLine({ content, kind: 'context' });
    } else if (
      inHunk ||
      !/^(index |new file |deleted file |similarity |rename |old mode |new mode |--- |\+\+\+ )/.test(
        content,
      )
    ) {
      addLine({ content, kind: 'metadata' });
    }
  }

  return { additions, deletions, lines, path, status };
}

export function parseWorkerDiff(patch: string) {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .map(parseFile)
    .filter((file): file is DiffFile => file !== null);
}

function fileTree(files: DiffFile[]) {
  const root: FileTreeNode = { children: new Map(), name: '' };
  files.forEach((file, index) => {
    const parts = file.path.split('/');
    let parent = root;
    parts.forEach((name, partIndex) => {
      const node: FileTreeNode = parent.children.get(name) ?? {
        children: new Map(),
        name,
      };
      parent.children.set(name, node);
      if (partIndex === parts.length - 1) {
        node.file = { ...file, index };
      }
      parent = node;
    });
  });
  return root;
}

function FileTreeNodes({
  node,
  selected,
  onPick,
}: {
  node: FileTreeNode;
  selected: string | null;
  onPick: (path: string) => void;
}) {
  const children = [...node.children.values()].sort((left, right) => {
    const leftDirectory = left.children.size > 0;
    const rightDirectory = right.children.size > 0;
    return leftDirectory === rightDirectory
      ? left.name.localeCompare(right.name)
      : leftDirectory
        ? -1
        : 1;
  });

  return (
    <ul>
      {children.map((child) => (
        <li key={child.name}>
          {child.file ? (
            <button
              type="button"
              aria-current={child.file.path === selected ? 'true' : undefined}
              onClick={() => onPick(child.file?.path ?? '')}
              title={child.file.path}
            >
              <span
                className={`changed-files__status changed-files__status--${child.file.status}`}
              >
                {child.file.status[0].toUpperCase()}
              </span>
              <span className="file-tree__name">{child.name}</span>
              <span className="file-tree__stats">
                {child.file.additions > 0 && (
                  <span className="diff-additions">
                    +{child.file.additions}
                  </span>
                )}
                {child.file.deletions > 0 && (
                  <span className="diff-deletions">
                    −{child.file.deletions}
                  </span>
                )}
              </span>
            </button>
          ) : (
            <Collapsible className="file-tree__folder" defaultOpen>
              <CollapsibleTrigger className="file-tree__directory">
                <span className="collapse-chevron" aria-hidden="true">
                  ›
                </span>
                <span>{child.name}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <FileTreeNodes
                  node={child}
                  selected={selected}
                  onPick={onPick}
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </li>
      ))}
    </ul>
  );
}

export function WorkerFileTree({
  files,
  selected,
  onPick,
}: {
  files: DiffFile[];
  selected: string | null;
  onPick: (path: string) => void;
}) {
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);

  return (
    <aside className="worker-files" aria-label="Changed files">
      <div className="worker-files__summary">
        {files.length} {files.length === 1 ? 'file' : 'files'}
        <span className="diff-additions">+{additions}</span>
        <span className="diff-deletions">−{deletions}</span>
      </div>
      {files.length === 0 ? (
        <p className="worker-files__empty">No changed files</p>
      ) : (
        <nav className="file-tree" aria-label="Changed file tree">
          <FileTreeNodes
            node={fileTree(files)}
            selected={selected}
            onPick={onPick}
          />
        </nav>
      )}
    </aside>
  );
}

function DiffCodeLine({
  line,
  language,
}: {
  line: DiffLine;
  language: string | null;
}) {
  if (line.kind === 'hunk') {
    return (
      <span className="diff-code-line diff-code-line--hunk">
        {line.content || ' '}
      </span>
    );
  }

  const hasMarker = ['addition', 'context', 'deletion'].includes(line.kind);
  const marker = hasMarker ? line.content[0] : ' ';
  const code = hasMarker ? line.content.slice(1) : line.content;
  return (
    <span className={`diff-code-line diff-code-line--${line.kind}`}>
      <span className="diff-code-line__marker">{marker || ' '}</span>
      <span>{highlightedNodes(highlightLine(code, language) || ' ')}</span>
    </span>
  );
}

function highlightedNodes(html: string): ReactNode[] {
  type HighlightNode = {
    children: Array<HighlightNode | string>;
    className: string | null;
  };
  const root: HighlightNode = { children: [], className: null };
  const stack = [root];
  const tags = /<span class="([^"]+)">|<\/span>/g;
  let position = 0;

  for (const match of html.matchAll(tags)) {
    const index = match.index ?? position;
    if (index > position) {
      stack.at(-1)?.children.push(decodeEntities(html.slice(position, index)));
    }
    if (match[1]) {
      const node: HighlightNode = { children: [], className: match[1] };
      stack.at(-1)?.children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      stack.pop();
    }
    position = index + match[0].length;
  }
  if (position < html.length) {
    stack.at(-1)?.children.push(decodeEntities(html.slice(position)));
  }

  function renderNode(node: HighlightNode | string, key: number): ReactNode {
    return typeof node === 'string'
      ? node
      : createElement(
          'span',
          { className: node.className ?? undefined, key },
          node.children.map(renderNode),
        );
  }

  return root.children.map(renderNode);
}

function decodeEntities(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

export function WorkerDiff({
  files,
  selected,
}: {
  files: DiffFile[];
  selected: string | null;
}) {
  return (
    <section className="worker-diff" aria-label="Worker changes">
      {files.length === 0 ? (
        <p className="worker-diff__empty">No changes yet.</p>
      ) : (
        <div className="worker-diff__content">
          <div className="diff-files">
            {files.map((file, index) => (
              <Collapsible
                className="diff-file"
                defaultOpen
                data-active={file.path === selected ? 'true' : undefined}
                id={`worker-diff-${index}`}
                key={file.path}
              >
                <CollapsibleTrigger className="diff-file__header">
                  <span className="collapse-chevron" aria-hidden="true">
                    ›
                  </span>
                  <span
                    className={`changed-files__status changed-files__status--${file.status}`}
                  >
                    {file.status[0].toUpperCase()}
                  </span>
                  <code>{file.path}</code>
                  <span>
                    <strong className="diff-additions">
                      +{file.additions}
                    </strong>{' '}
                    <strong className="diff-deletions">
                      −{file.deletions}
                    </strong>
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <code className="diff-file__code hljs-diff">
                    {file.lines.map((line) => (
                      <DiffCodeLine
                        key={line.id}
                        line={line}
                        language={languageForPath(file.path)}
                      />
                    ))}
                  </code>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
