import { bot } from "./bot.js";
import { config } from "./config.js";

async function main() {
  await bot.api.setMyCommands([
    { command: "start", description: "How to use MenuBot 使用說明" },
    { command: "help", description: "Help 說明" },
  ]);

  console.log(
    `MenuBot starting…\n` +
      `  model:   ${config.anthropic.model}\n` +
      `  publish: ${config.publish.baseUrl}/m/<slug>/`,
  );

  await bot.start({
    onStart: (me) => console.log(`Listening as @${me.username}`),
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
