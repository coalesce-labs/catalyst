import { useCallback, useState } from "react";

export type SortDir = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K;
  dir: SortDir;
}

export function useSort<K extends string>(
  defaultKey: K,
  defaultDir: SortDir = "asc",
): {
  sort: SortState<K>;
  toggleSort: (key: K) => void;
  sortFn: <T>(
    items: T[],
    accessor: (item: T, key: K) => string | number | null,
  ) => T[];
} {
  const [sort, setSort] = useState<SortState<K>>({
    key: defaultKey,
    dir: defaultDir,
  });

  const toggleSort = useCallback(
    (key: K) => {
      setSort((prev) =>
        prev.key === key
          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" },
      );
    },
    [],
  );

  const sortFn = useCallback(
    <T,>(
      items: T[],
      accessor: (item: T, key: K) => string | number | null,
    ): T[] => {
      const dir = sort.dir === "asc" ? 1 : -1;
      return [...items].sort((a, b) => {
        const av = accessor(a, sort.key);
        const bv = accessor(b, sort.key);

        const aNullish = av == null;
        const bNullish = bv == null;
        if (aNullish && bNullish) return 0;
        if (aNullish) return 1;
        if (bNullish) return -1;

        if (typeof av === "number" && typeof bv === "number") {
          return (av - bv) * dir;
        }

        const as = String(av).toLowerCase();
        const bs = String(bv).toLowerCase();
        if (as < bs) return -1 * dir;
        if (as > bs) return 1 * dir;
        return 0;
      });
    },
    [sort],
  );

  return { sort, toggleSort, sortFn };
}
