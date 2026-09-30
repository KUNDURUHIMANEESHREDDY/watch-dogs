/**
 * Transcript chrome.
 *
 * PowerShell's Start-Transcript and script(1) both wrap real output in a header
 * block and echo every command back. Those lines are not program output. Leaving
 * them in produced live false positives -- a transcript header quoting a command
 * line was reported as a TypeScript compile error.
 *
 * `isChromeLine` is the stateless half and runs inside every rule evaluation.
 * `makeChromeFilter` adds state so a whole header block delimited by banner lines
 * is skipped without hardcoding every key name PowerShell might emit.
 */

const BANNER = /^\*+\s*$/;
const PS_ECHO = /^PS>\s?/;
const PS_HEADER_KEYS =
  /^(Host Application|Process ID|PSVersion|PSEdition|PSCompatibleVersions|BuildVersion|CLRVersion|WSManStackVersion|PSRemotingProtocolVersion|SerializationVersion|Machine|Username|RunAs User|Configuration Name|Start time|End time|Command line|Start Tag|End Tag|Transcript start|Transcript end|Output length|Command count):/;
const SCRIPT_MARKERS = /^(Script started on|Script done on)/;

/**
 * Single-line check, safe to call from anywhere.
 *
 * Note what is deliberately NOT here: a generic `Capitalised word: value` pattern.
 * It looks like a good header heuristic and is a disaster -- it also matches
 * "Error: Cannot find module 'x'" and "ModuleNotFoundError: ...", which would
 * silence an entire class of real errors. Header detection stays on an explicit
 * key list plus the banner-delimited block handled below.
 */
export function isChromeLine(line) {
  const t = line.trim();
  if (t === '') return false; // blank lines are not chrome; callers drop them
  if (BANNER.test(t)) return true;
  if (PS_ECHO.test(line)) return true;
  if (PS_HEADER_KEYS.test(t)) return true;
  if (SCRIPT_MARKERS.test(t)) return true;
  return false;
}

/** Stateful filter that also swallows whole banner-delimited header blocks. */
export function makeChromeFilter() {
  let inHeader = false;
  return (line) => {
    if (BANNER.test(line.trim())) {
      inHeader = !inHeader;
      return true;
    }
    if (inHeader) return true;
    return isChromeLine(line);
  };
}
