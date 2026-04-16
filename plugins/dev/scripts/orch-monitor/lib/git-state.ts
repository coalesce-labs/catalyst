interface GitState {
  branch: string;
  commitsAhead: number;
  hasUpstream: boolean;
  lastCommitSha: string | null;
}

export interface GitRunnerResult {
  stdout: string;
  ok: boolean;
}

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<GitRunnerResult>;

interface ReadBranchGitStateOptions {
  runner?: GitRunner;
}

async function defaultRunner(
  args: string[],
  cwd: string,
): Promise<GitRunnerResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return { stdout, ok: exit === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

function parseCount(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function readBranchGitState(
  worktreePath: string,
  baseBranch: string,
  opts: ReadBranchGitStateOptions = {},
): Promise<GitState | null> {
  const runner = opts.runner ?? defaultRunner;

  const branchRes = await runner(["branch", "--show-current"], worktreePath);
  if (!branchRes.ok) return null;
  const branch = branchRes.stdout.trim();
  if (branch.length === 0) return null;

  const revListRes = await runner(
    ["rev-list", "--count", `${baseBranch}..HEAD`],
    worktreePath,
  );
  const commitsAhead = revListRes.ok ? parseCount(revListRes.stdout) : 0;

  const lsRemoteRes = await runner(
    ["ls-remote", "--heads", "origin", branch],
    worktreePath,
  );
  const hasUpstream = lsRemoteRes.ok && lsRemoteRes.stdout.trim().length > 0;

  const revParseRes = await runner(["rev-parse", "HEAD"], worktreePath);
  const sha = revParseRes.ok ? revParseRes.stdout.trim() : "";
  const lastCommitSha = sha.length > 0 ? sha : null;

  return { branch, commitsAhead, hasUpstream, lastCommitSha };
}
