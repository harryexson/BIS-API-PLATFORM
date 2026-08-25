export interface Keys {
  ready: (type: string) => string;
  delayed: (type: string) => string;
  dead: (type: string) => string;
  job: (id: string) => string;
  idempotency: (key: string) => string;
  lock: (resource: string) => string;
  rateLimit: (scope: string) => string;
  notify: (type: string) => string;
  scheduler: string;
}

export function createKeys(prefix: string): Keys {
  return {
    ready: (t) => `${prefix}:queue:${t}:ready`,
    delayed: (t) => `${prefix}:queue:${t}:delayed`,
    dead: (t) => `${prefix}:queue:${t}:dead`,
    job: (id) => `${prefix}:job:${id}`,
    idempotency: (k) => `${prefix}:idempotency:${k}`,
    lock: (r) => `${prefix}:lock:${r}`,
    rateLimit: (s) => `${prefix}:ratelimit:${s}`,
    notify: (t) => `${prefix}:notify:${t}`,
    scheduler: `${prefix}:scheduler:cursor`,
  };
}
