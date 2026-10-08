// Share requests between galleries and prefetching, and bound host traffic.
export function createImageLoader(
  fetchImage: (id: string) => Promise<string>,
  {
    concurrency = 4,
    attempts = 3,
    pause = (attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, attempt * 250)),
  } = {},
) {
  const images = new Map<string, Promise<string>>();
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
  return (id: string): Promise<string> => {
    const existing = images.get(id);
    if (existing) return existing;
    const pending = request(id).catch((error: unknown) => {
      images.delete(id);
      throw error;
    });
    images.set(id, pending);
    return pending;
  };
}
