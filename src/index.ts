#!/usr/bin/env bun

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === undefined || cmd === "--help" || cmd === "-h") {
  const { default: run } = await import("./commands/help.ts");
  run();
} else {
  let mod: { default: (args: string[]) => unknown };
  try {
    mod = (await import(`./commands/${cmd}.ts`)) as typeof mod;
  } catch {
    console.error(`Unknown command: ${cmd}`);
    console.error("Try: tool --help");
    process.exit(1);
  }
  await mod.default(argv.slice(1));
}
