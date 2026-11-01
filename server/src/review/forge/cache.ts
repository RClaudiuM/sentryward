// A small in-process cache for forge reads whose answer is fixed by a commit
// sha: a file at a revision, and a change's diff between two shas. Reruns and
// re-reviews of the same head then skip the forge calls. Anything that can
// change without a new commit (title, description, labels, draft state) is
// never cached. `review.disableCache` turns it off for a repository.
//
// Every job on a worker shares one cache, and an entry ranges from a few bytes
// (a compare result) to many megabytes (a 3,000-file change with patches), so
// a count limit alone does not bound memory. Entries are also limited by their
// approximate size in total, and a value too large for one entry is returned
// without being stored.

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60_000;

interface Entry {
  value: unknown;
  expiresAt: number;
  // Approximate size, so eviction can keep the total under `maxBytes`.
  size: number;
}

export interface ForgeCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

// Cached values are JSON from forge APIs (or strings and arrays of them), so
// the serialized length tracks their in-memory size closely enough for a
// limit. A value that cannot be serialized is treated as too large to cache.
function approximateSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export class ForgeCache {
  // A Map iterates in insertion order, so re-inserting on read makes the
  // first key the least recently used.
  private entries = new Map<string, Entry>();
  private totalBytes = 0;
  private maxEntries: number;
  private maxBytes: number;
  private maxEntryBytes: number;
  private ttlMs: number;
  private now: () => number;

  constructor(options: ForgeCacheOptions = {}) {
    // A negative entry limit would keep the eviction loop running once the
    // cache is empty, so limits below zero mean "store nothing".
    this.maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxEntryBytes = Math.min(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES, this.maxBytes);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  // Concurrent misses for the same key each fetch; the last one wins. Jobs for
  // the same head are deduplicated by the queue, so this is rare and harmless.
  async memo<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value as T;
    }
    this.remove(key);
    const value = await fetch();
    // Removed again after the await: a concurrent miss may have stored the key
    // meanwhile, and its size must not stay counted once this value replaces it.
    this.remove(key);
    const size = approximateSize(value);
    if (size > this.maxEntryBytes) return value;
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, size });
    this.totalBytes += size;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
    return value;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.size;
  }
}

// Fetches straight through when there is no cache, so callers need not branch.
export function cached<T>(cache: ForgeCache | undefined, key: string, fetch: () => Promise<T>): Promise<T> {
  return cache ? cache.memo(key, fetch) : fetch();
}

export function cacheKey(...parts: (string | number)[]): string {
  return JSON.stringify(parts);
}

// The worker's cache, shared by every job it runs.
export const forgeCache = new ForgeCache();
