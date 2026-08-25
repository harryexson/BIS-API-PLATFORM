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

export { JobDeps, NeonWriteError } from './deps';
export { createMessageDeliveryProcessor } from './messageDelivery';
export { createPaymentWebhookProcessor } from './paymentWebhook';
export { createProviderWebhookProcessor } from './providerWebhook';
export { createProviderHealthProcessor } from './providerHealth';
export { createEventProcessingProcessor } from './eventProcessing';
export { createRetryProcessingProcessor } from './retryProcessing';
export { createReconciliationProcessor } from './reconciliation';

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
  return manager;
}
