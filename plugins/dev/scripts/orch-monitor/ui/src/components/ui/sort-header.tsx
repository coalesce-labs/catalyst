import { cn } from "@/lib/utils";
import type { SortState } from "@/hooks/use-sort";

export function SortHeader<K extends string = string>({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  const indicator = active ? (sort.dir === "asc" ? " \u25B2" : " \u25BC") : "";

  return (
    <th
      className={cn(
        "px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted cursor-pointer hover:text-fg transition-colors",
        align === "right" && "text-right",
        "group",
      )}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active ? (
        <span className="ml-0.5">{indicator}</span>
      ) : (
        <span className="ml-0.5 opacity-0 group-hover:opacity-40 transition-opacity">
          {"\u25BC"}
        </span>
      )}
    </th>
  );
}
