/** Collapses a leading `$HOME`-style prefix to `~` for display. */
export function collapseHome(path: string, home?: string | null): string {
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Short display label for a full path: last one or two segments, `~`-collapsed when possible. */
export function displayPath(path: string, home?: string | null): string {
  const collapsed = collapseHome(path, home);
  const segments = collapsed.split('/').filter(Boolean);
  if (segments.length <= 2) return collapsed;
  const tail = segments.slice(-2).join('/');
  const prefix = collapsed.startsWith('~') ? '~/…/' : '…/';
  return `${prefix}${tail}`;
}

/** The final path segment, e.g. the worktree directory name. */
export function basename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
