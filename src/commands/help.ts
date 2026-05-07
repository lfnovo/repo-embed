export default function run(): void {
  console.log("Usage: tool <command>");
  console.log("");
  console.log("Commands:");
  console.log("  add      Register a GitHub repo for mirroring (tool add owner/name)");
  console.log("  sync     Sync registered repos (tool sync owner/name [--full] [--reconcile] | tool sync --all [--full] [--reconcile])");
  console.log("  embed    Embed pending content (tool embed owner/name | tool embed --all)");
  console.log("  list     List registered repos (tool list [--json])");
  console.log("  remove   Unregister a repo (tool remove owner/name [--purge] [--yes])");
  console.log("  inspect  Inspect mirrored repo (tool inspect owner/name [--json] | tool inspect --all [--json])");
  console.log("  search   Semantic search across mirrored repos (tool search \"query\" [--repo owner/name] [--kind ...] [--limit N] [--json])");
  console.log("  help     Show this help message");
  process.exit(0);
}
