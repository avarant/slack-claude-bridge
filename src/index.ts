import "dotenv/config";
import { readFile } from "node:fs/promises";
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
const STATE_FILE_PATH =
  process.env.BRIDGE_STATE_FILE ||
  path.join(process.env.HOME || "/tmp", ".slack-claude-bridge-state.json");

// --- State ---
// Keyed by thread_ts. We keep the subprocess AND the last-known session_id so
// that after an idle kill (or a bridge restart) the next message to the thread
// can transparently `--resume`.
interface ThreadState {
  process: ClaudeProcess | null;
  sessionId: string | null;
  lastActivityAt: number;
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

function getOrSpawnClaude(threadTs: string): ClaudeProcess {
  let state = threads.get(threadTs);
  if (!state) {
    state = { process: null, sessionId: null, lastActivityAt: Date.now() };
    threads.set(threadTs, state);
  }
  state.lastActivityAt = Date.now();

  if (state.process && state.process.isRunning) return state.process;

  const cp = new ClaudeProcess();
  const s = state;
  s.process = cp;

  cp.on("event", (event: Record<string, unknown>) => {
    // Any traffic from Claude keeps the thread active for idle-timeout purposes.
    s.lastActivityAt = Date.now();
    if (
      event.type === "system" &&
      (event as Record<string, unknown>).subtype === "init" &&
      event.session_id
    ) {
      const newSid = event.session_id as string;
      if (s.sessionId !== newSid) {
        s.sessionId = newSid;
        persistThreads();
      }
    }
  });

  cp.on("exit", () => {
    const sid = s.sessionId ? ` (sessionId=${s.sessionId})` : "";
    console.log(`[bot] Claude process for thread ${threadTs} exited${sid}`);
    // Keep the ThreadState so the next message auto-resumes via --resume.
    if (s.process === cp) s.process = null;
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
    return slackifyMarkdown(text).trimEnd();
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
 * Collect response from Claude, posting intermediate text to the thread.
 * Returns the final result text.
 */
/**
 * Drive a request/response cycle and stream assistant text to Slack as it
 * arrives. Returns:
 *   - `null` when streaming already handled the response (caller should post nothing)
 *   - a string when the caller should post it (errors, or edge cases where
 *     Claude exited without streaming anything)
 */
function collectResponse(
  claude: ClaudeProcess,
  say: (text: string) => Promise<unknown>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let finalResult = "";
    let streamedText = false;

    const onEvent = async (event: Record<string, unknown>) => {
      if (event.type === "assistant") {
        const msg = event.message as {
          content?: Array<{ type: string; text?: string }>;
        } | undefined;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              streamedText = true;
              await say(block.text).catch(() => {});
            }
          }
        }
      } else if (event.type === "result") {
        claude.removeListener("event", onEvent);
        claude.removeListener("exit", onExit);
        if ((event as Record<string, unknown>).is_error === true) {
          const errText = (event as Record<string, unknown>).error as string ||
                          (event as Record<string, unknown>).result as string ||
                          "An error occurred.";
          finalResult = errText;
          if (errText.includes("authenticate") || errText.includes("401")) {
            console.error("[bot] Auth error detected, killing subprocess");
            claude.kill();
          }
          resolve(finalResult);
        } else {
          const resultText =
            ((event as Record<string, unknown>).result as string) || "";
          // If we already streamed assistant text, the result event is a
          // duplicate of what Slack saw. Signal "nothing to post" with null.
          resolve(streamedText ? null : resultText);
        }
      }
    };

    const onExit = () => {
      claude.removeListener("event", onEvent);
      if (streamedText) {
        resolve(null);
      } else {
        resolve(finalResult || "(Claude process exited unexpectedly)");
      }
    };

    claude.on("event", onEvent);
    claude.once("exit", onExit);
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

// --- Handle file uploads (images) ---
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

  const caption = (msg.text as string) || "Describe this image.";
  const images: Array<{ base64: string; mediaType: string }> = [];

  for (const file of files) {
    const mimetype = file.mimetype as string || "";
    if (!mimetype.startsWith("image/")) continue;

    const downloadUrl = file.url_private_download as string;
    if (!downloadUrl) continue;

    try {
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const buffer = Buffer.from(await res.arrayBuffer());
      images.push({ base64: buffer.toString("base64"), mediaType: mimetype });
    } catch (err) {
      console.error("[bot] Error downloading file:", err);
    }
  }

  if (images.length > 0) {
    const say = sayInThread(channelId, threadTs);
    const messageTs = msg.ts as string;
    await handleClaudeInteraction(channelId, threadTs, messageTs, caption, say, images);
  }
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
    try {
      await app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: "eyes",
      }).catch(() => {});

      const claude = getOrSpawnClaude(threadTs);
      claude.sendMessage(text, images);

      const finalResult = await collectResponse(claude, say);

      // null = streaming already delivered the response; nothing more to post.
      // String = either an error, a no-stream result, or the exit-fallback
      // message — post it (chunked if long).
      if (finalResult !== null) {
        if (finalResult.length === 0) {
          await say("(No response from Claude)");
        } else {
          const maxLen = 3900;
          let remaining = finalResult;
          while (remaining.length > 0) {
            const chunk = remaining.slice(0, maxLen);
            remaining = remaining.slice(maxLen);
            await say(chunk);
          }
        }
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
