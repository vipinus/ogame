type ChangeListener = (active: boolean) => void;

/**
 * Singleton-style flag used to signal that the emergency subsystem is currently
 * dispatching/awaiting a fleet save. Daily and Goal subsystems consult this gate
 * before executing any directive: when `isActive() === true`, they must yield.
 *
 * Emergency code does NOT consult the gate — emergency is the gate.
 */
export class PriorityGate {
  private active = false;
  private listeners = new Set<ChangeListener>();

  isActive(): boolean {
    return this.active;
  }

  setActive(next: boolean): void {
    if (this.active === next) return;
    this.active = next;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch (e) {
        console.error("[PriorityGate] listener error", e);
      }
    }
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Default process-wide singleton (M2.7 orchestrator will flip this). */
export const emergencyGate = new PriorityGate();
