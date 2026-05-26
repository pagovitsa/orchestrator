export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function tomlString(value) {
  return JSON.stringify(String(value));
}

export function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}
