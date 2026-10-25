import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_JOURNAL_FILES = 200;
const MAX_JOURNAL_ENTRY_BYTES = 256 * 1024;
const MAX_JOURNAL_RESULTS = 100;

/**
 * Read a bounded journal snapshot for the local control center.
 *
 * Applier journal filenames begin with a base-36 timestamp, so lexical order
 * retains the newest candidate files. Oversized/corrupt entries are omitted:
 * this is an observability snapshot and must not make the health UI unavailable.
 */
export function readJournal(dataDir, projectRoot, limit = MAX_JOURNAL_RESULTS) {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, MAX_JOURNAL_RESULTS))
    : MAX_JOURNAL_RESULTS;
  const dir = join(dataDir, 'journal');
  let files = [];
  try {
    files = readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .sort()
      .slice(-MAX_JOURNAL_FILES);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of files) {
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > MAX_JOURNAL_ENTRY_BYTES) continue;
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (!entry || typeof entry !== 'object') continue;

      let target = null;
      if (typeof entry.abs === 'string') {
        const rel = relative(projectRoot, resolve(entry.abs));
        target = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
          ? '[outside project]'
          : rel;
      }
      entries.push({
        id: String(entry.id || name.replace(/\.json$/i, '')),
        at: entry.at || null,
        outcome: entry.outcome || 'unknown',
        type: entry.type || 'unknown',
        target,
        source: entry.source || null,
        txOutcome: entry.txOutcome || null,
        reason: typeof entry.why === 'string' ? entry.why.slice(0, 240) : null
      });
    } catch {
      // A corrupt entry must not make the authenticated health snapshot unavailable.
    }
  }
  return entries
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-boundedLimit)
    .reverse();
}
