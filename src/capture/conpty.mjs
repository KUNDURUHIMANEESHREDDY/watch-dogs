/**
 * Layer 3: ConPTY byte-level capture.
 *
 * A ConPTY proxy sees every byte in both directions, including the full-screen
 * control sequences an IDE terminal emits, which no transcript can reconstruct.
 * The cost is real: it requires either a native ConPTY backend (a compiled
 * dependency) or forcing every client through a PTY-aware wrapper, and some apps
 * that pin a raw ConPTY handle break outright.
 *
 * So this layer is a probe plus a documented capability report. It refuses to
 * pretend. If no native backend is present it reports `unavailable` and the
 * watchdog degrades to layers 1+2 rather than half-proxying traffic it cannot
 * reconstruct.
 */
import { createRequire } from 'node:module';
import { log } from '../core/log.mjs';

const require = createRequire(import.meta.url);

const CANDIDATE_BACKENDS = [
  { name: 'node-pty', spec: 'node-pty', reason: 'reference ConPTY implementation' },
  { name: 'conpty', spec: '@homebridge/node-pty-prebuilt-multiarch', reason: 'prebuilt ConPTY bindings' },
];

export class ConptyLayer {
  #cfg;
  #backend = null;

  constructor(cfg) {
    this.#cfg = cfg;
  }

  /** @returns {{available:boolean, reason:string, backend?:string}} */
  probe() {
    for (const b of CANDIDATE_BACKENDS) {
      try {
        require.resolve(b.spec);
        this.#backend = b.name;
        return { available: true, reason: `found ${b.name} (${b.reason})`, backend: b.name };
      } catch {
        /* not installed */
      }
    }
    return {
      available: false,
      reason:
        'no native ConPTY backend installed. Layer 1 (shell transcripts) and layer 2 (process watcher) are active instead. ' +
        'To enable raw byte capture, install a ConPTY binding and re-run `wd doctor`.',
    };
  }

  async attach() {
    if (!this.#cfg.capture.layers.conpty) {
      return { started: false, why: 'disabled in config (capture.layers.conpty = false)' };
    }
    const p = this.probe();
    if (!p.available) {
      log.warn(`conpty layer unavailable: ${p.reason}`);
      return { started: false, why: p.reason };
    }
    // Wiring the actual proxy happens here once a backend is present. The rest of
    // the watchdog treats it as optional and is fully functional without it.
    return { started: false, why: `backend ${p.backend} present but proxy wiring is not enabled in this build` };
  }
}
