import { describe, it, expect } from 'vitest';
import { normalizeMonitorUrl } from '../server.js';

describe('Duplicate Monitor Prevention', () => {
  describe('normalizeMonitorUrl', () => {
    it('normalizes simple domain URLs', () => {
      expect(normalizeMonitorUrl('https://goroomz.in')).toBe('goroomz.in');
    });

    it('removes trailing slashes from root paths', () => {
      expect(normalizeMonitorUrl('https://goroomz.in/')).toBe('goroomz.in');
    });

    it('treats duplicate URLs with and without trailing slash as identical', () => {
      const url1 = normalizeMonitorUrl('https://goroomz.in');
      const url2 = normalizeMonitorUrl('https://goroomz.in/');
      expect(url1).toBe(url2);
    });

    it('treats duplicate URLs with different cases as identical', () => {
      const url1 = normalizeMonitorUrl('HTTPS://APP.RXDOCTOR.IN');
      const url2 = normalizeMonitorUrl('https://app.rxdoctor.in');
      expect(url1).toBe(url2);
    });

    it('handles URLs without explicit scheme', () => {
      expect(normalizeMonitorUrl('kite.goroomz.in')).toBe('kite.goroomz.in');
    });

    it('preserves query strings and hashes', () => {
      expect(normalizeMonitorUrl('https://app.rxdoctor.in/dashboard?user=1#top/')).toBe('app.rxdoctor.in/dashboard?user=1#top/');
    });

    it('returns empty string for invalid or empty input', () => {
      expect(normalizeMonitorUrl('')).toBe('');
      expect(normalizeMonitorUrl(null)).toBe('');
    });
  });
});
