// src/utils/zipGenerator.js
// Builds an in-memory ZIP from Playwright generation output

const archiver = require('archiver');
const { PassThrough } = require('stream');

/**
 * Build a ZIP buffer from the OpenAI Playwright generation result.
 *
 * @param {Object} generated - Output from playwrightGenerator.generatePlaywrightFiles()
 * @param {string} readme - README.md content
 * @returns {Promise<Buffer>} ZIP file as a Buffer
 */
async function buildPlaywrightZip(generated, readme) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const passthrough = new PassThrough();
    passthrough.on('data', (chunk) => buffers.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(buffers)));
    passthrough.on('error', reject);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    archive.pipe(passthrough);

    // Spec files → tests/
    if (generated.specs && Array.isArray(generated.specs)) {
      for (const spec of generated.specs) {
        archive.append(spec.content, { name: `tests/${spec.fileName}` });
      }
    }

    // Page Objects → tests/pages/
    if (generated.pages && Array.isArray(generated.pages)) {
      for (const page of generated.pages) {
        archive.append(page.content, { name: `tests/pages/${page.fileName}` });
      }
    }

    // Test data → tests/test-data/
    if (generated.testData && generated.testData.content) {
      const content =
        typeof generated.testData.content === 'string'
          ? generated.testData.content
          : JSON.stringify(generated.testData.content, null, 2);
      archive.append(content, {
        name: `tests/test-data/${generated.testData.fileName}`,
      });
    }

    // Playwright config → tests/
    if (generated.config && generated.config.content) {
      archive.append(generated.config.content, {
        name: `tests/${generated.config.fileName}`,
      });
    }

    // README
    archive.append(readme, { name: 'tests/README.md' });

    // package.json for convenience
    const pkg = JSON.stringify(
      {
        name: 'testforge-playwright-tests',
        version: '1.0.0',
        scripts: {
          test: 'npx playwright test',
          'test:headed': 'npx playwright test --headed',
          'test:ui': 'npx playwright test --ui',
        },
        devDependencies: {
          '@playwright/test': '^1.44.0',
        },
      },
      null,
      2
    );
    archive.append(pkg, { name: 'tests/package.json' });

    archive.finalize();
  });
}

module.exports = { buildPlaywrightZip };
