import { createHmac, timingSafeEqual } from "crypto";
import { repoDb } from "../tools/db";

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function verifySignature(payload: string, signature: string | null, secret: string | undefined): boolean {
  if (!secret) {
    return true;
  }
  if (!signature) {
    return false;
  }

  const digest = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, digestBuffer);
}

function truncate(text: string, max = 800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function formatDiscordMessage(eventName: string, payload: any): string {
  const repoName = payload?.repository?.full_name || "unknown/repo";

  if (eventName === "issue_comment" && payload?.issue?.pull_request) {
    const pr = payload.issue.number;
    const user = payload.comment?.user?.login || "unknown";
    const body = truncate(payload.comment?.body || "");
    return `GitHub comment on ${repoName} PR #${pr} by ${user}\n\n${body}`;
  }

  if (eventName === "pull_request_review_comment") {
    const pr = payload.pull_request?.number;
    const user = payload.comment?.user?.login || "unknown";
    const body = truncate(payload.comment?.body || "");
    return `GitHub review comment on ${repoName} PR #${pr} by ${user}\n\n${body}`;
  }

  if (eventName === "pull_request_review") {
    const pr = payload.pull_request?.number;
    const user = payload.review?.user?.login || "unknown";
    const state = payload.review?.state || "submitted";
    const body = truncate(payload.review?.body || "");
    if (body) {
      return `GitHub review on ${repoName} PR #${pr} by ${user} (${state})\n\n${body}`;
    }
    return `GitHub review on ${repoName} PR #${pr} by ${user} (${state})`;
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request?.number;
    const action = payload.action || "updated";
    const user = payload.sender?.login || "unknown";
    return `GitHub PR event on ${repoName} PR #${pr}: ${action} by ${user}`;
  }

  return `GitHub event on ${repoName}: ${eventName}`;
}

async function postToDiscord(threadId: string, content: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    return;
  }

  await fetch(`https://discord.com/api/v10/channels/${threadId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

export async function handleGithubWebhook(req: Request): Promise<Response> {
  const eventName = req.headers.get("x-github-event") || "unknown";
  const delivery = req.headers.get("x-github-delivery") || createId("delivery");
  const signature = req.headers.get("x-hub-signature-256");
  const bodyText = await req.text();

  if (!verifySignature(bodyText, signature, process.env.GITHUB_WEBHOOK_SECRET)) {
    return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  if (!owner || !repo) {
    return new Response(JSON.stringify({ ok: true, ignored: "missing repository" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const repoConfig = repoDb.getRepo(owner, repo);
  if (!repoConfig) {
    return new Response(JSON.stringify({ ok: true, ignored: "repo not registered" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const activeRun = repoDb.findLatestActiveRunForRepo(repoConfig.id);
  const targetRun = activeRun || repoDb.findLatestRunForRepo(repoConfig.id);

  if (!targetRun) {
    return new Response(JSON.stringify({ ok: true, ignored: "no run found" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const tsUtc = payload?.comment?.updated_at
    || payload?.review?.submitted_at
    || payload?.pull_request?.updated_at
    || new Date().toISOString();

  repoDb.appendEvent({
    id: createId("evt"),
    runId: targetRun.id,
    eventType: `github.${eventName}`,
    source: "github",
    sourceRef: delivery,
    tsUtc,
    payload: bodyText,
  });

  const message = formatDiscordMessage(eventName, payload);
  const bindings = repoDb.getBindingsByRootRun(targetRun.root_run_id)
    .filter((binding) => binding.platform === "discord");

  for (const binding of bindings) {
    try {
      await postToDiscord(binding.thread_id, message);
      repoDb.appendEvent({
        id: createId("evt"),
        runId: targetRun.id,
        eventType: "discord.mirror.github",
        source: "discord",
        sourceRef: binding.thread_id,
        tsUtc: new Date().toISOString(),
        payload: JSON.stringify({ delivery, eventName, threadId: binding.thread_id }),
      });
    } catch (error) {
      repoDb.appendEvent({
        id: createId("evt"),
        runId: targetRun.id,
        eventType: "discord.mirror.github.failed",
        source: "discord",
        sourceRef: binding.thread_id,
        tsUtc: new Date().toISOString(),
        payload: JSON.stringify({
          delivery,
          eventName,
          threadId: binding.thread_id,
          error: (error as Error).message,
        }),
      });
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
