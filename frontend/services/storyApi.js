// frontend/services/storyApi.js
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

function getHeaders() {
  const token = localStorage.getItem('accessToken') || localStorage.getItem('authToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  };
}

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(function() { return { error: { message: res.statusText } }; });
    throw new Error((body.error && body.error.message) || body.message || 'Request failed: ' + res.status);
  }
  return res;
}

export async function listStories(projectId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function getStory(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId, { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function createStory(projectId, data) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories', {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(data),
  });
  await handleResponse(res);
  return res.json();
}

export async function deleteStory(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId, {
    method: 'DELETE', headers: getHeaders(),
  });
  await handleResponse(res);
  return res.json();
}

export async function listScenarios(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/scenarios', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function updateScenarioStatus(projectId, storyId, scenarioId, status, reviewNote) {
  const res = await fetch(
    API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/scenarios/' + scenarioId,
    { method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ status: status, reviewNote: reviewNote }) }
  );
  await handleResponse(res);
  return res.json();
}

export async function getCoverage(projectId, storyId) {
  const res = await fetch(API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/coverage', { headers: getHeaders() });
  await handleResponse(res);
  return res.json();
}

export async function exportStoryCsv(projectId, storyId) {
  const token = localStorage.getItem('accessToken') || localStorage.getItem('authToken');
  const res = await fetch(
    API_BASE + '/api/projects/' + projectId + '/stories/' + storyId + '/export-csv',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) {
    const body = await res.json().catch(function() { return { error: { message: 'Export failed' } }; });
    throw new Error((body.error && body.error.message) || 'Export failed');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : 'story-export-' + Date.now() + '.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  return { filename: filename };
}
