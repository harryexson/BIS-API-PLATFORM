import { ProviderConfig, TransactionEvent, PaymentRequest, PaymentResponse, MessageRequest, MessageResponse, OtherRequest, OtherResponse } from '@company/schemas';

export abstract class BaseProvider {
  public config: ProviderConfig;
  private _secrets: Record<string, string> = {};

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  protected get secrets(): Record<string, string> {
    return this._secrets;
  }

  public setSecrets(secrets: Record<string, string>): void {
    this._secrets = secrets;
  }

  // Simulates provider processing delay
  protected async simulateLatency(): Promise<number> {
    const min = this.config.latencyMin;
    const max = this.config.latencyMax;
    const latency = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise((resolve) => setTimeout(resolve, latency));
    return latency;
  }

  // Public wrapper used by health checks to measure current latency.
  public async measureLatency(): Promise<number> {
    return this.simulateLatency();
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

  abstract processRequest(
    appId: string,
    payload: PaymentRequest | MessageRequest | OtherRequest,
    decisionReason: string
  ): Promise<TransactionEvent>;
}
