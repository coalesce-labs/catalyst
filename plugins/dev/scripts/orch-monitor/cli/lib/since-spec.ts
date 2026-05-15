/** Parse relative/absolute time specs like "24h", "7d", "30m", "2h30m", ISO dates.
 *  Accepts an optional leading "~" prefix (e.g. "~30m"). */
export function parseSinceSpec(raw: string): string | null {
  const s = raw.trim().replace(/^~\s*/, "");
  // Simple duration: "30m", "2h", "24h", "7d", "30s", "2hours", etc.
  const simple = s.match(/^(\d+)\s*(h|m|s|d|hour|min|minute|second|day)s?$/i);
  if (simple) {
    const n = parseInt(simple[1] ?? "0", 10);
    const unit = (simple[2] ?? "s").toLowerCase();
    const ms = unit.startsWith("d") ? n * 86400000
      : unit.startsWith("h") ? n * 3600000
      : unit.startsWith("m") ? n * 60000
      : n * 1000;
    return new Date(Date.now() - ms).toISOString();
  }
  // Compound duration: "2h30m", "1h15m30s", "30m15s", etc.
  const compound = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (compound && (compound[1] || compound[2] || compound[3])) {
    const h = parseInt(compound[1] ?? "0", 10);
    const m = parseInt(compound[2] ?? "0", 10);
    const sec = parseInt(compound[3] ?? "0", 10);
    return new Date(Date.now() - (h * 3600000 + m * 60000 + sec * 1000)).toISOString();
  }
  // Try parsing as an ISO date/datetime string
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}
