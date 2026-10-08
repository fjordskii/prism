// In-memory fixed-window counters keyed by an arbitrary string (client IP + site).
// One Fly machine serves Prism, so process memory is the right scope; a restart
// resets the windows, which only ever errs toward letting traffic through.
export function windowCounter(limit: number, windowMs: number) {
  let windowStart = Date.now();
  let counts = new Map<string, number>();
  return {
    // Counts one hit for `key`; returns false once the key is over `limit` this window.
    hit(key: string): boolean {
      const now = Date.now();
      if (now - windowStart >= windowMs) {
        windowStart = now;
        counts = new Map();
      }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= limit;
    },
    // True while `key` is still within `limit` (does not count a hit).
    under(key: string): boolean {
      if (Date.now() - windowStart >= windowMs) return true;
      return (counts.get(key) ?? 0) < limit;
    },
  };
}

// Fly's edge sets Fly-Client-IP (and overwrites any client-sent value). Off Fly,
// fall back to the first X-Forwarded-For hop, then a shared bucket.
export function clientIp(header: (n: string) => string | undefined): string {
  return header("fly-client-ip") ?? header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
