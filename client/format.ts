export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null) return "";
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-opus-5-5[1m]" -> "Opus 5.5 1M". Other ids pass through. */
export function formatModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (!match) return model;
  const [, family, major, minor, longContext] = match;
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  return longContext ? `${name} 1M` : name;
}
