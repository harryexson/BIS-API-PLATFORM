import { WorkerManager } from '../worker';
import { JobDeps } from './deps';
import { JobQueue } from '../queue';
import { createMessageDeliveryProcessor } from './messageDelivery';
import { createPaymentWebhookProcessor } from './paymentWebhook';
import { createProviderWebhookProcessor } from './providerWebhook';
import { createProviderHealthProcessor } from './providerHealth';
import { createEventProcessingProcessor } from './eventProcessing';
import { createRetryProcessingProcessor } from './retryProcessing';
import { createReconciliationProcessor } from './reconciliation';
import { createInboundMessageProcessor } from './inboundMessage';
import { createOutboxPollerProcessor } from './outboxPoller';
import { createReceiptPipelineProcessor } from './receiptPipeline';
import { createKeywordResponseDeliveryProcessor } from './keywordResponseDelivery';

export { JobDeps, NeonWriteError } from './deps';
export { createMessageDeliveryProcessor } from './messageDelivery';
export { createPaymentWebhookProcessor } from './paymentWebhook';
export { createProviderWebhookProcessor } from './providerWebhook';
export { createProviderHealthProcessor } from './providerHealth';
export { createEventProcessingProcessor } from './eventProcessing';
export { createRetryProcessingProcessor } from './retryProcessing';
export { createReconciliationProcessor } from './reconciliation';
export { createInboundMessageProcessor } from './inboundMessage';
export { createOutboxPollerProcessor } from './outboxPoller';
export { createReceiptPipelineProcessor } from './receiptPipeline';
export { createKeywordResponseDeliveryProcessor } from './keywordResponseDelivery';

export function registerAllProcessors(
  manager: WorkerManager,
  deps: JobDeps,
  queue: JobQueue,
): WorkerManager {
  manager.register('message_delivery', createMessageDeliveryProcessor(deps));
  manager.register('payment_webhook', createPaymentWebhookProcessor(deps));
  manager.register('provider_webhook', createProviderWebhookProcessor(deps));
  manager.register('provider_health', createProviderHealthProcessor(deps));
  manager.register('event_processing', createEventProcessingProcessor(deps));
  manager.register('retry_processing', createRetryProcessingProcessor(deps, queue));
  manager.register('reconciliation', createReconciliationProcessor(deps, queue));
  // P0: Register inbound message processor — routes webhooks to apps
  manager.register('inbound_message', createInboundMessageProcessor(deps));
  // P0: Register outbox poller — ensures at-least-once delivery of domain events
  manager.register('outbox_poller', createOutboxPollerProcessor(deps));
  // P0: Register receipt pipeline — sends receipts for successful charges
  manager.register('receipt_pipeline', createReceiptPipelineProcessor(deps));
  // P0: Register keyword response delivery — sends STOP/HELP/YES responses back to users
  manager.register('keyword_response_delivery', createKeywordResponseDeliveryProcessor(deps));
  return manager;
}
