# Local project transactions

The desktop host and Node MCP/CLI store use the same coordination protocol. This applies to cooperating DraftMatter processes on one machine and a local filesystem. It does not replace the collaboration service's database transactions.

## Shared lock

Each operation publishes a unique `.draftmatter/write-locks/<pid>-<uuid>.json` claim. Its first atomic version has `choosing: true` and ticket zero. The process then publishes `choosing: false` with a ticket greater than every observed ticket. Entry waits for all choosing processes and every lower `(ticket, uuid)` pair. Atomic replacement must never temporarily remove a claim; the Windows implementation uses `MoveFileExW` with replacement and write-through flags.

Claims belonging to dead processes can be removed by their unique pathname. A living process's claim is never stolen because it is old. A fifteen-second wait returns an actionable busy/conflict error without modifying manuscript files. Rust supports nested guards on the same thread; Node uses unlocked private reads within one guarded operation. Expected revisions/hashes are checked after acquiring the shared lock.

Manuscript, bibliography, project configuration, citation transactions, AI project setup, execution manifests, and worktree-changing Git operations use this lock. Short kernel artifact preparation/finalization phases use it; a kernel does not hold it while computing. Trusted kernel code and external editors still run with their ordinary filesystem permissions.

## Durable transaction format

New multi-file transactions live in `.draftmatter/transactions/v2-<uuid>/`. Before any target is replaced, the writer:

1. Creates an explicit `owner.json` marker identifying the DraftMatter schema.
2. Flushes complete backup and staged files.
3. Atomically writes and flushes `manifest.json` with `schemaVersion: 2`, `engine: "draftmatter"`, `state: "prepared"`, and every target's backup name plus before/after SHA-256 hashes.

After replacing and flushing every target, it atomically publishes `state: "committed"`. Successful transactions and completed rollbacks retain no manuscript copies. A crash before that commit marker rolls the entire transaction back at the next guarded opening/read/write, whether that operation comes from Node or Rust. A crash after the marker keeps the committed files and only removes the journal.

Recovery validates all targets and backups before its first replacement. Backups are copied, not consumed, so recovery can itself be interrupted and resumed. If a target contains bytes matching neither its before nor after hash, recovery preserves both the current file and backups and reports the conflict. It never silently replaces an external edit with an old backup.

Coordination paths reject links, traversal, Git metadata, and writes into the lock/recovery namespaces. Claims, manifests, transaction file counts, directory entries, and aggregate backup bytes are bounded before reading untrusted payloads. Completed journal retention is zero; unresolved evidence is never pruned to satisfy a retention budget. POSIX parent directories are fsynced along with files. Windows flushes files and uses atomic replacements; power-loss durability also depends on the filesystem and storage device.

## Complete collaboration checkpoints

The explicit owner checkpoint uses one `save_collaboration_checkpoint` operation for the manuscript, shared images, and optional CSL JSON bibliography. It validates all baseline hashes and path collisions under the shared lock before replacing any target. A new resource requires a null baseline (the file must still be absent); an existing resource requires its exact baseline. Manuscript/bibliography fingerprints use the existing native FNV-1a byte hash; images use SHA-256 over their raw bytes, shared with `projectAssetHash` in the desktop adapter. A checkpoint accepts at most 128 PNG/JPEG/GIF/WebP/SVG figures, 2 MiB per figure, and 20 MiB total. Private metadata and Git paths are refused.

## Older journals

Legacy citation journals remain recoverable by the desktop host. Node refuses an unfinished legacy citation transaction and directs the user to desktop recovery. Old AI journals did not identify a process owner or share a lock; unfinished ones therefore stop opening with an explicit recovery error while preserving all backup/staging evidence. Unknown journals are preserved. Close older clients before upgrading; they do not participate in the new locking protocol.

## Verification

`src/agentProjectStore.test.ts` uses independent Node processes for revision races and abrupt `SIGKILL` interruption before commit, during recovery, after the durable commit marker, and after a commit-marker rename whose finalization reports an error. Native tests in `src-tauri/src/project_transactions.rs` kill real Rust and Node writers between replacements and verify recovery by the other implementation, mutual exclusion, and native expected-hash revalidation. These tests also check confined staging, preservation of external edits/foreign journals, and bounded completed retention.
