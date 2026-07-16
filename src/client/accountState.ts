export class StaleAccountStateError extends Error {
  name = "StaleAccountStateError";
}

export class AccountStateGuard {
  private version = 0;

  advance(): void {
    this.version += 1;
  }

  capture(): number {
    return this.version;
  }

  isCurrent(version: number): boolean {
    return version === this.version;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    return this.runAt(this.capture(), operation);
  }

  async runAt<T>(version: number, operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(version);
    try {
      const result = await operation();
      this.assertCurrent(version);
      return result;
    } catch (error) {
      this.assertCurrent(version);
      throw error;
    }
  }

  private assertCurrent(version: number): void {
    if (!this.isCurrent(version)) {
      throw new StaleAccountStateError("La cuenta cambió mientras la solicitud estaba en curso");
    }
  }
}
