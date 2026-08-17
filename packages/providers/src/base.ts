import { ProviderConfig, TransactionEvent } from '@company/schemas';

export abstract class BaseProvider {
  public config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // Simulates provider processing delay
  protected async simulateLatency(): Promise<number> {
    const min = this.config.latencyMin;
    const max = this.config.latencyMax;
    const latency = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise((resolve) => setTimeout(resolve, latency));
    return latency;
  }

  // Checks status, throwing error if not online
  protected verifyAvailability() {
    if (this.config.status === 'offline') {
      throw new Error(`Provider ${this.config.name} is currently OFFLINE`);
    }
    if (this.config.status === 'maintenance') {
      throw new Error(`Provider ${this.config.name} is undergoing MAINTENANCE`);
    }
  }

  abstract processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent>;
}
