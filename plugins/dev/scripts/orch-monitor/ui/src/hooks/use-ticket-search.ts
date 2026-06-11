import { useEffect, useState } from "react";
import type { TicketSearchResultLike } from "@/lib/ticket-search-items";

export function useTicketSearch(query: string): { results: TicketSearchResultLike[]; loading: boolean } {
  const [results, setResults] = useState<TicketSearchResultLike[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data: { results?: TicketSearchResultLike[] }) => setResults(data.results ?? []))
        .catch(() => { /* aborted or network error — leave prior results */ })
        .finally(() => setLoading(false));
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  return { results, loading };
}
