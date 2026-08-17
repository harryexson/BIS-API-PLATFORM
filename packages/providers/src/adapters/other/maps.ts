import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent } from '@company/schemas';

export class MapsProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  async processRequest(appId: string, payload: any, decisionReason: string): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    this.verifyAvailability();

    const { action = 'geocode', address = '1600 Amphitheatre Pkwy', origin, destination } = payload;
    const txId = 'map-' + Math.random().toString(36).substring(2, 12);
    const cost = 0.005;

    let responsePayload: any = {};
    if (action === 'route' && origin && destination) {
      responsePayload = {
        routes: [
          {
            legs: [
              {
                distance: { text: '12.4 mi', value: 19955 },
                duration: { text: '24 mins', value: 1440 },
                end_address: destination,
                start_address: origin
              }
            ],
            summary: 'US-101 S',
            warnings: []
          }
        ],
        status: 'OK'
      };
    } else {
      responsePayload = {
        results: [
          {
            formatted_address: address,
            geometry: {
              location: { lat: 37.4220, lng: -122.0841 },
              location_type: 'ROOFTOP'
            },
            place_id: 'ChIJ2eUgeAK6j4AR4j5442A25k0',
            types: ['street_address']
          }
        ],
        status: 'OK'
      };
    }

    return {
      id: txId,
      timestamp: new Date().toISOString(),
      appId,
      category: 'other',
      providerId: this.config.id,
      status: 'success',
      latency,
      cost,
      decisionReason,
      payload,
      response: responsePayload
    };
  }
}
