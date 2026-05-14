/** Parse relative/absolute time specs like "24h", "7d", "30m", ISO dates. */
export function parseSinceSpec(raw: string): string | null {
  const match = raw.match(/^(\d+)\s*(h|m|s|d|hour|min|minute|second|day)s?$/i);
  if (match) {
    const n = parseInt(match[1] ?? "0", 10);
    const unit = (match[2] ?? "s").toLowerCase();
    const ms = unit.startsWith("d") ? n * 86400000
      : unit.startsWith("h") ? n * 3600000
      : unit.startsWith("m") ? n * 60000
      : n * 1000;
    return new Date(Date.now() - ms).toISOString();
  }
  // Try parsing as an ISO date/datetime string
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}
