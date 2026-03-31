const http = require('http');

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({ hostname: 'localhost', port: 3000, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const login = await request('POST', '/api/auth/login', {
    email: 'tonmoy@testgenie.io', password: 'TestGenie123'
  });
  const token = login.accessToken;
  console.log('Logged in\n');

  console.log('=== API TEST via /execute-test ===');
  const apiResult = await request('POST', '/api/execute-test', {
    test: {
      name: 'JSONPlaceholder GET',
      type: 'api',
      config: {
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/users/1',
        timeout: 10000,
        assertions: [
          { target: 'status', operator: 'equals', expected: 200 },
          { target: 'body', operator: 'equals', expected: 'Leanne Graham', path: 'name' }
        ]
      }
    }
  }, token);
  console.log('Status:', apiResult.status);
  console.log('Duration:', apiResult.duration + 'ms');
  console.log('Stored ID:', apiResult.id);

  console.log('\n=== UI TEST via /execute-test ===');
  const uiResult = await request('POST', '/api/execute-test', {
    test: {
      name: 'Example.com Check',
      type: 'ui',
      config: {
        url: 'https://example.com',
        headless: true,
        steps: [
          { action: 'navigate', value: 'https://example.com' },
          { action: 'assert_title', value: 'Example Domain' },
          { action: 'assert_text', selector: 'h1', value: 'Example Domain' },
          { action: 'screenshot' }
        ]
      }
    }
  }, token);
  console.log('Status:', uiResult.status);
  console.log('Duration:', uiResult.duration + 'ms');
  console.log('Screenshots:', uiResult.screenshots);
  console.log('Stored ID:', uiResult.id);

  console.log('\n=== EXECUTION HISTORY ===');
  const history = await request('GET', '/api/executions', null, token);
  console.log('Total executions:', history.pagination.total);
  history.data.forEach(e => {
    console.log('  [' + e.status.toUpperCase() + '] ' + e.testName + ' (' + e.testType + ') - ' + e.durationMs + 'ms');
  });

  console.log('\n=== ALL DONE ===');
}

main().catch(console.error);