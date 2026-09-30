/**
 * Terminal output arrives as arbitrary byte chunks that split mid-character and
 * mid-escape-sequence, contain carriage-return progress bars, and never end with
 * a newline. A naive `chunk.split('\n')` implementation loses data at every one of
 * those boundaries. This is a small state machine that reconstructs logical lines.
 */
import { StringDecoder } from 'node:string_decoder';

// Both need the `g` flag: a single line routinely carries several sequences
// (colour set, colour reset, cursor move) and stripping only the first one
// leaks escape bytes into rule matching and into what gets logged.
const CSI = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-Z\\-_]/g;

export function stripAnsi(s) {
  return s.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '');
}

/** Spinner / progress-bar churn. Dropped rather than surfaced as findings. */
function isProgressFrame(s) {
  const t = s.trim();
  if (t === '') return false;
  if (/^[█▓▒░#=\-_.·|/\\]{3,}$/.test(t)) return true;
  if (/^\d{1,3}\s*%$/.test(t)) return true;
  if (/^\d+(\.\d+)?\s*(B|kB|KB|MB|GB|TB|kB\/s|MB\/s|it|s)\b/i.test(t)) return true;
  if (/^(downloading|downloaded|fetching|installing|compiling|building|resolving|extracting)\b/i.test(t)) return true;
  return false;
}

export class LineSplitter {
  #dec = new StringDecoder('utf8');
  #buf = '';
  #max;

  constructor({ maxLineBytes = 64 * 1024 } = {}) {
    this.#max = maxLineBytes;
  }

  /**
   * Feed a Buffer (or string) chunk, get back an array of complete logical lines.
   * The trailing partial line is retained internally until its newline arrives.
   */
  push(chunk) {
    this.#buf += typeof chunk === 'string' ? chunk : this.#dec.write(chunk);
    const out = [];

    let idx;
    while ((idx = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      out.push(...finalizeLine(line));
    }

    // Bound memory if a program emits a huge run with no newline at all.
    if (this.#buf.length > this.#max) {
      out.push(...finalizeLine(this.#buf.slice(0, this.#max)).map((l) => l + ' [truncated]'));
      this.#buf = this.#buf.slice(this.#max);
    }
    return out;
  }

  /** Flush the retained partial line and any incomplete multibyte sequence. */
  flush() {
    this.#buf += this.#dec.end();
    const rest = this.#buf;
    this.#buf = '';
    return rest.length ? finalizeLine(rest) : [];
  }
}

/**
 * One physical line may contain several writes separated by \r. A carriage return
 * means "rewrite the current line", so only the final state is real content --
 * keeping earlier frames would resurrect every spinner tick as a phantom line.
 * If the final state is itself progress churn, the run carries no information and
 * is dropped. A trailing lone \r is a cursor reset, so it preserves what precedes.
 */
function finalizeLine(raw) {
  const withoutEol = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const segments = stripAnsi(withoutEol).split('\r');

  if (segments.length === 1) return [segments[0]];

  const last = segments[segments.length - 1];
  if (isProgressFrame(last)) return [];

  if (last.length > 0) return [last];
  // Trailing \r after real content: the content is still on screen.
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i].length > 0) return [segments[i]];
  }
  return [''];
}

/**
 * Secret shapes redacted before anything reaches disk. Deliberately over-eager:
 * leaking a token costs far more than a mangled log line.
 */
const SECRET_RULES = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<redacted:aws-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '<redacted:github-token>'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '<redacted:api-key>'],
  [/\b(?:sk-ant|xox[baprs])-[A-Za-z0-9_-]{10,}\b/g, '<redacted:api-token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted:jwt>'],
  [/\b([0-9a-f]{64})\b/g, '<redacted:hash>'],
];

// The negative lookahead stops this rule from re-redacting an existing
// `<redacted:...>` placeholder produced by an earlier rule, which would strip
// the label and leave a bare `<redacted>`.
const KV_SECRET =
  /\b((?:password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[=:]\s*)(?!<redacted)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;}\]]{4,})/gi;

const AUTH_HEADER = /(\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token)\s+)([^\s"']{6,})/gi;

export function redact(s) {
  let out = s;
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  out = out.replace(KV_SECRET, (_m, prefix) => `${prefix}<redacted>`);
  out = out.replace(AUTH_HEADER, (_m, prefix) => `${prefix}<redacted>`);
  return out;
}
