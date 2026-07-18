import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateIncidentMessage,
  createStatusIncident,
  updateStatusIncident,
  getActiveIncidents,
  getResolvedIncidents
} from '../../status-page-manager.js';
import { getDb } from '../../database.js';

describe('status-page-manager', () => {
  beforeEach(async () => {
    const db = await getDb();
    await db.run('DELETE FROM status_incident_updates');
    await db.run('DELETE FROM status_incidents');
  });

  describe('validateIncidentMessage', () => {
    it('accepts valid title and description', () => {
      const result = validateIncidentMessage('Server outage', 'We are investigating.');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts title without description', () => {
      const result = validateIncidentMessage('Server outage');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts title with null description', () => {
      const result = validateIncidentMessage('Server outage', null);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects empty title', () => {
      const result = validateIncidentMessage('', 'Some description');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects null title', () => {
      const result = validateIncidentMessage(null, 'Some description');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects title exceeding 200 characters', () => {
      const longTitle = 'A'.repeat(201);
      const result = validateIncidentMessage(longTitle, 'desc');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('200');
    });

    it('accepts title of exactly 200 characters', () => {
      const title = 'A'.repeat(200);
      const result = validateIncidentMessage(title, 'desc');
      expect(result.valid).toBe(true);
    });

    it('accepts title of exactly 1 character', () => {
      const result = validateIncidentMessage('A');
      expect(result.valid).toBe(true);
    });

    it('rejects description exceeding 2000 characters', () => {
      const longDesc = 'B'.repeat(2001);
      const result = validateIncidentMessage('Valid title', longDesc);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('2000');
    });

    it('accepts description of exactly 2000 characters', () => {
      const desc = 'B'.repeat(2000);
      const result = validateIncidentMessage('Valid title', desc);
      expect(result.valid).toBe(true);
    });

    it('rejects whitespace-only title', () => {
      const result = validateIncidentMessage('   ', 'desc');
      expect(result.valid).toBe(false);
    });
  });

  describe('createStatusIncident', () => {
    it('creates an incident and returns its ID', async () => {
      const id = await createStatusIncident('API Degradation', 'Investigating slowness', 'investigating');
      expect(id).toBeGreaterThan(0);
    });

    it('stores the incident in the database with correct fields', async () => {
      const id = await createStatusIncident('DB Issue', 'Connection pool exhausted', 'identified');
      const db = await getDb();
      const row = await db.get('SELECT * FROM status_incidents WHERE id = ?', [id]);
      expect(row.title).toBe('DB Issue');
      expect(row.description).toBe('Connection pool exhausted');
      expect(row.status).toBe('identified');
      expect(row.created_at).toBeTruthy();
      expect(row.resolved_at).toBeNull();
    });

    it('sets resolved_at when status is resolved', async () => {
      const id = await createStatusIncident('Brief blip', 'Resolved now', 'resolved');
      const db = await getDb();
      const row = await db.get('SELECT * FROM status_incidents WHERE id = ?', [id]);
      expect(row.resolved_at).toBeTruthy();
    });

    it('throws on invalid title', async () => {
      await expect(createStatusIncident('', 'desc', 'investigating')).rejects.toThrow('Validation failed');
    });

    it('throws on invalid status', async () => {
      await expect(createStatusIncident('Title', 'desc', 'invalid_status')).rejects.toThrow('Invalid status');
    });

    it('supports all valid statuses', async () => {
      for (const status of ['investigating', 'identified', 'monitoring', 'resolved']) {
        const id = await createStatusIncident(`Test ${status}`, 'desc', status);
        expect(id).toBeGreaterThan(0);
      }
    });
  });

  describe('updateStatusIncident', () => {
    it('appends an update to an existing incident', async () => {
      const id = await createStatusIncident('Outage', 'Systems down', 'investigating');
      await updateStatusIncident(id, 'Root cause identified', 'identified');

      const db = await getDb();
      const updates = await db.all(
        'SELECT * FROM status_incident_updates WHERE incident_id = ?',
        [id]
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].message).toBe('Root cause identified');
      expect(updates[0].status).toBe('identified');
    });

    it('preserves chronological order of updates', async () => {
      const id = await createStatusIncident('Outage', 'Systems down', 'investigating');
      await updateStatusIncident(id, 'First update', 'investigating');
      await updateStatusIncident(id, 'Second update', 'identified');
      await updateStatusIncident(id, 'Third update', 'monitoring');

      const db = await getDb();
      const updates = await db.all(
        'SELECT * FROM status_incident_updates WHERE incident_id = ? ORDER BY created_at ASC',
        [id]
      );
      expect(updates).toHaveLength(3);
      expect(updates[0].message).toBe('First update');
      expect(updates[1].message).toBe('Second update');
      expect(updates[2].message).toBe('Third update');
    });

    it('updates the incident status', async () => {
      const id = await createStatusIncident('Outage', 'desc', 'investigating');
      await updateStatusIncident(id, 'Fix deployed', 'resolved');

      const db = await getDb();
      const row = await db.get('SELECT status, resolved_at FROM status_incidents WHERE id = ?', [id]);
      expect(row.status).toBe('resolved');
      expect(row.resolved_at).toBeTruthy();
    });

    it('throws on non-existent incident', async () => {
      await expect(updateStatusIncident(99999, 'msg', 'investigating')).rejects.toThrow('not found');
    });

    it('throws on empty message', async () => {
      const id = await createStatusIncident('Title', 'desc', 'investigating');
      await expect(updateStatusIncident(id, '', 'identified')).rejects.toThrow('required');
    });

    it('throws on message exceeding 2000 characters', async () => {
      const id = await createStatusIncident('Title', 'desc', 'investigating');
      const longMsg = 'X'.repeat(2001);
      await expect(updateStatusIncident(id, longMsg, 'identified')).rejects.toThrow('2000');
    });

    it('throws on invalid status', async () => {
      const id = await createStatusIncident('Title', 'desc', 'investigating');
      await expect(updateStatusIncident(id, 'msg', 'bad_status')).rejects.toThrow('Invalid status');
    });
  });

  describe('getActiveIncidents', () => {
    it('returns non-resolved incidents ordered by most recent', async () => {
      await createStatusIncident('First', 'desc', 'investigating');
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      await createStatusIncident('Second', 'desc', 'identified');
      await new Promise(r => setTimeout(r, 10));
      await createStatusIncident('Third', 'desc', 'monitoring');

      const active = await getActiveIncidents();
      expect(active).toHaveLength(3);
      // Most recent first
      expect(active[0].title).toBe('Third');
      expect(active[1].title).toBe('Second');
      expect(active[2].title).toBe('First');
    });

    it('excludes resolved incidents', async () => {
      await createStatusIncident('Active', 'desc', 'investigating');
      await createStatusIncident('Resolved', 'desc', 'resolved');

      const active = await getActiveIncidents();
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe('Active');
    });

    it('includes update history with each incident', async () => {
      const id = await createStatusIncident('With updates', 'desc', 'investigating');
      await updateStatusIncident(id, 'Update 1', 'identified');
      await updateStatusIncident(id, 'Update 2', 'monitoring');

      const active = await getActiveIncidents();
      expect(active[0].updates).toHaveLength(2);
      expect(active[0].updates[0].message).toBe('Update 1');
      expect(active[0].updates[1].message).toBe('Update 2');
    });

    it('returns empty array when no active incidents', async () => {
      const active = await getActiveIncidents();
      expect(active).toHaveLength(0);
    });
  });

  describe('getResolvedIncidents', () => {
    it('returns resolved incidents within the time window', async () => {
      const id = await createStatusIncident('Was active', 'desc', 'investigating');
      await updateStatusIncident(id, 'Fixed', 'resolved');

      const resolved = await getResolvedIncidents(7);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].title).toBe('Was active');
      expect(resolved[0].status).toBe('resolved');
    });

    it('excludes incidents resolved beyond the daysBack window', async () => {
      const db = await getDb();
      // Insert an incident resolved 10 days ago
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        `INSERT INTO status_incidents (title, description, status, created_at, resolved_at)
         VALUES (?, ?, 'resolved', ?, ?)`,
        ['Old incident', 'desc', oldDate, oldDate]
      );

      const resolved = await getResolvedIncidents(7);
      expect(resolved).toHaveLength(0);
    });

    it('defaults to 7 days if no argument provided', async () => {
      const id = await createStatusIncident('Recent resolved', 'desc', 'investigating');
      await updateStatusIncident(id, 'Done', 'resolved');

      const resolved = await getResolvedIncidents();
      expect(resolved).toHaveLength(1);
    });

    it('includes update history with resolved incidents', async () => {
      const id = await createStatusIncident('Tracked', 'desc', 'investigating');
      await updateStatusIncident(id, 'Found cause', 'identified');
      await updateStatusIncident(id, 'All clear', 'resolved');

      const resolved = await getResolvedIncidents(7);
      expect(resolved[0].updates).toHaveLength(2);
    });
  });
});
