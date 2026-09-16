import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { App } from "@slack/bolt";
import { slackifyMarkdown } from "slackify-markdown";
import { ClaudeProcess } from "./claude-process.js";
import { PermissionHandler, PermissionRequest, PermissionDecision } from "./permission-handler.js";

// --- Config ---
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const PERMISSION_PORT = parseInt(process.env.PERMISSION_PORT || "19276", 10);
const IDLE_TIMEOUT_MS =
  parseInt(process.env.IDLE_TIMEOUT_MINUTES || "30", 10) * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
// Post every intermediate assistant text block (inter-tool preamble like
// "Now wiring it up...") in addition to the final message. Off by default:
// in Slack nothing posts until the turn ends, so those lines arrive as
// retrospective narration glued onto the front of the answer. Kept as an
// opt-in diagnostic.
const POST_INTERMEDIATE_TEXT = /^(1|true|yes|on)$/i.test(
  process.env.POST_INTERMEDIATE_TEXT || ""
);
// Slack renders this as "<App> is working..." in the thread. Verified to work
// in an ordinary channel thread with only chat:write — no assistant:write and
// no AI-App reconfiguration required.
const WORKING_STATUS = process.env.WORKING_STATUS || "is working...";
// A background task that finishes long after the thread went quiet may produce
// an unprompted reply. Only speak into threads a human touched recently, so a
// months-old thread can never be resurrected by a stranded task.
const UNPROMPTED_CUTOFF_MS =
  parseInt(process.env.UNPROMPTED_CUTOFF_DAYS || "7", 10) * 24 * 60 * 60 * 1000;
// Backstop for the "never reap a working thread" rule. A turn that wedges, or
// a background task whose terminal notification never arrives, would otherwise
// pin its subprocess forever and walk the box into swap. Past this much total
// silence a thread is reaped whatever it claims to be doing.
const MAX_WORKING_MS =
  parseInt(process.env.MAX_WORKING_HOURS || "4", 10) * 60 * 60 * 1000;
const STATE_FILE_PATH =
  process.env.BRIDGE_STATE_FILE ||
  path.join(process.env.HOME || "/tmp", ".slack-claude-bridge-state.json");
const UPLOADS_DIR =
  process.env.BRIDGE_UPLOADS_DIR ||
  path.join(process.env.HOME || "/tmp", ".slack-claude-bridge-uploads");

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
  return base.length > 0 ? base : "upload";
}

// --- State ---
// Keyed by thread_ts. We keep the subprocess AND the last-known session_id so
// that after an idle kill (or a bridge restart) the next message to the thread
// can transparently `--resume`.
interface ThreadState {
  process: ClaudeProcess | null;
  sessionId: string | null;
  lastActivityAt: number;
  // Last time a human posted here. Gates unprompted replies (see
  // UNPROMPTED_CUTOFF_MS); distinct from lastActivityAt, which Claude's own
  // event traffic keeps bumping.
  lastUserMessageAt: number;
  // Needed to post a reply nobody asked for — there is no incoming Slack
  // event to read the channel off at that point.
  channelId: string | null;
  // Background tasks started but not yet reported terminal. A thread with any
  // outstanding task is working, however quiet the event stream looks.
  pendingTasks: Set<string>;
  // Assistant text accumulated for the turn currently in flight.
  textBlocks: string[];
  // Set while a user-initiated turn is awaiting its result.
  waiter: ((text: string) => void) | null;
  // True between the first event of a turn and its result.
  working: boolean;
}
const threads = new Map<string, ThreadState>();

// On-disk persistence: we survive bridge restarts by writing thread_ts ->
// sessionId pairs to a JSON file. The `process` field is always null after
// restart; the idle-resume path will spawn a fresh subprocess on next message.
function loadPersistedThreads(): void {
  try {
    const raw = readFileSync(STATE_FILE_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [threadTs, sessionId] of Object.entries(data)) {
      if (typeof sessionId !== "string" || !sessionId) continue;
      threads.set(threadTs, {
        process: null,
        sessionId,
        lastActivityAt: Date.now(),
        lastUserMessageAt: 0, // unknown across restarts; see touchThread()
        channelId: null,
        pendingTasks: new Set(),
        textBlocks: [],
        waiter: null,
        working: false,
      });
    }
    console.log(
      `[bot] Loaded ${threads.size} thread(s) from ${STATE_FILE_PATH}`
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log(`[bot] No persisted state at ${STATE_FILE_PATH} (first run)`);
    } else {
      console.error(`[bot] Failed to load persisted state:`, err);
    }
  }
}

function persistThreads(): void {
  const data: Record<string, string> = {};
  for (const [threadTs, state] of threads) {
    if (state.sessionId) data[threadTs] = state.sessionId;
  }
  try {
    mkdirSync(path.dirname(STATE_FILE_PATH), { recursive: true });
    writeFileSync(STATE_FILE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[bot] Failed to persist state:`, err);
  }
}
// Track which channel+thread is active (for permission requests and image sends)
let activeThread: { channelId: string; threadTs: string } | null = null;
const chatLocks = new Map<string, Promise<void>>();
let cachedBotUserId: string | null = null;

async function getBotUserId(): Promise<string> {
  if (!cachedBotUserId) {
    const result = await app.client.auth.test();
    cachedBotUserId = result.user_id!;
  }
  return cachedBotUserId;
}

function withChatLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(key, next);
  return next;
}

// --- Slack App (Socket Mode) ---
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

function isAllowed(channelId: string): boolean {
  if (ALLOWED_CHANNEL_IDS.size === 0) return false;
  return ALLOWED_CHANNEL_IDS.has(channelId);
}

/** Get (creating if needed) the state for a thread, recording the channel. */
function touchThread(threadTs: string, channelId: string | null): ThreadState {
  let state = threads.get(threadTs);
  if (!state) {
    state = {
      process: null,
      sessionId: null,
      lastActivityAt: Date.now(),
      lastUserMessageAt: 0,
      channelId,
      pendingTasks: new Set(),
      textBlocks: [],
      waiter: null,
      working: false,
    };
    threads.set(threadTs, state);
  }
  if (channelId) state.channelId = channelId;
  return state;
}

function getOrSpawnClaude(threadTs: string, channelId?: string): ClaudeProcess {
  const state = touchThread(threadTs, channelId ?? null);
  state.lastActivityAt = Date.now();

  if (state.process && state.process.isRunning) return state.process;

  const cp = new ClaudeProcess();
  const s = state;
  s.process = cp;

  // ONE collector per subprocess, registered at spawn and never removed.
  //
  // The subprocess is a long-lived stream that can run SEVERAL turns off a
  // single user message: when a background task finishes, Claude Code re-inits
  // in the same process and runs another turn. The old per-message listener
  // detached on the first result, so every later turn was collected by nobody
  // and its answer was lost. Owning the stream here means each result has
  // exactly one owner — handed to a waiting user turn if there is one, posted
  // unprompted if there is not — so nothing is dropped and nothing double-posts.
  cp.on("event", (event: Record<string, unknown>) => {
    // Any traffic from Claude keeps the thread active for idle-timeout purposes.
    s.lastActivityAt = Date.now();
    const subtype = event.subtype as string | undefined;

    if (event.type === "system" && subtype === "init" && event.session_id) {
      const newSid = event.session_id as string;
      if (s.sessionId !== newSid) {
        s.sessionId = newSid;
        persistThreads();
      }
    }

    // Track outstanding background work. A task runs silently between its
    // start and its terminal notification, so this set — not the event
    // stream — is what tells the idle sweep the thread is still busy.
    if (event.type === "system" && typeof event.task_id === "string") {
      if (subtype === "task_started") s.pendingTasks.add(event.task_id);
      else if (subtype === "task_notification") s.pendingTasks.delete(event.task_id);
    }

    if (event.type === "assistant") {
      const msg = event.message as
        | { content?: Array<{ type: string; text?: string }> }
        | undefined;
      for (const block of msg?.content ?? []) {
        if (block.type === "text" && block.text) s.textBlocks.push(block.text);
      }
    }

    // Show "Clank is working..." as soon as a turn starts producing anything,
    // whether a human asked for it or a background task triggered it.
    if (!s.working && (event.type === "assistant" || subtype === "init")) {
      s.working = true;
      setWorkingStatus(s.channelId, threadTs);
    }

    if (event.type === "result") handleResult(threadTs, s, event);
  });

  cp.on("exit", () => {
    const sid = s.sessionId ? ` (sessionId=${s.sessionId})` : "";
    console.log(`[bot] Claude process for thread ${threadTs} exited${sid}`);
    // Keep the ThreadState so the next message auto-resumes via --resume, but
    // drop everything scoped to the dead process. Stale pendingTasks would
    // make the thread look permanently busy on resume, and stale textBlocks
    // would leak the last turn's prose into the next one.
    if (s.process === cp) s.process = null;
    s.pendingTasks.clear();
    s.textBlocks = [];
    if (s.working) {
      s.working = false;
      clearWorkingStatus(s.channelId, threadTs);
    }
  });

  const resumeFrom = s.sessionId ?? undefined;
  if (resumeFrom) {
    console.log(`[bot] Resuming thread ${threadTs} from sessionId=${resumeFrom}`);
  }
  cp.spawn(resumeFrom);
  return cp;
}

function sweepIdleThreads(): void {
  const now = Date.now();
  for (const [threadTs, state] of threads) {
    if (!state.process || !state.process.isRunning) continue;
    if (now - state.lastActivityAt < IDLE_TIMEOUT_MS) continue;
    // Quiet is not the same as idle. A background task emits nothing between
    // its start and its terminal notification, and a turn mid-tool-call can
    // be silent for minutes — killing either loses work that was still
    // running. Only reap a thread that is genuinely doing nothing.
    const quietMs = now - state.lastActivityAt;
    const busy =
      state.working || state.pendingTasks.size > 0 || state.waiter !== null;
    if (busy && quietMs < MAX_WORKING_MS) {
      console.log(
        `[bot] Thread ${threadTs} quiet ${Math.round(quietMs / 60000)}m but ` +
          `still working (${state.pendingTasks.size} background task(s), ` +
          `turn ${state.working ? "in flight" : "idle"}) — not reaping.`
      );
      continue;
    }
    if (busy) {
      console.warn(
        `[bot] Thread ${threadTs} claimed busy but silent for ` +
          `${Math.round(quietMs / 60000)}m — reaping anyway (backstop).`
      );
    }
    const idleMin = Math.round((now - state.lastActivityAt) / 60000);
    console.log(
      `[bot] Idle ${idleMin}m — killing process for thread ${threadTs} (sessionId=${state.sessionId}); next message will resume.`
    );
    state.process.kill();
    // The "exit" handler nulls state.process. sessionId is preserved.
  }
}

/**
 * Convert Claude's CommonMark output to Slack's mrkdwn dialect.
 * Safe on plain text (no-op-ish for messages without markdown syntax).
 */
function toSlackMrkdwn(text: string): string {
  try {
    let result = slackifyMarkdown(text).trimEnd();
    // Collapse <url|url> where href and display text are identical — Slack
    // auto-links bare URLs, so the redundant link syntax just causes issues
    // (the | can get URL-encoded to %7C, producing a garbled link).
    result = result.replace(/<(https?:\/\/[^|>]+)\|\1>/g, "$1");
    return result;
  } catch {
    return text;
  }
}

/**
 * Post a message in a thread.
 */
function sayInThread(channelId: string, threadTs: string) {
  return async (text: string) => {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: toSlackMrkdwn(text),
    });
  };
}

/**
 * Show / clear Slack's native working indicator for a thread.
 *
 * assistant.threads.setStatus renders "<App> is working..." inline in the
 * thread. It replaces the old :eyes: reaction plus blinking-hourglass
 * heartbeat, which existed only because this was believed to need the
 * assistant:write scope. It does not: chat:write is enough, and it works in
 * an ordinary channel thread. It also needs no message to anchor to, which is
 * what makes it usable for a turn no human triggered.
 *
 * Best-effort throughout: a failed status update must never break a turn.
 */
function setWorkingStatus(channelId: string | null, threadTs: string): void {
  if (!channelId) return;
  app.client.apiCall("assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status: WORKING_STATUS,
  }).catch(() => {});
}

function clearWorkingStatus(channelId: string | null, threadTs: string): void {
  if (!channelId) return;
  app.client.apiCall("assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status: "",
  }).catch(() => {});
}

/**
 * Resolve one completed turn: hand it to a waiting user request, or — when no
 * one is waiting, i.e. a background task produced it — post it into the thread.
 */
function handleResult(
  threadTs: string,
  s: ThreadState,
  event: Record<string, unknown>
): void {
  // A resumed session emits a no-op result BEFORE the real turn: the CLI
  // flushes the background-task notifications orphaned by the idle kill as a
  // zero-work turn (num_turns 0, duration 0, empty result), then re-inits and
  // runs the message we sent. Treating it as the answer posts "(No response
  // from Claude)" over the top of a turn that has not started yet.
  if (event.num_turns === 0 && s.textBlocks.length === 0) {
    console.log("[bot] Ignoring no-op result from resumed session");
    return;
  }

  const collected = s.textBlocks.join("\n\n");
  s.textBlocks = [];
  s.working = false;
  clearWorkingStatus(s.channelId, threadTs);

  let text: string;
  if (event.is_error === true) {
    text =
      (event.error as string) || (event.result as string) || "An error occurred.";
    if (text.includes("authenticate") || text.includes("401")) {
      console.error("[bot] Auth error detected, killing subprocess");
      s.process?.kill();
    }
  } else {
    const resultText = (event.result as string) || "";
    // The `result` event carries the final assistant message. Prefer it:
    // `collected` also holds every inter-tool preamble line from the turn,
    // which on a long agentic run buries the answer.
    text = POST_INTERMEDIATE_TEXT
      ? collected || resultText
      : resultText || collected;
  }

  const waiter = s.waiter;
  if (waiter) {
    s.waiter = null;
    waiter(text);
    return;
  }

  // Nobody is waiting: this turn was triggered by a background task finishing.
  if (!text) return;
  const quietFor = Date.now() - s.lastUserMessageAt;
  if (!s.channelId || s.lastUserMessageAt === 0 || quietFor > UNPROMPTED_CUTOFF_MS) {
    console.log(
      `[bot] Suppressing unprompted reply in thread ${threadTs} ` +
        `(no human message for ${Math.round(quietFor / 86400000)}d, ` +
        `cutoff ${UNPROMPTED_CUTOFF_MS / 86400000}d)`
    );
    return;
  }
  console.log(`[bot] Posting unprompted reply in thread ${threadTs}`);
  postChunked(sayInThread(s.channelId, threadTs), text).catch((err) =>
    console.error("[bot] Failed to post unprompted reply:", err)
  );
}

const MAX_SLACK_LEN = 3900;

async function postChunked(
  say: (msg: string) => Promise<unknown>,
  text: string
): Promise<void> {
  let remaining = text;
  while (remaining.length > 0) {
    await say(remaining.slice(0, MAX_SLACK_LEN));
    remaining = remaining.slice(MAX_SLACK_LEN);
  }
}

/**
 * Wait for the turn a user message kicked off. The collector in
 * getOrSpawnClaude owns the stream and resolves this via s.waiter.
 */
function awaitTurn(s: ThreadState, cp: ClaudeProcess): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      cp.removeListener("exit", onExit);
      resolve(text);
    };
    const onExit = () => {
      // No result event on an unexpected exit, so whatever was collected is
      // the only record of what happened.
      const collected = s.textBlocks.join("\n\n");
      s.textBlocks = [];
      s.waiter = null;
      s.working = false;
      finish(collected || "(Claude process exited unexpectedly)");
    };
    s.waiter = finish;
    cp.once("exit", onExit);
  });
}

// --- Permission Handler ---
const permissionHandler = new PermissionHandler(
  PERMISSION_PORT,
  async (request: PermissionRequest) => {
    const thread = activeThread;
    if (!thread) {
      console.error("[bot] No active thread for permission request", request.id);
      return;
    }

    let inputLines: string;
    if (typeof request.toolInput === "object" && request.toolInput !== null) {
      inputLines = Object.entries(request.toolInput)
        .map(([key, value]) => {
          let valStr: string;
          if (typeof value === "string") {
            valStr = value.length > 300 ? value.slice(0, 300) + "..." : value;
          } else {
            valStr = JSON.stringify(value);
          }
          return `*${key}:* ${valStr}`;
        })
        .join("\n");
    } else {
      inputLines = String(request.toolInput);
    }

    const truncatedInput =
      inputLines.length > 2000 ? inputLines.slice(0, 2000) + "\n..." : inputLines;

    await app.client.chat.postMessage({
      channel: thread.channelId,
      thread_ts: thread.threadTs,
      text: `Permission Request: ${request.toolName}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Permission Request*\n\n*Tool:* \`${request.toolName}\`\n\n${truncatedInput}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Allow" },
              style: "primary",
              action_id: "perm_allow",
              value: request.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Session" },
              action_id: "perm_allowSession",
              value: request.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Always" },
              action_id: "perm_alwaysAllow",
              value: request.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              action_id: "perm_deny",
              value: request.id,
            },
          ],
        },
      ],
    });
  }
);

// --- Permission Button Handlers ---
const permActionIds: Record<string, PermissionDecision> = {
  perm_allow: "allow",
  perm_allowSession: "allowSession",
  perm_alwaysAllow: "alwaysAllow",
  perm_deny: "deny",
};

for (const [actionId, decision] of Object.entries(permActionIds)) {
  app.action(actionId, async ({ action, ack, respond }) => {
    await ack();

    const requestId = (action as { value: string }).value;
    const resolved = permissionHandler.resolvePermission(requestId, decision);

    const labels: Record<PermissionDecision, string> = {
      allow: "Allowed",
      allowSession: "Allowed (session)",
      alwaysAllow: "Always allowed",
      deny: "Denied",
    };
    const label = labels[decision] || decision;

    if (resolved) {
      await respond({ text: `${label}`, replace_original: true });
    } else {
      await respond({ text: "Request expired or already handled", replace_original: true });
    }
  });
}

// --- Handle messages ---
app.message(async ({ message }) => {
  if (message.subtype) return;
  if (!("text" in message) || !message.text) return;
  if (!("channel" in message)) return;

  const channelId = message.channel;
  if (!isAllowed(channelId)) return;

  const msg = message as typeof message & { ts: string; thread_ts?: string };
  const text = message.text;

  if (msg.thread_ts) {
    // Reply in an existing thread — only handle if it's one of our threads
    // (process may be idle-killed; resume kicks in when we send the message).
    if (!threads.has(msg.thread_ts)) return;
    const say = sayInThread(channelId, msg.thread_ts);
    await handleClaudeInteraction(channelId, msg.thread_ts, msg.ts, text, say);
  } else {
    // Top-level message — only respond if @mentioned
    const botUserId = await getBotUserId();
    if (!text.includes(`<@${botUserId}>`)) return;

    // Use this message's ts as the thread
    const threadTs = msg.ts;
    const say = sayInThread(channelId, threadTs);
    await handleClaudeInteraction(channelId, threadTs, msg.ts, text, say);
  }
});

// --- Handle file uploads (images inline, other files saved to disk) ---
app.event("message", async ({ event }) => {
  const msg = event as unknown as Record<string, unknown>;
  if (msg.subtype !== "file_share") return;
  if (!msg.channel || !isAllowed(msg.channel as string)) return;

  const files = msg.files as Array<Record<string, unknown>> | undefined;
  if (!files || files.length === 0) return;

  const channelId = msg.channel as string;
  const threadTs = (msg.thread_ts as string) || (msg.ts as string);

  // For top-level file shares, only handle if bot is mentioned
  if (!msg.thread_ts) {
    const botUserId = await getBotUserId();
    const text = (msg.text as string) || "";
    if (!text.includes(`<@${botUserId}>`)) return;
  } else {
    // In a thread, only handle if it's one of our threads (may be idle-killed).
    if (!threads.has(threadTs)) return;
  }

  const userText = (msg.text as string) || "";
  const images: Array<{ base64: string; mediaType: string }> = [];
  const savedFiles: string[] = [];

  for (const file of files) {
    const mimetype = (file.mimetype as string) || "";
    const downloadUrl = file.url_private_download as string;
    if (!downloadUrl) continue;

    try {
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const buffer = Buffer.from(await res.arrayBuffer());
      if (mimetype.startsWith("image/")) {
        images.push({ base64: buffer.toString("base64"), mediaType: mimetype });
      } else {
        const filename = sanitizeFilename((file.name as string) || "upload");
        const destDir = path.join(UPLOADS_DIR, threadTs);
        await mkdir(destDir, { recursive: true });
        const destPath = path.join(destDir, filename);
        await writeFile(destPath, buffer);
        savedFiles.push(destPath);
        console.log(`[bot] Saved upload (${mimetype || "?"}) -> ${destPath}`);
      }
    } catch (err) {
      console.error("[bot] Error downloading file:", err);
    }
  }

  if (images.length === 0 && savedFiles.length === 0) return;

  let caption = userText;
  if (!caption && images.length > 0 && savedFiles.length === 0) {
    caption = "Describe this image.";
  }
  if (savedFiles.length > 0) {
    const list = savedFiles.map((p) => `- ${p}`).join("\n");
    const noun = savedFiles.length === 1 ? "file" : "files";
    const note = `[Slack upload: ${noun} saved to disk at:\n${list}]`;
    caption = caption ? `${caption}\n\n${note}` : note;
  }

  const say = sayInThread(channelId, threadTs);
  const messageTs = msg.ts as string;
  await handleClaudeInteraction(
    channelId,
    threadTs,
    messageTs,
    caption,
    say,
    images.length > 0 ? images : undefined,
  );
});

// --- Helper: send message to Claude and post response ---
async function handleClaudeInteraction(
  channelId: string,
  threadTs: string,
  messageTs: string,
  text: string,
  say: (msg: string) => Promise<unknown>,
  images?: Array<{ base64: string; mediaType: string }>,
): Promise<void> {
  withChatLock(threadTs, async () => {
    activeThread = { channelId, threadTs };
    const state = touchThread(threadTs, channelId);
    state.lastUserMessageAt = Date.now();
    // Show "Clank is working..." immediately — users need a sign of life
    // before Claude's first event arrives.
    state.working = true;
    setWorkingStatus(channelId, threadTs);
    try {
      const claude = getOrSpawnClaude(threadTs, channelId);
      claude.sendMessage(text, images);

      const finalResult = await awaitTurn(state, claude);
      if (finalResult.length === 0) {
        await say("(No response from Claude)");
      } else {
        await postChunked(say, finalResult);
      }
      await app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: "white_check_mark",
      }).catch(() => {});
    } catch (err) {
      console.error("[bot] Error in Claude interaction:", err);
      await say("Error processing message.").catch(() => {});
    } finally {
      state.waiter = null;
      state.working = false;
      clearWorkingStatus(channelId, threadTs);
      activeThread = null;
    }
  });
}

// --- Start ---
async function main() {
  loadPersistedThreads();
  await permissionHandler.start();

  permissionHandler.setSendImageHandler(async (imagePath, caption) => {
    const thread = activeThread;
    if (!thread) {
      console.error("[bot] No active thread for image send");
      return;
    }
    const fileData = await readFile(imagePath);
    await app.client.filesUploadV2({
      channel_id: thread.channelId,
      thread_ts: thread.threadTs,
      file: fileData,
      filename: imagePath.split("/").pop() || "image.png",
      initial_comment: caption || undefined,
    });
    console.log("[bot] sent image to thread", thread.threadTs, ":", imagePath);
  });

  const idleSweep = setInterval(sweepIdleThreads, IDLE_SWEEP_MS);
  idleSweep.unref();

  await app.start();
  console.log(
    `[bot] Slack bot is running! (idle timeout = ${IDLE_TIMEOUT_MS / 60000}m)`
  );
}

process.on("SIGINT", () => {
  console.log("\n[bot] Shutting down...");
  permissionHandler.stop();
  for (const [, state] of threads) {
    if (state.process) state.process.kill();
  }
  process.exit(0);
});

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
