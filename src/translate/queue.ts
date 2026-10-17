export class BoundedAsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  }

  get size(): number {
    return this.items.length;
  }

  push(value: T): boolean {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return true;
    }
    if (this.items.length >= this.capacity) return false;
    this.items.push(value);
    return true;
  }

  async shift(): Promise<T> {
    const value = this.items.shift();
    if (value !== undefined) return value;
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}
