import { serve } from "bun";
import { discordWebhooks } from "./server";
import { handleGithubWebhook } from "./sync/github";

const port = process.env.PORT || 3000;

const server = serve({
  port: parseInt(String(port)),
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/discord") && discordWebhooks) {
      return discordWebhooks(req as any);
    }

    if (url.pathname === "/github/webhook") {
      return handleGithubWebhook(req);
    }

    console.warn(`Unknown path requested: ${url.pathname}`);
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`Server running on port ${port}`);
