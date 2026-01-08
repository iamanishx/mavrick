import { Server, Probot } from "probot";
import app from "./index";

async function main() {
  const server = new Server({
    Probot: Probot.defaults({
      appId: process.env.APP_ID,
      privateKey: process.env.PRIVATE_KEY,
      secret: process.env.WEBHOOK_SECRET,
    }),
  });

  await server.load(app);
  
  const port = process.env.PORT || 3000;
  await server.start();
  console.log(`Server running on port ${port}`);
}

main().catch(console.error);
