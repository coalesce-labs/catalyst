// repo-icon-context.tsx — one icon fetch per app, shared to every board surface (CTL-998, CTL-1208).
import { createContext, useContext, useMemo } from "react";
import { useRepoIcons, type RepoIconMap } from "@/hooks/use-repo-icons";
import { useProjects } from "@/hooks/use-projects";

const RepoIconContext = createContext<RepoIconMap>({});

export function RepoIconProvider({
  repos,
  children,
}: {
  repos: readonly string[];
  children: React.ReactNode;
}) {
  // CTL-1208: thread server icon field (favicon path or glyph ref) into useRepoIcons
  // so server-persisted icons render across clients without re-fetch.
  const { projects } = useProjects();
  const serverIconByRepo = useMemo(() => {
    const map: Record<string, string | null | undefined> = {};
    for (const p of projects) {
      map[p.repo] = p.icon ?? null;
    }
    return map;
  }, [projects]);

  const icons = useRepoIcons(repos, serverIconByRepo);
  return <RepoIconContext.Provider value={icons}>{children}</RepoIconContext.Provider>;
}

/** The shared repo-icon map. Returns {} when no provider is mounted (fail-open). */
export function useRepoIconMap(): RepoIconMap {
  return useContext(RepoIconContext);
}
