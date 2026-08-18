/** "needs_review" -> "needs review" — for human-readable state and enum labels. */
export function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

/** Renders an ISO timestamp as a stable, locale-independent "date time (UTC)". */
export function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
