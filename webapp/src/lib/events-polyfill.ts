/**
 * Minimal Node EventEmitter for the browser (Vite alias: events → this file).
 * Covers the API surface @near-wallet-selector + near-api-js actually use.
 */
type Listener = (...args: any[]) => void;

class EventEmitter {
  private map = new Map<string, Listener[]>();
  private max = 100;

  setMaxListeners(n: number) {
    this.max = n;
  }
  getMaxListeners() {
    return this.max;
  }
  addEventListener(name: string, l: Listener) {
    this.on(name, l);
  }
  removeEventListener(name: string, l: Listener) {
    this.removeListener(name, l);
  }
  on(name: string, l: Listener) {
    const arr = this.map.get(name) ?? [];
    arr.push(l);
    this.map.set(name, arr);
    return this;
  }
  prependListener(name: string, l: Listener) {
    const arr = this.map.get(name) ?? [];
    arr.unshift(l);
    this.map.set(name, arr);
    return this;
  }
  once(name: string, l: Listener) {
    const wrap = (...a: any[]) => {
      this.removeListener(name, wrap);
      l(...a);
    };
    (wrap as any)._orig = l;
    return this.on(name, wrap);
  }
  off(name: string, l: Listener) {
    return this.removeListener(name, l);
  }
  removeListener(name: string, l: Listener) {
    const arr = (this.map.get(name) ?? []) as any[];
    const i = arr.findIndex((x) => x === l || x._orig === l);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.map.delete(name);
    return this;
  }
  removeAllListeners(name?: string) {
    if (name) this.map.delete(name);
    else this.map.clear();
    return this;
  }
  listeners(name: string): Listener[] {
    return [...(this.map.get(name) ?? [])];
  }
  listenerCount(name: string) {
    return (this.map.get(name) ?? []).length;
  }
  eventNames(): string[] {
    return [...this.map.keys()];
  }
  emit(name: string, ...args: any[]): boolean {
    const arr = [...(this.map.get(name) ?? [])];
    if (arr.length === 0) return false;
    for (const l of arr) l(...args);
    return true;
  }
}

export { EventEmitter };
export default EventEmitter;
export const once = (emitter: EventEmitter, name: string): Promise<any[]> =>
  new Promise((resolve) => {
    const wrap = (...a: any[]) => {
      emitter.off(name, wrap as Listener);
      resolve(a);
    };
    emitter.addEventListener(name, wrap as Listener);
  });
