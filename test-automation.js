/**
 * Quick test to verify the automation engine works locally.
 * Run: node test-automation.js
 */
const { runUiTest } = require('./src/automation/runners/uiRunner');
const { runApiTest } = require('./src/automation/runners/apiRunner');

async function main() {
  console.log('\n========================================');
  console.log('  TestGenie Automation Engine Test');
  console.log('========================================\n');

  // Test 1: API test
  console.log('--- TEST 1: API Test (GET) ---\n');
  const apiResult = await runApiTest({
    name: 'JSONPlaceholder - Get User',
    type: 'api',
    config: {
      method: 'GET',
      url: 'https://jsonplaceholder.typicode.com/users/1',
      timeout: 10000,
      assertions: [
        { target: 'status', operator: 'equals', expected: 200 },
        { target: 'body', operator: 'equals', expected: 'Leanne Graham', path: 'name' },
        { target: 'response_time', operator: 'less_than', expected: 5000 },
      ],
    },
  });

  console.log(`  Status: ${apiResult.status.toUpperCase()}`);
  console.log(`  Duration: ${apiResult.duration}ms`);
  console.log(`  Assertions: ${apiResult.assertionResults.filter((a) => a.passed).length}/${apiResult.assertionResults.length} passed`);

  // Test 2: UI test
  console.log('\n--- TEST 2: UI Test (Playwright) ---\n');
  const uiResult = await runUiTest({
    name: 'Example.com Title Check',
    type: 'ui',
    config: {
      url: 'https://example.com',
      headless: true,
      steps: [
        { action: 'navigate', value: 'https://example.com' },
        { action: 'assert_title', value: 'Example Domain' },
        { action: 'assert_visible', selector: 'h1' },
        { action: 'assert_text', selector: 'h1', value: 'Example Domain' },
        { action: 'screenshot' },
      ],
    },
  });

  console.log(`  Status: ${uiResult.status.toUpperCase()}`);
  console.log(`  Duration: ${uiResult.duration}ms`);
  console.log(`  Steps: ${uiResult.stepsExecuted}`);
  console.log(`  Screenshots: ${uiResult.screenshots.length}`);

  // Summary
  console.log('\n========================================');
  console.log('  RESULTS');
  console.log('========================================');
  console.log(`  API Test:  ${apiResult.status === 'passed' ? 'PASSED' : 'FAILED'}`);
  console.log(`  UI Test:   ${uiResult.status === 'passed' ? 'PASSED' : 'FAILED'}`);
  console.log('========================================\n');

  if (apiResult.status === 'passed' && uiResult.status === 'passed') {
    console.log('  All tests passed! Automation engine is working.\n');
  } else {
    console.log('  Some tests failed. Check logs above.\n');
    if (apiResult.error) console.log('  API Error:', apiResult.error);
    if (uiResult.error) console.log('  UI Error:', uiResult.error);
  }
}

main().catch(console.error);
