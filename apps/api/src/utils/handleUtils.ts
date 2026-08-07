// apps/api/src/utils/handleUtils.ts

/**
 * Normalize a handle: trim, lowercase, replace spaces with hyphens,
 * remove invalid characters. This is a conservative normalizer; adjust
 * to your product slug rules.
 */
export function normalizeHandle(raw: string): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-") // spaces -> hyphen
    .replace(/[^a-z0-9-_]/g, "") // allow only a-z0-9 - _
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

/**
 * Validate handle against business rules: non-empty, length limits,
 * and allowed pattern. Returns true when valid.
 */
export function validateHandle(handle: string): boolean {
  if (!handle) return false;
  if (handle.length < 2 || handle.length > 100) return false;
  // allow letters, numbers, hyphen, underscore
  return /^[a-z0-9-_]+$/.test(handle);
}
