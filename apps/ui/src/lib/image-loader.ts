// Share requests between galleries and prefetching, and bound host traffic.
export function createImageLoader(
  fetchImage: (id: string) => Promise<string>,
  {
    concurrency = 4,
    attempts = 3,
    maxEntries = 32,
    maxBytes = 16 * 1024 * 1024,
    pause = (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, attempt * 250)),
  } = {},
) {
  const images = new Map<string, Promise<string>>();
  const completed = new Map<string, number>();
  let retainedBytes = 0;
  function retain(id: string, value: string) {
    // Conservative UTF-16 accounting also bounds base64 data URIs. Mounted images
    // keep their own strings; eviction only releases the loader's reference.
    const bytes = value.length * 2;
    completed.set(id, bytes);
    retainedBytes += bytes;
    while (completed.size > maxEntries || retainedBytes > maxBytes) {
      const oldest = completed.keys().next().value;
      if (oldest === undefined) break;
      retainedBytes -= completed.get(oldest) ?? 0;
      completed.delete(oldest);
      images.delete(oldest);
    }
  }
  const waiting: (() => void)[] = [];
  let active = 0;
  async function request(id: string) {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      // Retries depend on the preceding failure; concurrent attempts would duplicate host traffic.
      // oxlint-disable no-await-in-loop
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fetchImage(id);
        } catch (error) {
          if (attempt >= attempts) throw error;
          await pause(attempt);
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }
  const load = (id: string): Promise<string> => {
    const existing = images.get(id);
    if (existing) {
      const bytes = completed.get(id);
      if (bytes !== undefined) {
        completed.delete(id);
        completed.set(id, bytes);
      }
      return existing;
    }
    const pending = request(id)
      .then((value) => {
        if (images.get(id) === pending) retain(id, value);
        return value;
      })
      .catch((error: unknown) => {
        if (images.get(id) === pending) images.delete(id);
        throw error;
      });
    images.set(id, pending);
    return pending;
  };
  return Object.assign(load, {
    clear() {
      images.clear();
      completed.clear();
      retainedBytes = 0;
    },
  });
}
