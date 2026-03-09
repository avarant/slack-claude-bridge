import "dotenv/config";
import { readFile } from "node:fs/promises";
import { App } from "@slack/bolt";
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

// --- State ---
const claudeProcesses = new Map<string, ClaudeProcess>();
let activeChannelId: string | null = null;
const chatLocks = new Map<string, Promise<void>>();

function withChatLock(channelId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(channelId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(channelId, next);
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

function getOrSpawnClaude(channelId: string, resumeSessionId?: string): ClaudeProcess {
  let cp = claudeProcesses.get(channelId);
  if (cp && cp.isRunning && !resumeSessionId) return cp;

  if (cp && cp.isRunning) {
    cp.kill();
  }

  cp = new ClaudeProcess();
  claudeProcesses.set(channelId, cp);

  cp.on("exit", () => {
    console.log(`[bot] Claude process for channel ${channelId} exited`);
  });

  cp.spawn(resumeSessionId);
  return cp;
}

/**
 * Collect full response text from Claude events (no streaming).
 */
function collectResponse(claude: ClaudeProcess): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];

    const onEvent = (event: Record<string, unknown>) => {
      if (event.type === "assistant") {
        const msg = event.message as {
          content?: Array<{ type: string; text?: string }>;
        } | undefined;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              chunks.push(block.text);
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
          if (chunks.length === 0) chunks.push(errText);
        }
        resolve(chunks.join(""));
      }
    };

    const onExit = () => {
      claude.removeListener("event", onEvent);
      resolve(chunks.join("") || "(Claude process exited unexpectedly)");
    };

    claude.on("event", onEvent);
    claude.once("exit", onExit);
  });
}

// --- Permission Handler ---
const permissionHandler = new PermissionHandler(
  PERMISSION_PORT,
  async (request: PermissionRequest) => {
    const channelId = activeChannelId;
    if (!channelId) {
      console.error("[bot] No active channel for permission request", request.id);
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
      channel: channelId,
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

// --- Slash Commands ---
app.command("/new", async ({ command, ack }) => {
  await ack();
  const channelId = command.channel_id;
  if (!isAllowed(channelId)) return;

  const existing = claudeProcesses.get(channelId);
  if (existing) {
    existing.kill();
    claudeProcesses.delete(channelId);
  }
  permissionHandler.clearSessionRules();
  await app.client.chat.postMessage({
    channel: channelId,
    text: "Session cleared. Send a message to start a new one.",
  });
});

app.command("/status", async ({ command, ack }) => {
  await ack();
  const channelId = command.channel_id;
  if (!isAllowed(channelId)) return;

  const cp = claudeProcesses.get(channelId);
  const running = cp?.isRunning ?? false;
  const sessionId = cp?.getSessionId();
  const status = running
    ? `Claude is running (session: \`${sessionId || "unknown"}\`)`
    : "No active Claude session in this channel.";
  await app.client.chat.postMessage({ channel: channelId, text: status });
});

// --- Handle messages ---
app.message(async ({ message, say }) => {
  // Only handle regular user messages
  if (message.subtype) return;
  if (!("text" in message) || !message.text) return;
  if (!("channel" in message)) return;

  const channelId = message.channel;
  if (!isAllowed(channelId)) return;

  const text = message.text;
  await handleClaudeInteraction(channelId, text, say);
});

// --- Handle file uploads (images) ---
app.event("message", async ({ event, say }) => {
  const msg = event as unknown as Record<string, unknown>;
  if (msg.subtype !== "file_share") return;
  if (!msg.channel || !isAllowed(msg.channel as string)) return;

  const files = msg.files as Array<Record<string, unknown>> | undefined;
  if (!files || files.length === 0) return;

  const channelId = msg.channel as string;
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
    await handleClaudeInteraction(channelId, caption, say, images);
  }
});

// --- Helper: send message to Claude and post response ---
async function handleClaudeInteraction(
  channelId: string,
  text: string,
  say: (msg: string) => Promise<unknown>,
  images?: Array<{ base64: string; mediaType: string }>,
): Promise<void> {
  withChatLock(channelId, async () => {
    activeChannelId = channelId;
    try {
      const claude = getOrSpawnClaude(channelId);
      claude.sendMessage(text, images);

      const response = await collectResponse(claude);

      if (response) {
        // Slack has a 4000 char limit per message — split if needed
        const maxLen = 3900;
        if (response.length <= maxLen) {
          await say(response);
        } else {
          let remaining = response;
          while (remaining.length > 0) {
            const chunk = remaining.slice(0, maxLen);
            remaining = remaining.slice(maxLen);
            await say(chunk);
          }
        }
      } else {
        await say("(No response from Claude)");
      }
    } catch (err) {
      console.error("[bot] Error in Claude interaction:", err);
      await say("Error processing message.").catch(() => {});
    } finally {
      activeChannelId = null;
    }
  });
}

// --- Start ---
async function main() {
  await permissionHandler.start();

  // Register image sending handler
  permissionHandler.setSendImageHandler(async (imagePath, caption) => {
    if (!activeChannelId) {
      console.error("[bot] No active channel for image send");
      return;
    }
    const fileData = await readFile(imagePath);
    await app.client.filesUploadV2({
      channel_id: activeChannelId,
      file: fileData,
      filename: imagePath.split("/").pop() || "image.png",
      initial_comment: caption || undefined,
    });
    console.log("[bot] sent image to channel", activeChannelId, ":", imagePath);
  });

  await app.start();
  console.log("[bot] Slack bot is running!");
}

process.on("SIGINT", () => {
  console.log("\n[bot] Shutting down...");
  permissionHandler.stop();
  for (const [, cp] of claudeProcesses) {
    cp.kill();
  }
  process.exit(0);
});

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
