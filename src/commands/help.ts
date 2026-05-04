export default function run(): void {
  console.log("Usage: tool <command>");
  console.log("");
  console.log("Commands:");
  console.log("  add      Register a GitHub repo for mirroring (tool add owner/name)");
  console.log("  sync     Sync a registered repo (tool sync owner/name)");
  console.log("  list     List registered repos (tool list [--json])");
  console.log("  remove   Unregister a repo (tool remove owner/name [--purge] [--yes])");
  console.log("  inspect  Inspect a mirrored repo snapshot (tool inspect owner/name [--json])");
  console.log("  help     Show this help message");
  process.exit(0);
}
