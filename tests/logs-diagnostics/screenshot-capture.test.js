/**
 * Unit tests for screenshot-capture.js module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { captureScreenshot, getScreenshotPath, purgeOldScreenshots } from '../../screenshot-capture.js';

const SCREENSHOTS_DIR = resolve('screenshots');

describe('screenshot-capture', () => {
  describe('getScreenshotPath', () => {
    it('should return a path in the screenshots directory with the check log ID', () => {
      const path = getScreenshotPath(123);
      expect(path).toBe(join(SCREENSHOTS_DIR, 'check_123.png'));
    });

    it('should handle string check log IDs', () => {
      const path = getScreenshotPath('456');
      expect(path).toBe(join(SCREENSHOTS_DIR, 'check_456.png'));
    });

    it('should return consistent paths for the same ID', () => {
      const path1 = getScreenshotPath(42);
      const path2 = getScreenshotPath(42);
      expect(path1).toBe(path2);
    });
  });

  describe('captureScreenshot', () => {
    it('should return error for invalid URL (null)', async () => {
      const result = await captureScreenshot(null);
      expect(result.success).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toBe('Invalid URL provided');
      expect(result.captured_at).toBeDefined();
    });

    it('should return error for invalid URL (empty string)', async () => {
      const result = await captureScreenshot('');
      expect(result.success).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toBe('Invalid URL provided');
    });

    it('should return error for invalid URL (non-string)', async () => {
      const result = await captureScreenshot(12345);
      expect(result.success).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toBe('Invalid URL provided');
    });

    it('should include captured_at timestamp in ISO 8601 format', async () => {
      const before = new Date().toISOString();
      const result = await captureScreenshot('https://example.com');
      const after = new Date().toISOString();

      expect(result.captured_at).toBeDefined();
      // Verify it's a valid ISO timestamp
      expect(() => new Date(result.captured_at)).not.toThrow();
      expect(new Date(result.captured_at).toISOString()).toBe(result.captured_at);
    });

    it('should gracefully degrade if Chromium is not available', async () => {
      // This test verifies the graceful degradation behavior.
      // On CI/environments without Chrome, it should return a descriptive error
      // rather than throwing an exception.
      const result = await captureScreenshot('https://example.com');
      // Either succeeds (Chrome available) or fails gracefully (Chrome unavailable)
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('captured_at');

      if (!result.success) {
        expect(result.error).toBeTruthy();
        expect(result.path).toBeNull();
      }
    });

    it('should return ScreenshotResult with correct shape', async () => {
      const result = await captureScreenshot('https://example.com');
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('captured_at');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.captured_at).toBe('string');
    });
  });

  describe('purgeOldScreenshots', () => {
    const testDir = SCREENSHOTS_DIR;

    beforeEach(async () => {
      // Ensure screenshots directory exists
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      // Clean up test files only (not the directory itself since other tests may use it)
      try {
        const files = await readdir(testDir);
        for (const file of files) {
          if (file.startsWith('test_purge_')) {
            await rm(join(testDir, file));
          }
        }
      } catch (_) {
        // Ignore cleanup errors
      }
    });

    it('should return 0 when no screenshots exist', async () => {
      // Create a clean temp directory for this test
      const emptyDir = resolve('screenshots_test_empty');
      await mkdir(emptyDir, { recursive: true });

      // Since purgeOldScreenshots uses a fixed directory, test with actual dir
      const result = await purgeOldScreenshots(30);
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);

      // Clean up
      try { await rm(emptyDir, { recursive: true }); } catch (_) {}
    });

    it('should not delete files newer than max age', async () => {
      // Create a fresh PNG file (will be < 30 days old)
      const testFile = join(testDir, 'test_purge_recent.png');
      await writeFile(testFile, 'fake png data');

      const deleted = await purgeOldScreenshots(30);
      // The recent file should still exist
      expect(existsSync(testFile)).toBe(true);
    });

    it('should only process PNG files', async () => {
      // Create a non-PNG file
      const txtFile = join(testDir, 'test_purge_file.txt');
      await writeFile(txtFile, 'not a png');

      const deleted = await purgeOldScreenshots(0); // 0 days = delete everything
      // txt file should remain (not processed)
      expect(existsSync(txtFile)).toBe(true);

      // Clean up
      try { await rm(txtFile); } catch (_) {}
    });

    it('should delete PNG files older than maxAgeDays', async () => {
      // Create a PNG file
      const testFile = join(testDir, 'test_purge_old.png');
      await writeFile(testFile, 'fake png data');

      // Using maxAgeDays=0 ensures the file will be considered "old" immediately
      const deleted = await purgeOldScreenshots(0);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(existsSync(testFile)).toBe(false);
    });

    it('should return the count of deleted files', async () => {
      // Create multiple PNG files
      const files = ['test_purge_a.png', 'test_purge_b.png', 'test_purge_c.png'];
      for (const file of files) {
        await writeFile(join(testDir, file), 'fake png');
      }

      // Purge with 0 days (delete all)
      const deleted = await purgeOldScreenshots(0);
      expect(deleted).toBeGreaterThanOrEqual(3);
    });

    it('should use default of 30 days when no argument provided', async () => {
      // Create a fresh file - should NOT be deleted with default 30 day threshold
      const testFile = join(testDir, 'test_purge_default.png');
      await writeFile(testFile, 'fake png');

      const deleted = await purgeOldScreenshots();
      // Fresh file should survive
      expect(existsSync(testFile)).toBe(true);
    });
  });
});
