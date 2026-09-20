// Deterministic, dependency-free hashing and stable serialization.
// Node identity must never depend on Math.random / Date / object insertion order.

export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** JSON with recursively sorted object keys, so equal data always hashes equal. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function digest(parts: unknown[]): string {
  return fnv1a32(stableStringify(parts));
}

export function shortHash(value: string): string {
  return fnv1a32(value).slice(0, 6);
}
