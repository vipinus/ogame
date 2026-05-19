export type Handler<T = unknown> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<T = unknown>(type: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler as Handler);
    return () => this.off(type, handler);
  }

  off<T = unknown>(type: string, handler: Handler<T>): void {
    this.handlers.get(type)?.delete(handler as Handler);
  }

  emit<T = unknown>(type: string, payload: T): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        void h(payload);
      } catch (e) {
        console.error(`[EventBus] handler error on ${type}`, e);
      }
    }
  }
}

export const bus = new EventBus();
