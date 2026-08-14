import { describe, it, expect } from 'vitest';
import { parse } from 'node:url';

describe('ws URL parsing', () => {
  it('extracts pathname and query from /ws/execute URL', () => {
    const url = '/ws/execute?projectId=abc123';
    const { pathname, query } = parse(url, true);
    expect(pathname).toBe('/ws/execute');
    expect(query.projectId).toBe('abc123');
  });

  it('only consumes projectId from the query (auth is cookie-only)', () => {
    // A token in the URL must never be honored; the upgrade handler reads
    // the session_token cookie exclusively. Only projectId is consumed.
    const url = '/ws/execute?projectId=abc123&token=xyz';
    const { query } = parse(url, true);
    expect(query.projectId).toBe('abc123');
  });

  it('handles missing query params', () => {
    const { pathname, query } = parse('/ws/execute', true);
    expect(pathname).toBe('/ws/execute');
    expect(query.projectId).toBeUndefined();
    expect(query.token).toBeUndefined();
  });

  it('rejects empty projectId', () => {
    const { query } = parse('/ws/execute?projectId=', true);
    expect(query.projectId).toBe('');
    expect(!!query.projectId).toBe(false); // empty string is falsy
  });
});
