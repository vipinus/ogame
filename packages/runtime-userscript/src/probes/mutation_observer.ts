export interface Emitter {
  emit(type: string, payload: unknown): void;
}

const WATCHED_IDS = [
  "eventContent",
  "resources_metal",
  "resources_crystal",
  "resources_deuterium",
  "resources_energy",
  "movement",
  "fleet1",
  "fleet2",
  "fleet3",
  "fleet4",
] as const;

/**
 * Starts a MutationObserver per watched id (if present in the document) that
 * emits `dom.changed` on the supplied emitter when child/attribute mutations occur.
 * @returns a disposer that disconnects all observers.
 */
export function startMutationObserver(
  doc: Document,
  emitter: Emitter,
  win?: Window,
): () => void {
  const w = win ?? (doc.defaultView as Window | null);
  if (!w) return () => {};
  const MO = (w as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
  if (!MO) return () => {};

  const observers: MutationObserver[] = [];
  for (const id of WATCHED_IDS) {
    const el = doc.getElementById(id);
    if (!el) continue;
    const obs = new MO((mutations) => {
      try {
        emitter.emit("dom.changed", {
          targetId: id,
          mutationCount: mutations.length,
        });
      } catch {
        /* never propagate */
      }
    });
    obs.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    observers.push(obs);
  }
  return () => {
    for (const o of observers) o.disconnect();
  };
}
