import { describe, it, expect } from 'vitest';
import { computeConsensus, validateRegionConfig } from '../../geographic-checker.js';

describe('geographic-checker', () => {
  describe('validateRegionConfig', () => {
    function makeRegions(count) {
      return Array.from({ length: count }, (_, i) => ({
        name: `region-${i}`,
        endpoint_url: `https://check-${i}.example.com/health`
      }));
    }

    it('returns valid for 3 well-formed regions', () => {
      const result = validateRegionConfig(makeRegions(3));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns valid for 20 regions (max)', () => {
      const result = validateRegionConfig(makeRegions(20));
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns invalid when regions is not an array', () => {
      const result = validateRegionConfig(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Regions must be an array.');
    });

    it('returns invalid for undefined input', () => {
      const result = validateRegionConfig(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Regions must be an array.');
    });

    it('returns invalid when fewer than 3 regions', () => {
      const result = validateRegionConfig(makeRegions(2));
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/At least 3 regions/);
    });

    it('returns invalid when more than 20 regions', () => {
      const result = validateRegionConfig(makeRegions(21));
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/At most 20 regions/);
    });

    it('returns invalid for empty array', () => {
      const result = validateRegionConfig([]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/At least 3 regions/);
    });

    it('returns invalid when region is missing name', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'https://us.example.com' },
        { name: '', endpoint_url: 'https://eu.example.com' },
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('index 1') && e.includes('name'))).toBe(true);
    });

    it('returns invalid when region is missing endpoint_url', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'https://us.example.com' },
        { name: 'eu-west', endpoint_url: '' },
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('index 1') && e.includes('endpoint_url'))).toBe(true);
    });

    it('returns invalid for malformed URL', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'not-a-url' },
        { name: 'eu-west', endpoint_url: 'https://eu.example.com' },
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('index 0') && e.includes('invalid'))).toBe(true);
    });

    it('returns invalid for non-http/https scheme', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'ftp://files.example.com' },
        { name: 'eu-west', endpoint_url: 'https://eu.example.com' },
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('index 0') && e.includes('http or https'))).toBe(true);
    });

    it('returns valid for http scheme', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'http://us.example.com' },
        { name: 'eu-west', endpoint_url: 'https://eu.example.com' },
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(true);
    });

    it('returns invalid when a region entry is null', () => {
      const regions = [
        { name: 'us-east', endpoint_url: 'https://us.example.com' },
        null,
        { name: 'ap-south', endpoint_url: 'https://ap.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('index 1') && e.includes('object'))).toBe(true);
    });

    it('accumulates multiple errors', () => {
      const regions = [
        { name: '', endpoint_url: '' },
        { name: '', endpoint_url: 'not-a-url' },
        { name: 'ok', endpoint_url: 'https://ok.example.com' },
      ];
      const result = validateRegionConfig(regions);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe('computeConsensus', () => {
    it('returns DOWN for empty array', () => {
      expect(computeConsensus([])).toBe('DOWN');
    });

    it('returns DOWN for null input', () => {
      expect(computeConsensus(null)).toBe('DOWN');
    });

    it('returns DOWN for undefined input', () => {
      expect(computeConsensus(undefined)).toBe('DOWN');
    });

    it('returns DOWN when all regions are DOWN', () => {
      const results = [
        { status: 'DOWN' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('DOWN');
    });

    it('returns UP when all regions are UP', () => {
      const results = [
        { status: 'UP' },
        { status: 'UP' },
        { status: 'UP' },
      ];
      expect(computeConsensus(results)).toBe('UP');
    });

    it('returns UP when more than 50% are UP (2 of 3)', () => {
      const results = [
        { status: 'UP' },
        { status: 'UP' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('UP');
    });

    it('returns UP when more than 50% are UP (3 of 5)', () => {
      const results = [
        { status: 'UP' },
        { status: 'UP' },
        { status: 'UP' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('UP');
    });

    it('returns PARTIAL when exactly 50% UP (2 of 4)', () => {
      const results = [
        { status: 'UP' },
        { status: 'UP' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('PARTIAL');
    });

    it('returns PARTIAL when exactly 50% UP (3 of 6)', () => {
      const results = [
        { status: 'UP' },
        { status: 'UP' },
        { status: 'UP' },
        { status: 'DOWN' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('PARTIAL');
    });

    it('returns PARTIAL when less than 50% UP but not all DOWN (1 of 3)', () => {
      const results = [
        { status: 'UP' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('PARTIAL');
    });

    it('returns PARTIAL when 1 of 4 are UP', () => {
      const results = [
        { status: 'UP' },
        { status: 'DOWN' },
        { status: 'DOWN' },
        { status: 'DOWN' },
      ];
      expect(computeConsensus(results)).toBe('PARTIAL');
    });

    it('returns UP for single region UP', () => {
      expect(computeConsensus([{ status: 'UP' }])).toBe('UP');
    });

    it('returns DOWN for single region DOWN', () => {
      expect(computeConsensus([{ status: 'DOWN' }])).toBe('DOWN');
    });

    it('returns UP for large majority UP (15 of 20)', () => {
      const results = [
        ...Array(15).fill({ status: 'UP' }),
        ...Array(5).fill({ status: 'DOWN' }),
      ];
      expect(computeConsensus(results)).toBe('UP');
    });

    it('returns PARTIAL for 10 of 20 UP (exactly 50%)', () => {
      const results = [
        ...Array(10).fill({ status: 'UP' }),
        ...Array(10).fill({ status: 'DOWN' }),
      ];
      expect(computeConsensus(results)).toBe('PARTIAL');
    });

    it('returns UP for 11 of 20 UP (just over 50%)', () => {
      const results = [
        ...Array(11).fill({ status: 'UP' }),
        ...Array(9).fill({ status: 'DOWN' }),
      ];
      expect(computeConsensus(results)).toBe('UP');
    });
  });
});
