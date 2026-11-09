/**
 * Session discovery announcement policy.
 *
 * Transcript sidecars are rescanned periodically so late or updated metadata
 * can be adopted. Only first discovery should be announced to the terminal;
 * repeatedly printing a "refreshed" line on every poll turns a quiet daemon
 * into a continuous log stream.
 */
export function adoptTranscript(tailer, session, onFirstDiscovery = () => {}) {
  const alreadyTracked = tailer.refresh(session.file, session);
  if (alreadyTracked) return false;

  tailer.track(session.file, session);
  onFirstDiscovery(session);
  return true;
}
