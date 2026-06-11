// use-repo-icons.ts — React hook for per-project icon resolution (CTL-961, CTL-997).
//
// Fetches all detected candidates from /api/repo-icon/:repoKey, then derives the
// effective icon reactively from the repoIconPicksAtom — so a pick made in Settings
// updates the sidebar without a re-fetch.
import { useEffect, useState, useMemo } from "react";
import { useAtomValue } from "jotai";
import { repoIconPicksAtom, resolveEffectiveIcon } from "@/lib/repo-icon-picks-store";
import { parseIconCandidates, readIconOverride, type ResolvedRepoIcon, type IconCandidate } from "@/lib/repo-icons";
import type { RepoIconApiResponse } from "@/lib/repo-icons";

/** Map of repo short-name → resolved icon data. */
export type RepoIconMap = Record<string, ResolvedRepoIcon>;

interface FetchedIcon {
  candidates: IconCandidate[];
  defaultSelectedPath: string | null;
}

/**
 * Fetch and resolve per-repo icons for the given repos.
 * Returns the icon map, which updates reactively when the operator's pick changes.
 * Fail-open: a fetch failure yields empty candidates and null autoDataUrl.
 */
export function useRepoIcons(repos: readonly string[]): RepoIconMap {
  const [fetched, setFetched] = useState<Record<string, FetchedIcon>>({});
  const picks = useAtomValue(repoIconPicksAtom);

  useEffect(() => {
    if (repos.length === 0) return;
    let alive = true;

    async function fetchAll() {
      const entries = await Promise.all(
        repos.map(async (repo) => {
          let candidates: IconCandidate[] = [];
          let defaultSelectedPath: string | null = null;
          try {
            const r = await fetch(`/api/repo-icon/${encodeURIComponent(repo)}`);
            if (r.ok) {
              const data = (await r.json()) as RepoIconApiResponse;
              candidates = parseIconCandidates(data);
              defaultSelectedPath = data.selectedPath ?? null;
            }
          } catch {
            // network error → empty candidates
          }
          return [repo, { candidates, defaultSelectedPath }] as [string, FetchedIcon];
        }),
      );
      if (!alive) return;
      setFetched(Object.fromEntries(entries));
    }

    void fetchAll();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.join(",")]);

  // Derive the resolved map reactively on every render from fetched + picks.
  return useMemo(() => {
    const out: RepoIconMap = {};
    for (const repo of repos) {
      const f = fetched[repo] ?? { candidates: [], defaultSelectedPath: null };
      const { autoDataUrl, selectedPath } = resolveEffectiveIcon(
        f.candidates,
        f.defaultSelectedPath,
        picks[repo],
      );
      out[repo] = {
        autoDataUrl,
        candidates: f.candidates,
        selectedPath,
        override: readIconOverride(repo),
      };
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, fetched, picks]);
}
