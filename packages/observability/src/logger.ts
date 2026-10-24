import { getContext, RequestContext } from './context';
import { redact, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry extends RequestContext {
  timestamp: string;
  level: LogLevel;
  message: string;
  latency?: number;
  status?: number | string;
  errorCode?: string;
  [key: string]: any;
}

class Logger {
  private buffer: LogEntry[] = [];
  private readonly maxBuffer = 200;

  private write(level: LogLevel, message: string, fields?: Record<string, any>) {
    const ctx = getContext();
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      // Phase 22 (C18): messages are meant to be static text with the
      // variable data in `fields`, but a message that interpolates a value
      // (an error message, a URL) must not bypass redaction either.
      message: redactText(message),
      ...ctx,
      ...redact(fields || {}),
    };

    // Drop undefined top-level context fields to keep logs tidy.
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();

    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  debug(message: string, fields?: Record<string, any>) {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, any>) {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, any>) {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, any>) {
    this.write('error', message, fields);
  }

  getRecentLogs(): LogEntry[] {
    return [...this.buffer];
  }

  clearLogs() {
    this.buffer = [];
  }
}

export const logger = new Logger();
