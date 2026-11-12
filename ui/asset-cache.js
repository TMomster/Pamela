// 每次运行对每个资源只读取一次的缓存。
// Pamela — one read per asset per run.
// 清空缓存后下一次运行重新从磁盘读取。
/**
 * Builds a cache over a reader.
 *
 * @param {(path: string, kind?: string) => Promise<string>} read
 *   Resolves one project-relative path to the URL the webview can use. The kind
 *   names the `assets/` folder a bare name is resolved inside, and is part of
 *   the cache key: the same bare name under two kinds is two different files.
 *   It is injected rather than imported so this module never touches the IPC
 *   bridge, and so a test can watch how many times it was called.
 * @param {number} [options.limit]
 *   How many paths stay cached. A run can walk a long story and ask for more
 *   pictures than the window shows at once; keeping every one holds every
 *   decoded image in memory for the rest of the run.
 * @returns {{ resolve: (path: string, kind?: string) => Promise<string>,
 *   clear: () => void, size: () => number }}
 */

export function createAssetCache(read, { limit = 32 } = {}) {
  const entries = new Map();
  /** Reads that have not landed yet; they never occupy an LRU slot. */
  const pending = new Map();
  let generation = 0;
  const capacity = Math.max(1, Math.trunc(Number(limit) || 32));

  return {
    /**
     * Answers the URL for `path`, reading it the first time.
     *
     * A failed read is dropped rather than kept: the next call should try
     * again, since the file may have been put there in the meantime — and a
     * cached rejection would make a file that now exists unreadable for the
     * rest of the run.
     */
    resolve(path, kind = "") {
      // The same file written with backslashes, a leading `./` or stray spaces
      // is one read, not four: the host normalises those too.
      const name = String(path ?? "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^(?:\.\/)+/, "");
      // A path that already starts with `assets/` ignores `kind` on the host,
      // so the kind must not split it into a second copy of a large data URL.
      const keyKind = name.startsWith("assets/") ? "" : kind;
      const key = keyKind ? `${keyKind}:${name}` : name;
      const cached = entries.get(key);
      if (cached) {
        // Refresh the insertion order: the map behaves as a small LRU, so the
        // picture the current scene keeps asking for is not evicted first.
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const waiting = pending.get(key);
      if (waiting) {
        return waiting;
      }
      const readOnce = Promise.resolve().then(() => read(name, kind));
      const startedAt = generation;
      pending.set(key, readOnce);
      readOnce.then(
        () => {
          pending.delete(key);
          // A read that was in flight across a `clear()` belongs to the old run.
          if (startedAt !== generation) {
            return;
          }
          entries.set(key, readOnce);
          while (entries.size > capacity) {
            entries.delete(entries.keys().next().value);
          }
        },
        () => {
          pending.delete(key);
        },
      );
      return readOnce;
    },

    /** Clears every cached asset, so the next run reads them from disk again. */
    clear() {
      generation += 1;
      entries.clear();
      pending.clear();
    },

    /** How many paths are cached; a test's window into the cache's growth. */
    size() {
      return entries.size;
    },
  };
}
