# Dashboard snapshot resource bounds

The authenticated local dashboard's /api/snapshot endpoint reads persisted findings and the daemon log for observability. These reads are deliberately bounded so a large or replaced local file cannot make a health snapshot allocate or parse unbounded data.

## Findings

- At most 4 MiB is read across findings.jsonl.1 and findings.jsonl.
- At most 2 MiB is read from either file.
- Individual JSONL records larger than 64 KiB are omitted.
- At most 2,000 records per rotated file are parsed before deduplication.
- The active file is processed after the rotated file, so its latest lifecycle record wins for a repeated signature.
- When a file exceeds its byte budget, only its bounded tail is considered; the first partial line is discarded.

## Daemon log and data-directory names

- The dashboard reads at most the last 64 KiB of daemon.log.
- It returns at most 80 complete lines, each truncated to 4,096 characters.
- The data-directory inventory enumerates at most 100 names.

## File identity and failure behavior

Snapshot readers use a regular-file descriptor, compare device/inode identity with the path before and after opening, and use O_NOFOLLOW/O_NONBLOCK where supported. Symlinks, FIFOs, non-regular files, replaced paths, unreadable files and malformed records are omitted. Reads are performed through the opened descriptor, not by reopening the path.

This is a best-effort observability snapshot, not a complete forensic export. If a file exceeds its bound or is invalid, older or malformed records may be absent. The health endpoint remains available; the dashboard must not interpret an omitted record as proof that no incident occurred.

Journal snapshots have a separate aggregate/per-entry bound tracked in the gateway integration work; this document does not claim that the journal reader is covered by these findings/log limits.
