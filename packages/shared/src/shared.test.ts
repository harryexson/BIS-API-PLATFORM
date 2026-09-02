import { describe, it, expect } from 'vitest';
import { CLIENT_APPS, DEFAULT_PORT, DEFAULT_VITE_PORT } from './index';

describe('CLIENT_APPS registry', () => {
  it('contains the six confirmed platform applications', () => {
    const ids = CLIENT_APPS.map((app) => app.id);
    for (const expected of ['reachchurch', 'afribook', 'haulpro', 'stayscape', 'eventhub', 'ridely']) {
      expect(ids).toContain(expected);
    }
  });

  it('has globally unique app ids', () => {
    const ids = CLIENT_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every app has a non-empty name and category', () => {
    for (const app of CLIENT_APPS) {
      expect(app.name.trim().length).toBeGreaterThan(0);
      expect(app.category.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('default ports', () => {
  it('exposes the gateway and vite ports', () => {
    expect(DEFAULT_PORT).toBe(3001);
    expect(DEFAULT_VITE_PORT).toBe(5173);
  });
});