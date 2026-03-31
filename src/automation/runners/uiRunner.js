const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Run a UI test using Playwright.
 *
 * @param {Object} testDef - The test definition object
 * @returns {Object} - Test result with status, logs, screenshots, duration
 */
async function runUiTest(testDef) {
  const { name, config } = testDef;
  const startTime = Date.now();
  const logs = [];
  const screenshots = [];
  let browser = null;
  let status = 'passed';
  let errorMessage = null;

  const log = (level, message) => {
    const entry = { timestamp: new Date().toISOString(), level, message };
    logs.push(entry);
    logger[level]({ test: name }, message);
  };

  try {
    log('info', `Starting UI test: ${name}`);

    // Launch browser
    browser = await chromium.launch({
      headless: config.headless !== false,
    });

    const context = await browser.newContext({
      viewport: config.viewport || { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    // Listen for console messages
    page.on('console', (msg) => {
      log('debug', `[Browser Console] ${msg.type()}: ${msg.text()}`);
    });

    // Listen for page errors
    page.on('pageerror', (err) => {
      log('warn', `[Browser Error] ${err.message}`);
    });

    // Execute each step
    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      const stepNum = i + 1;
      log('info', `Step ${stepNum}: ${step.action}${step.selector ? ` on "${step.selector}"` : ''}${step.value ? ` with "${step.value}"` : ''}`);

      const stepTimeout = step.timeout || 10000;

      switch (step.action) {
        case 'navigate':
          await page.goto(step.value || config.url, {
            waitUntil: 'domcontentloaded',
            timeout: stepTimeout,
          });
          log('info', `Navigated to ${step.value || config.url}`);
          break;

        case 'click':
          await page.locator(step.selector).click({ timeout: stepTimeout });
          log('info', `Clicked: ${step.selector}`);
          break;

        case 'fill':
          await page.locator(step.selector).fill(step.value || '', { timeout: stepTimeout });
          log('info', `Filled "${step.selector}" with "${step.value}"`);
          break;

        case 'select':
          await page.locator(step.selector).selectOption(step.value, { timeout: stepTimeout });
          log('info', `Selected "${step.value}" in ${step.selector}`);
          break;

        case 'wait':
          await page.waitForTimeout(parseInt(step.value, 10) || 1000);
          log('info', `Waited ${step.value || 1000}ms`);
          break;

        case 'screenshot': {
          const screenshotName = `${name.replace(/\s+/g, '_')}_step${stepNum}_${Date.now()}.png`;
          const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          screenshots.push(screenshotPath);
          log('info', `Screenshot saved: ${screenshotName}`);
          break;
        }

        case 'assert_text': {
          const element = page.locator(step.selector);
          const text = await element.textContent({ timeout: stepTimeout });
          if (!text || !text.includes(step.value)) {
            throw new Error(
              `Assertion failed at step ${stepNum}: Expected "${step.selector}" to contain "${step.value}", but got "${text}"`
            );
          }
          log('info', `Assertion passed: "${step.selector}" contains "${step.value}"`);
          break;
        }

        case 'assert_visible': {
          const isVisible = await page.locator(step.selector).isVisible({ timeout: stepTimeout });
          if (!isVisible) {
            throw new Error(
              `Assertion failed at step ${stepNum}: "${step.selector}" is not visible`
            );
          }
          log('info', `Assertion passed: "${step.selector}" is visible`);
          break;
        }

        case 'assert_title': {
          const title = await page.title();
          if (!title.includes(step.value)) {
            throw new Error(
              `Assertion failed at step ${stepNum}: Expected title to contain "${step.value}", but got "${title}"`
            );
          }
          log('info', `Assertion passed: title contains "${step.value}"`);
          break;
        }

        case 'assert_url': {
          const currentUrl = page.url();
          if (!currentUrl.includes(step.value)) {
            throw new Error(
              `Assertion failed at step ${stepNum}: Expected URL to contain "${step.value}", but got "${currentUrl}"`
            );
          }
          log('info', `Assertion passed: URL contains "${step.value}"`);
          break;
        }

        default:
          log('warn', `Unknown action: ${step.action}`);
      }
    }

    log('info', 'All steps completed successfully');
  } catch (err) {
    status = 'failed';
    errorMessage = err.message;
    log('error', `Test failed: ${err.message}`);

    // Capture failure screenshot
    try {
      if (browser) {
        const pages = browser.contexts()[0]?.pages();
        if (pages && pages.length > 0) {
          const failScreenshotName = `${name.replace(/\s+/g, '_')}_FAILED_${Date.now()}.png`;
          const failScreenshotPath = path.join(SCREENSHOTS_DIR, failScreenshotName);
          await pages[0].screenshot({ path: failScreenshotPath, fullPage: true });
          screenshots.push(failScreenshotPath);
          log('info', `Failure screenshot saved: ${failScreenshotName}`);
        }
      }
    } catch (screenshotErr) {
      log('warn', `Could not capture failure screenshot: ${screenshotErr.message}`);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const duration = Date.now() - startTime;

  return {
    name,
    type: 'ui',
    status,
    error: errorMessage,
    duration,
    stepsExecuted: config.steps.length,
    logs,
    screenshots: screenshots.map((s) => path.basename(s)),
    completedAt: new Date().toISOString(),
  };
}

module.exports = { runUiTest };
