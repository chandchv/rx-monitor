/**
 * Screenshot Capture Module
 * Captures visual snapshots of monitored pages using a headless browser when checks fail.
 * Uses puppeteer-core with system-installed Chromium.
 * Implements graceful degradation if Chromium is unavailable.
 */

import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Directory where screenshots are stored.
 */
const SCREENSHOTS_DIR = resolve('screenshots');

/**
 * Default viewport dimensions for screenshot capture.
 */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

/**
 * Default timeout for page load in seconds.
 */
const DEFAULT_TIMEOUT_SEC = 15;

/**
 * Maximum age of screenshots before purging (in days).
 */
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Known Chromium executable paths by platform.
 */
const CHROMIUM_PATHS = {
  linux: [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe'
  ]
};

/**
 * Finds a usable Chromium executable on the system.
 * @returns {string|null} Path to Chromium executable or null if not found
 */
function findChromiumPath() {
  const platform = process.platform;
  const candidates = CHROMIUM_PATHS[platform] || [];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Ensures the screenshots directory exists.
 * @returns {Promise<void>}
 */
async function ensureScreenshotsDir() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Captures a screenshot of the given URL using a headless browser.
 * Launches puppeteer-core with system Chromium at 1280x720 viewport.
 * Times out after the specified duration, storing a timeout indicator.
 * Gracefully degrades if Chromium is unavailable.
 *
 * @param {string} url - The URL to capture
 * @param {number} [timeoutSec=15] - Maximum seconds to wait for page load
 * @returns {Promise<ScreenshotResult>}
 *
 * @typedef {Object} ScreenshotResult
 * @property {boolean} success - Whether the screenshot was captured successfully
 * @property {string|null} path - Filesystem path to the saved screenshot PNG, or null on failure
 * @property {string|null} error - Error description if capture failed, or null on success
 * @property {string} captured_at - ISO 8601 timestamp of the capture attempt
 */
export async function captureScreenshot(url, timeoutSec = DEFAULT_TIMEOUT_SEC) {
  const capturedAt = new Date().toISOString();

  // Validate URL
  if (!url || typeof url !== 'string') {
    return {
      success: false,
      path: null,
      error: 'Invalid URL provided',
      captured_at: capturedAt
    };
  }

  // Find Chromium
  const executablePath = findChromiumPath();
  if (!executablePath) {
    return {
      success: false,
      path: null,
      error: 'Chromium browser not available on this system',
      captured_at: capturedAt
    };
  }

  // Dynamically import puppeteer-core (graceful degradation if not installed)
  let puppeteer;
  try {
    puppeteer = await import('puppeteer-core');
  } catch (err) {
    return {
      success: false,
      path: null,
      error: `Puppeteer-core unavailable: ${err.message}`,
      captured_at: capturedAt
    };
  }

  // Ensure screenshots directory exists
  await ensureScreenshotsDir();

  // Generate filename with timestamp for uniqueness
  const timestamp = Date.now();
  const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 100);
  const filename = `screenshot_${timestamp}_${sanitizedUrl}.png`;
  const screenshotPath = join(SCREENSHOTS_DIR, filename);

  let browser = null;

  try {
    browser = await puppeteer.default.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    });

    const page = await browser.newPage();

    // Set viewport to 1280x720
    await page.setViewport({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT
    });

    // Navigate with timeout
    const timeoutMs = timeoutSec * 1000;

    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: timeoutMs
      });
    } catch (navError) {
      // Page didn't load in time — store timeout indicator
      if (navError.name === 'TimeoutError' || navError.message.includes('timeout')) {
        await browser.close();
        browser = null;
        return {
          success: false,
          path: null,
          error: `Page load timed out after ${timeoutSec} seconds`,
          captured_at: capturedAt
        };
      }
      // Other navigation errors — attempt screenshot of whatever loaded
      // Fall through to take screenshot of partial content if possible
    }

    // Capture the screenshot as PNG
    await page.screenshot({
      path: screenshotPath,
      type: 'png',
      fullPage: false
    });

    await browser.close();
    browser = null;

    return {
      success: true,
      path: screenshotPath,
      error: null,
      captured_at: capturedAt
    };
  } catch (err) {
    // Graceful degradation: log error and return failure without blocking
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        // Ignore close errors
      }
    }

    return {
      success: false,
      path: null,
      error: `Screenshot capture failed: ${err.message}`,
      captured_at: capturedAt
    };
  }
}

/**
 * Returns the expected screenshot file path for a given check log ID.
 * This provides a deterministic path for associating screenshots with check logs.
 *
 * @param {number|string} checkLogId - The check log entry identifier
 * @returns {string} The expected filesystem path for the screenshot
 */
export function getScreenshotPath(checkLogId) {
  return join(SCREENSHOTS_DIR, `check_${checkLogId}.png`);
}

/**
 * Purges screenshots older than the specified maximum age.
 * Auto-deletes screenshot files from the screenshots directory that exceed maxAgeDays.
 *
 * @param {number} [maxAgeDays=30] - Maximum age of screenshots in days before deletion
 * @returns {Promise<number>} The number of screenshots deleted
 */
export async function purgeOldScreenshots(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  // Ensure directory exists (no-op if already present)
  await ensureScreenshotsDir();

  let deletedCount = 0;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let files;
  try {
    files = await readdir(SCREENSHOTS_DIR);
  } catch (err) {
    // Directory doesn't exist or can't be read
    return 0;
  }

  for (const file of files) {
    // Only process PNG files
    if (!file.endsWith('.png')) continue;

    const filePath = join(SCREENSHOTS_DIR, file);

    try {
      const fileStat = await stat(filePath);
      const fileAge = now - fileStat.mtimeMs;

      // When maxAgeMs is 0, delete all PNG files regardless of age
      if (maxAgeMs === 0 || fileAge >= maxAgeMs) {
        await unlink(filePath);
        deletedCount++;
      }
    } catch (err) {
      // Skip files that can't be stat'd or deleted
      continue;
    }
  }

  return deletedCount;
}
