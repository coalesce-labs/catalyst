// use-repo-icons.ts — React hook for per-project icon resolution (CTL-961, CTL-997, CTL-1208).
//
// Fetches all detected candidates from /api/repo-icon/:repoKey, then derives the
// effective icon reactively from the repoIconPicksAtom — so a pick made in Settings
// updates the sidebar without a re-fetch.
import { useEffect, useState, useMemo } from "react";
import { useAtomValue } from "jotai";
import { repoIconPicksAtom, resolveEffectiveIcon, resolveProjectMark } from "@/lib/repo-icon-picks-store";
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
 *
 * CTL-1153 (M2): accepts optional `serverIconByRepo` (repo → chosen icon path from
 * the server's ProjectDescriptor.icon). It feeds as the `defaultSelectedPath` so the
 * precedence is: legacy localStorage pick > server icon > favicon candidates[0]. The
 * default `{}` means this parameter is always safe to omit (fail-safe, M1 behavior).
 *
 * CTL-1208: also computes `mark: ProjectMark` for each repo — the discriminated union
 * render sites branch on (glyph | favicon | none). `serverIconByRepo` is now the
 * primary channel for server-persisted glyph refs.
 */
export function useRepoIcons(
  repos: readonly string[],
  serverIconByRepo: Record<string, string | null | undefined> = {},
): RepoIconMap {
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
  // Use repos.join(",") — same stabilization as the effect — so an inline []
  // fallback (new reference each render) doesn't bust the memo every tick.
  const reposKey = repos.join(",");
  return useMemo(() => {
    const out: RepoIconMap = {};
    for (const repo of repos) {
      const f = fetched[repo] ?? { candidates: [], defaultSelectedPath: null };
      const serverIcon = serverIconByRepo[repo] ?? null;
      // CTL-1153 (M2): server icon from projects[] feeds as the effectiveDefault
      // (precedence: localStorage pick > server icon > fetch defaultSelectedPath > candidates[0])
      const effectiveDefault = serverIcon ?? f.defaultSelectedPath;
      const { autoDataUrl, selectedPath } = resolveEffectiveIcon(
        f.candidates,
        effectiveDefault,
        picks[repo],
      );
      // CTL-1208: compute the discriminated mark for render sites.
      const mark = resolveProjectMark({
        serverIcon,
        pick: picks[repo],
        candidates: f.candidates,
        defaultSelectedPath: f.defaultSelectedPath,
      });
      out[repo] = {
        autoDataUrl,
        candidates: f.candidates,
        selectedPath,
        override: readIconOverride(repo),
        mark,
      };
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reposKey, fetched, picks, serverIconByRepo]);
}
