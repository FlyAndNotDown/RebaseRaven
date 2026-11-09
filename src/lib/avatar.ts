export function avatarSeed(name: string, email: string): string {
  return name.trim() || email.trim() || "user";
}

export function avatarInitial(seed: string): string {
  const letter = seed.match(/\p{L}|\p{N}/u)?.[0] ?? "?";
  return letter.toUpperCase();
}

export function avatarHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

// A short set of muted tones, so neighboring authors don't land on clashing hues.
const AVATAR_COLORS = [
  "#3e4e66",
  "#3c5f59",
  "#6a4b38",
  "#53466a",
  "#455a3c",
  "#3b5570",
  "#6a424c",
  "#514c39",
];

export function avatarColor(seed: string): string {
  return AVATAR_COLORS[avatarHue(seed) % AVATAR_COLORS.length];
}

export type AvatarProvider = "builtin" | "github" | "gitlab";
export type GitAvatarProvider = "auto" | AvatarProvider;

export function resolveGitAvatarProvider(choice: GitAvatarProvider, remotes: readonly {name:string; url:string|null; pushUrl?:string|null}[]): AvatarProvider {
  if (choice !== "auto") return choice;
  const remote = remotes.find(remote => remote.name === "origin") ?? remotes[0];
  const value = (remote?.url ?? remote?.pushUrl)?.trim();
  if (!value) return "builtin";
  try {
    const scp = !value.includes("://") ? /^([^/\\:]+):(.+)$/.exec(value) : null;
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(url.protocol) || url.pathname.split("/").filter(Boolean).length < 2) return "builtin";
    switch (url.hostname.toLowerCase()) {
      case "github.com": return "github";
      case "gitlab.com": return "gitlab";
      default: return "builtin";
    }
  } catch { return "builtin"; }
}

interface AvatarJob {
  key: string;
  repoPath: string;
  provider: AvatarProvider;
  email: string;
  generation: number;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
}

/** Small shared queue: virtual rows with the same author share a single request. */
export function createAvatarLoader(
  fetch: (provider: AvatarProvider, email: string, repoPath: string) => Promise<string | null>,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { data: string | null; expires: number }>();
  const pending = new Map<string, AvatarJob>();
  const queue: AvatarJob[] = [];
  let policy = "";
  let generation = 0;
  let active = 0;

  function configure(next: string) {
    if (policy === next) return;
    policy = next;
    generation += 1;
    entries.clear();
    pending.clear();
    for (const job of queue.splice(0)) job.resolve(null);
  }

  function remember(email: string, data: string | null) {
    entries.delete(email);
    entries.set(email, { data, expires: now() + (data ? 6 * 60 * 60_000 : 15 * 60_000) });
    let bytes = [...entries.values()].reduce((total, value) => total + (value.data?.length ?? 0), 0);
    while (entries.size > 128 || bytes > 4 * 1_048_576) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      bytes -= entries.get(oldest)?.data?.length ?? 0;
      entries.delete(oldest);
    }
  }

  function pump() {
    while (active < 2 && queue.length > 0) {
      const job = queue.shift()!;
      active += 1;
      void Promise.resolve().then(() => fetch(job.provider, job.email, job.repoPath)).catch(() => null).then((data) => {
        const current = job.generation === generation;
        const safe = data && data.length <= 90_000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(data) ? data : null;
        if (current) remember(job.key, safe);
        job.resolve(current ? safe : null);
      }).finally(() => {
        active -= 1;
        if (pending.get(job.key) === job) pending.delete(job.key);
        pump();
      });
    }
  }

  return {
    configure,
    get(next: AvatarProvider, address: string, repoPath = ""): Promise<string | null> {
      const email = address.trim().toLowerCase();
      if (next === "builtin" || email.length > 254 || !/^[a-z0-9._+%-]+@[a-z0-9.-]+$/i.test(email)) return Promise.resolve(null);
      const key = `${next}:${email}`;
      const cached = entries.get(key);
      if (cached && cached.expires > now()) {
        entries.delete(key);
        entries.set(key, cached);
        return Promise.resolve(cached.data);
      }
      const existing = pending.get(key);
      if (existing) return existing.promise;
      if (queue.length >= 64) return Promise.resolve(null);
      let resolve!: AvatarJob["resolve"];
      const promise = new Promise<string | null>((done) => { resolve = done; });
      const job = { key, repoPath, provider: next, email, generation, promise, resolve };
      pending.set(key, job);
      queue.push(job);
      pump();
      return promise;
    },
  };
}
