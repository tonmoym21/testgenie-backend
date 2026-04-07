import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getStory, listScenarios, updateScenarioStatus, getCoverage, exportStoryCsv } from '../services/storyApi';

var CATEGORY_LABELS = {
  happy_path: 'Happy Path', negative: 'Negative', edge: 'Edge Cases', validation: 'Validation',
  role_permission: 'Role / Permission', state_transition: 'State Transition', api_impact: 'API Impact', non_functional: 'Non-Functional',
};

export default function StoryDetailPage() {
  var params = useParams();
  var projectId = params.projectId, storyId = params.storyId;
  var [story, setStory] = useState(null);
  var [scenarios, setScenarios] = useState([]);
  var [coverage, setCoverage] = useState(null);
  var [loading, setLoading] = useState(true);
  var [error, setError] = useState(null);
  var [exporting, setExporting] = useState(false);
  var [exportMsg, setExportMsg] = useState(null);

  var loadData = useCallback(async function() {
    try {
      setLoading(true); setError(null);
      var results = await Promise.all([getStory(projectId, storyId), listScenarios(projectId, storyId), getCoverage(projectId, storyId)]);
      setStory(results[0]); setScenarios(results[1]); setCoverage(results[2]);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [projectId, storyId]);

  useEffect(function() { loadData(); }, [loadData]);

  async function handleStatusChange(scenarioId, newStatus) {
    try {
      var updated = await updateScenarioStatus(projectId, storyId, scenarioId, newStatus);
      setScenarios(function(prev) { return prev.map(function(s) { return s.id === scenarioId ? updated : s; }); });
      var cov = await getCoverage(projectId, storyId);
      setCoverage(cov);
    } catch (err) { alert('Failed: ' + err.message); }
  }

  async function handleBulkAction(category, newStatus) {
    var targets = scenarios.filter(function(s) { return s.category === category && s.status !== newStatus; });
    for (var i = 0; i < targets.length; i++) {
      await handleStatusChange(targets[i].id, newStatus);
    }
  }

  async function handleExport() {
    try {
      setExporting(true); setExportMsg(null);
      var result = await exportStoryCsv(projectId, storyId);
      setExportMsg('Downloaded: ' + result.filename);
    } catch (err) { setExportMsg('Error: ' + err.message); }
    finally { setExporting(false); }
  }

  if (loading) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Loading story...');
  if (error) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#dc2626' } }, 'Error: ' + error);
  if (!story) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Story not found');

  var approvedCount = scenarios.filter(function(s) { return s.status === 'approved'; }).length;
  var pendingCount = scenarios.filter(function(s) { return s.status === 'pending'; }).length;
  var rejectedCount = scenarios.filter(function(s) { return s.status === 'rejected'; }).length;
  var canExport = approvedCount > 0;

  var grouped = {};
  scenarios.forEach(function(s) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });

  return React.createElement('div', { style: { maxWidth: '800px', margin: '0 auto', padding: '24px' } },
    React.createElement(Link, { to: '/projects/' + projectId + '/stories', style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\u2190 Back to Stories'),
    React.createElement('h1', { style: { fontSize: '22px', fontWeight: '700', margin: '8px 0 4px' } }, story.title),
    React.createElement('p', { style: { color: '#4b5563', fontSize: '14px', margin: '0 0 20px', lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, story.description),

    // Summary bar
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: '8px', padding: '16px 20px', border: '1px solid #e5e7eb', marginBottom: '16px' } },
      React.createElement('div', { style: { display: 'flex', gap: '24px' } },
        StatBox('Total', scenarios.length, '#374151'),
        StatBox('Approved', approvedCount, '#16a34a'),
        StatBox('Pending', pendingCount, '#d97706'),
        StatBox('Rejected', rejectedCount, '#dc2626'),
        coverage && StatBox('Quality', coverage.qualityScore + '%', '#7c3aed')
      ),
      React.createElement('button', {
        style: { backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', opacity: canExport && !exporting ? 1 : 0.5, cursor: canExport && !exporting ? 'pointer' : 'not-allowed' },
        disabled: !canExport || exporting,
        onClick: handleExport
      }, exporting ? 'Exporting...' : '\u2B07 Export CSV (' + approvedCount + ')')
    ),

    // Export message
    exportMsg && React.createElement('div', {
      style: { padding: '10px 14px', borderRadius: '6px', fontSize: '13px', border: '1px solid', marginBottom: '16px',
        backgroundColor: exportMsg.indexOf('Error') === 0 ? '#fef2f2' : '#f0fdf4',
        color: exportMsg.indexOf('Error') === 0 ? '#dc2626' : '#16a34a',
        borderColor: exportMsg.indexOf('Error') === 0 ? '#fecaca' : '#bbf7d0' }
    }, exportMsg),

    // Missing categories warning
    coverage && coverage.missingCategories.length > 0 && React.createElement('div', {
      style: { backgroundColor: '#fffbeb', color: '#92400e', padding: '10px 14px', borderRadius: '6px', border: '1px solid #fcd34d', fontSize: '13px', marginBottom: '16px' }
    }, '\u26A0 Missing coverage: ' + coverage.missingCategories.map(function(c) { return CATEGORY_LABELS[c] || c; }).join(', ')),

    // Scenario groups
    Object.entries(grouped).map(function(entry) {
      var category = entry[0], items = entry[1];
      return React.createElement('div', { key: category, style: { marginBottom: '24px' } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e5e7eb', paddingBottom: '8px', marginBottom: '12px' } },
          React.createElement('h2', { style: { fontSize: '16px', fontWeight: '600', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' } },
            CATEGORY_LABELS[category] || category,
            React.createElement('span', { style: { backgroundColor: '#e5e7eb', color: '#374151', fontSize: '12px', padding: '1px 8px', borderRadius: '9999px', fontWeight: '500' } }, items.length)
          ),
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
            React.createElement('button', { style: { background: 'none', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', color: '#16a34a' }, onClick: function() { handleBulkAction(category, 'approved'); } }, '\u2713 Approve All'),
            React.createElement('button', { style: { background: 'none', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', color: '#dc2626' }, onClick: function() { handleBulkAction(category, 'rejected'); } }, '\u2715 Reject All')
          )
        ),
        items.map(function(scenario) { return ScenarioCard(scenario, handleStatusChange); })
      );
    }),

    scenarios.length === 0 && React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280', backgroundColor: '#f9fafb', borderRadius: '8px' } }, 'No scenarios generated for this story.')
  );
}

function StatBox(label, value, color) {
  return React.createElement('div', { style: { textAlign: 'center' } },
    React.createElement('div', { style: { fontSize: '20px', fontWeight: '700', color: color } }, value),
    React.createElement('div', { style: { fontSize: '11px', color: '#6b7280', textTransform: 'uppercase' } }, label)
  );
}

function ScenarioCard(scenario, onStatusChange) {
  var s = scenario;
  var statusConfig = {
    pending: { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
    approved: { bg: '#dcfce7', color: '#166534', label: 'Approved' },
    rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Rejected' },
  };
  var cfg = statusConfig[s.status] || statusConfig.pending;
  var priorityColors = { P0: '#dc2626', P1: '#d97706', P2: '#2563eb', P3: '#6b7280' };

  var preconditions = [];
  if (Array.isArray(s.preconditions)) { preconditions = s.preconditions; }
  else if (typeof s.preconditions === 'string') {
    try { preconditions = JSON.parse(s.preconditions); } catch(e) { preconditions = [s.preconditions]; }
  }

  var btnBase = { width: '28px', height: '28px', borderRadius: '4px', fontSize: '14px', cursor: 'pointer' };

  return React.createElement('div', { key: s.id, style: { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px', marginBottom: '8px' } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
      React.createElement('div', { style: { flex: 1 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
          React.createElement('span', { style: { fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', fontWeight: '600', backgroundColor: cfg.bg, color: cfg.color } }, cfg.label),
          React.createElement('span', { style: { fontSize: '11px', fontWeight: '700', color: priorityColors[s.priority] || '#6b7280' } }, s.priority)
        ),
        React.createElement('h3', { style: { fontSize: '14px', fontWeight: '600', margin: '0 0 2px' } }, s.title),
        s.summary && React.createElement('p', { style: { fontSize: '13px', color: '#6b7280', margin: 0, lineHeight: '1.4' } }, s.summary)
      ),
      React.createElement('div', { style: { display: 'flex', gap: '4px', flexShrink: 0 } },
        s.status !== 'approved' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #bbf7d0', backgroundColor: '#dcfce7', color: '#16a34a' }),
          onClick: function() { onStatusChange(s.id, 'approved'); }, title: 'Approve'
        }, '\u2713'),
        s.status !== 'rejected' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #fecaca', backgroundColor: '#fee2e2', color: '#dc2626' }),
          onClick: function() { onStatusChange(s.id, 'rejected'); }, title: 'Reject'
        }, '\u2715'),
        s.status !== 'pending' && React.createElement('button', {
          style: Object.assign({}, btnBase, { border: '1px solid #e5e7eb', backgroundColor: '#f3f4f6', color: '#6b7280' }),
          onClick: function() { onStatusChange(s.id, 'pending'); }, title: 'Reset to Pending'
        }, '\u21BA')
      )
    ),
    // Details section
    React.createElement('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #f3f4f6', fontSize: '13px', color: '#374151' } },
      s.test_intent && React.createElement('div', { style: { marginBottom: '6px' } }, React.createElement('strong', null, 'Test Intent: '), s.test_intent),
      preconditions.length > 0 && React.createElement('div', { style: { marginBottom: '6px' } },
        React.createElement('strong', null, 'Preconditions: '),
        preconditions.join(' | ')
      ),
      s.expected_outcome && React.createElement('div', { style: { marginBottom: '6px' } }, React.createElement('strong', null, 'Expected: '), s.expected_outcome)
    )
  );
}
