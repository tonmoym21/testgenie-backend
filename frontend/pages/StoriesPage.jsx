import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { listStories, deleteStory } from '../services/storyApi';

export default function StoriesPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(function() { loadStories(); }, [projectId]);

  async function loadStories() {
    try {
      setLoading(true); setError(null);
      const data = await listStories(projectId);
      setStories(data);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleDelete(storyId) {
    if (!window.confirm('Delete this story and all its scenarios?')) return;
    try {
      await deleteStory(projectId, storyId);
      setStories(function(prev) { return prev.filter(function(s) { return s.id !== storyId; }); });
    } catch (err) { alert('Failed to delete: ' + err.message); }
  }

  var statusColors = { draft: '#6b7280', extracted: '#2563eb', reviewed: '#16a34a', exported: '#7c3aed' };

  if (loading) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#6b7280' } }, 'Loading stories...');
  if (error) return React.createElement('div', { style: { textAlign: 'center', padding: '40px', color: '#dc2626' } }, 'Error: ' + error);

  return React.createElement('div', { style: { maxWidth: '800px', margin: '0 auto', padding: '24px' } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' } },
      React.createElement('div', null,
        React.createElement(Link, { to: '/projects/' + projectId, style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\u2190 Back to Project'),
        React.createElement('h1', { style: { fontSize: '24px', fontWeight: '700', margin: '8px 0 4px' } }, 'User Stories'),
        React.createElement('p', { style: { color: '#6b7280', fontSize: '14px', margin: 0 } }, 'Submit user stories to generate test scenarios and export CSV')
      ),
      React.createElement('button', {
        style: { backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
        onClick: function() { navigate('/projects/' + projectId + '/stories/new'); }
      }, '+ New Story')
    ),
    stories.length === 0
      ? React.createElement('div', { style: { textAlign: 'center', padding: '60px 20px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px dashed #d1d5db' } },
          React.createElement('p', { style: { fontSize: '18px', marginBottom: '8px' } }, 'No stories yet'),
          React.createElement('p', { style: { color: '#6b7280' } }, 'Create your first user story to start generating test scenarios.'),
          React.createElement('button', {
            style: { backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', padding: '10px 18px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', marginTop: '16px' },
            onClick: function() { navigate('/projects/' + projectId + '/stories/new'); }
          }, '+ Create First Story')
        )
      : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          stories.map(function(story) {
            return React.createElement('div', {
              key: story.id,
              style: { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px', cursor: 'pointer' },
              onClick: function() { navigate('/projects/' + projectId + '/stories/' + story.id); }
            },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                React.createElement('h3', { style: { fontSize: '16px', fontWeight: '600', margin: 0 } }, story.title),
                React.createElement('span', { style: { color: '#fff', fontSize: '11px', padding: '2px 8px', borderRadius: '9999px', fontWeight: '600', backgroundColor: statusColors[story.status] || '#6b7280' } }, story.status)
              ),
              React.createElement('p', { style: { color: '#4b5563', fontSize: '14px', margin: '0 0 12px', lineHeight: '1.5' } },
                (story.description || '').substring(0, 150) + (story.description && story.description.length > 150 ? '...' : '')
              ),
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                React.createElement('span', { style: { color: '#9ca3af', fontSize: '12px' } },
                  (story.scenario_count || 0) + ' scenarios' + (story.approved_count > 0 ? ' \u00B7 ' + story.approved_count + ' approved' : '')
                ),
                React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                  React.createElement('span', { style: { color: '#9ca3af', fontSize: '12px' } }, new Date(story.created_at).toLocaleDateString()),
                  React.createElement('button', {
                    style: { background: 'none', border: 'none', color: '#9ca3af', fontSize: '18px', cursor: 'pointer', padding: '0 4px', lineHeight: '1' },
                    onClick: function(e) { e.stopPropagation(); handleDelete(story.id); }
                  }, '\u00D7')
                )
              )
            );
          })
        )
  );
}
