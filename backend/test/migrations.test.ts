import { describe, it, expect } from 'vitest';
import { openDb, getSchemaVersion, BASELINE_SCHEMA_VERSION } from '../src/db.js';

describe('Database Schema & Migrations', () => {
  it('initializes a fresh database and applies migrations', () => {
    const db = openDb(':memory:');
    const version = getSchemaVersion(db);
    expect(version).toBeGreaterThanOrEqual(BASELINE_SCHEMA_VERSION);
    expect(version).toBe(7);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('projects');
    expect(names).toContain('runs');
    expect(names).toContain('audit_logs');
    expect(names).toContain('snapshots');
    expect(names).toContain('telemetry_samples');
    expect(names).toContain('resource_anomalies');
    expect(names).toContain('project_collaborators');
    expect(names).toContain('ai_verifications');
    expect(names).toContain('schema_migrations');

    // Verify role column on users table
    const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('role');
  });

  it('sets busy_timeout pragma to 5000ms', () => {
    const db = openDb(':memory:');
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(5000);
  });

  it('handles existing databases gracefully and records migrations idempotently', () => {
    const db = openDb(':memory:');
    expect(getSchemaVersion(db)).toBe(7);
    
    // Re-opening or querying should remain consistent
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
    expect(rows.length).toBe(7);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
