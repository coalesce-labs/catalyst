export function repoBasename(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

export function stripRefPrefix(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}
