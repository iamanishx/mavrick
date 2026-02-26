import { serve } from "bun";
import { discordWebhooks } from "./server";

const port = process.env.PORT || 3000;

const server = serve({
  port: parseInt(String(port)),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/discord") && discordWebhooks) {
      return discordWebhooks(req as any);
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`Server running on port ${port}`);
