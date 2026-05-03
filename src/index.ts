#!/usr/bin/env bun

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === undefined || cmd === "--help" || cmd === "-h") {
  const { default: run } = await import("./commands/help.ts");
  run();
} else {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(`./commands/${cmd}.ts`)) as { default: (...args: any[]) => unknown };
    mod.default(argv.slice(1));
  } catch {
    console.error(`Unknown command: ${cmd}`);
    console.error("Try: tool --help");
    process.exit(1);
  }
}
