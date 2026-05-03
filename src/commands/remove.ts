import { withDb } from "../clients/surreal.ts";

export default async function run(args: string[]): Promise<void> {
  const nameWithOwner = args.find((a) => !a.startsWith("--"));
  const purge = args.includes("--purge");
  const yes = args.includes("--yes");

  if (!nameWithOwner || !/^[^/]+\/[^/]+$/.test(nameWithOwner)) {
    console.error("✗ Usage: tool remove <owner/name> [--purge] [--yes]");
    process.exit(1);
  }

  await withDb(async (db) => {
    const [rows] = await db.query<
      [Array<{ id: unknown; registered_at: unknown }>]
    >(
      "SELECT id, registered_at FROM repo WHERE name_with_owner = $nameWithOwner",
      { nameWithOwner },
    );

    if (rows.length === 0) {
      console.error(`✗ repo not found: ${nameWithOwner}`);
      process.exit(1);
      return;
    }

    const row = rows[0];

    if (row.registered_at == null) {
      console.error(`✗ repo is not registered: ${nameWithOwner}`);
      process.exit(1);
      return;
    }

    const repoId = row.id;

    if (!purge) {
      await db.query(
        "UPDATE $id SET registered_at = NONE, last_synced_at = NONE",
        { id: repoId },
      );
      console.log(`✓ Unregistered ${nameWithOwner}`);
      return;
    }

    // --purge path: optionally confirm via stdin
    if (!yes) {
      process.stdout.write(
        `Purge mirrored data for ${nameWithOwner}? [y/N] `,
      );
      let confirmed = false;
      for await (const chunk of process.stdin) {
        const text = new TextDecoder()
          .decode(chunk as Uint8Array)
          .trim()
          .split("\n")[0];
        if (text === "y" || text === "Y") confirmed = true;
        break;
      }
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(0);
        return;
      }
    }

    // Soft-delete children
    let total = 0;

    const [issues] = await db.query<[Array<unknown>]>(
      "UPDATE issue SET deleted_at = time::now() WHERE repo = $repoId",
      { repoId },
    );
    total += issues.length;

    const [prs] = await db.query<[Array<unknown>]>(
      "UPDATE pull_request SET deleted_at = time::now() WHERE repo = $repoId",
      { repoId },
    );
    total += prs.length;

    const [discussions] = await db.query<[Array<unknown>]>(
      "UPDATE discussion SET deleted_at = time::now() WHERE repo = $repoId",
      { repoId },
    );
    total += discussions.length;

    const [commits] = await db.query<[Array<unknown>]>(
      "UPDATE commit SET deleted_at = time::now() WHERE repo = $repoId",
      { repoId },
    );
    total += commits.length;

    const [labels] = await db.query<[Array<unknown>]>(
      "UPDATE label SET deleted_at = time::now() WHERE repo = $repoId",
      { repoId },
    );
    total += labels.length;

    const [comments] = await db.query<[Array<unknown>]>(
      "UPDATE comment SET deleted_at = time::now() WHERE parent_issue.repo = $repoId OR parent_pr.repo = $repoId OR parent_discussion.repo = $repoId",
      { repoId },
    );
    total += comments.length;

    await db.query(
      "UPDATE $id SET registered_at = NONE, last_synced_at = NONE",
      { id: repoId },
    );

    console.log(
      `✓ Unregistered and purged ${nameWithOwner} (${total} rows tombstoned)`,
    );
  });
}
