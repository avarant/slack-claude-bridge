// Who sent a message, as Claude sees it.
//
// Each message Claude receives starts with a sender prefix:
//
//   [from Jane Doe (jane@example.com) <@U0123ABCD>]   name and email resolved
//   [from Jane Doe <@U0123ABCD>]                      name only (no users:read.email)
//   [from <@U0123ABCD>]                               lookup failed or not permitted
//
// The <@ID> is always last before the bracket, exactly as in the ID-only form,
// so a deployment that maps IDs to people keeps working. Display names are
// self-set in Slack: good for conversation, not a trusted identity — the ID is.

export interface UserInfo {
  name?: string;
  email?: string;
}

// Resolves a Slack user ID. Rejects on any failure (missing scope included).
export type UserLookup = (userId: string) => Promise<UserInfo>;

const MAX_NAME = 64;

// Display names are user-controlled text that lands in Claude's prompt. Strip
// anything that could end the prefix early or start a line of its own:
// control characters and newlines, and the bracket characters the prefix and
// Slack mentions are built from.
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[[\]<>()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(s);
  if (chars.length > MAX_NAME) s = chars.slice(0, MAX_NAME).join("") + "…";
  return s;
}

// An email is shown only when it looks like one; anything else is dropped.
export function sanitizeEmail(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  return s.length <= 254 && /^[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]+$/.test(s) ? s : "";
}

export function formatSender(userId: string, info?: UserInfo): string {
  const name = sanitizeName(info?.name);
  if (!name) return `[from <@${userId}>]`;
  const email = sanitizeEmail(info?.email);
  return email ? `[from ${name} (${email}) <@${userId}>]` : `[from ${name} <@${userId}>]`;
}

interface Entry {
  info?: UserInfo;
  at: number;
  failed: boolean;
}

export interface DirectoryOptions {
  ttlMs?: number;
  failTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

// Caches lookups per user: an hour for a hit, ten minutes for a failure, so a
// missing scope is not rediscovered on every message. A lookup never holds a
// message up for more than timeoutMs; one that finishes later still fills the
// cache for next time.
export class SenderDirectory {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<void>>();
  private ttlMs: number;
  private failTtlMs: number;
  private timeoutMs: number;
  private now: () => number;

  constructor(private lookup: UserLookup, opts: DirectoryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.failTtlMs = opts.failTtlMs ?? 10 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  async prefix(userId: string): Promise<string> {
    return formatSender(userId, await this.resolve(userId));
  }

  private async resolve(userId: string): Promise<UserInfo | undefined> {
    const cached = this.entries.get(userId);
    const ttl = cached?.failed ? this.failTtlMs : this.ttlMs;
    if (cached && this.now() - cached.at < ttl) return cached.info;

    let pending = this.inflight.get(userId);
    if (!pending) {
      pending = this.fetch(userId, cached?.info);
      this.inflight.set(userId, pending);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.timeoutMs);
    });
    await Promise.race([pending, timeout]);
    clearTimeout(timer);
    // Before the lookup lands, fall back to whatever was known (possibly
    // stale, possibly nothing): a slow API must not delay the message.
    return this.entries.get(userId)?.info ?? cached?.info;
  }

  private async fetch(userId: string, previous?: UserInfo): Promise<void> {
    try {
      const info = await this.lookup(userId);
      this.entries.set(userId, { info, at: this.now(), failed: false });
    } catch {
      // Keep a stale name over none: a transient failure should not make a
      // known sender anonymous for ten minutes.
      this.entries.set(userId, { info: previous, at: this.now(), failed: true });
    } finally {
      this.inflight.delete(userId);
    }
  }
}
