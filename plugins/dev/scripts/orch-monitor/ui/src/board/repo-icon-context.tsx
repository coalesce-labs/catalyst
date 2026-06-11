// repo-icon-context.tsx — one icon fetch per app, shared to every board surface (CTL-998).
import { createContext, useContext } from "react";
import { useRepoIcons, type RepoIconMap } from "@/hooks/use-repo-icons";

const RepoIconContext = createContext<RepoIconMap>({});

export function RepoIconProvider({
  repos,
  children,
}: {
  repos: readonly string[];
  children: React.ReactNode;
}) {
  const icons = useRepoIcons(repos);
  return <RepoIconContext.Provider value={icons}>{children}</RepoIconContext.Provider>;
}

/** The shared repo-icon map. Returns {} when no provider is mounted (fail-open). */
export function useRepoIconMap(): RepoIconMap {
  return useContext(RepoIconContext);
}
