// @adhd/sox-source-provider — small path helpers shared by the GitHub and
// Bitbucket providers (URL path-segment encoding, path-prefix filtering).

/** Percent-encode each path segment individually, preserving '/' separators. */
export function encodeContentPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Filter a flat entry list to those at or under `path` (a directory prefix). */
export function filterByPathPrefix<T extends { path: string }>(entries: T[], path: string): T[] {
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return entries.filter((e) => e.path === path || e.path.startsWith(prefix));
}
