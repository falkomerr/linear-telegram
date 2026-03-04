interface QueueTask {
  id: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class SimpleQueue {
  private readonly concurrency: number;
  private readonly queue: QueueTask[] = [];
  private running = 0;

  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency);
  }

  enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        run: run as () => Promise<unknown>,
        resolve: (value: unknown) => resolve(value as T),
        reject
      });
      this.process().catch((error) => {
        console.error("Failed to process queue", error);
      });
    });
  }

  private async process(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) return;
      this.running += 1;
      task
        .run()
        .then((value) => task.resolve(value))
        .catch((error) => task.reject(error))
        .finally(() => {
          this.running -= 1;
          this.process();
        });
    }
  }
}
