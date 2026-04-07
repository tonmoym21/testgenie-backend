import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { createStory } from '../services/storyApi';

export default function CreateStoryPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState('text');
  const [sourceUrl, setSourceUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return setError('Title is required');
    if (description.trim().length < 20) return setError('Description must be at least 20 characters');
    try {
      setSubmitting(true); setError(null);
      var story = await createStory(projectId, {
        title: title.trim(), description: description.trim(),
        sourceType: sourceType, sourceUrl: sourceType === 'url' ? sourceUrl.trim() : null,
      });
      navigate('/projects/' + projectId + '/stories/' + story.id);
    } catch (err) { setError(err.message); }
    finally { setSubmitting(false); }
  }

  var inputStyle = { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px', outline: 'none', width: '100%', boxSizing: 'border-box' };

  return React.createElement('div', { style: { maxWidth: '700px', margin: '0 auto', padding: '24px' } },
    React.createElement(Link, { to: '/projects/' + projectId + '/stories', style: { color: '#2563eb', textDecoration: 'none', fontSize: '14px' } }, '\u2190 Back to Stories'),
    React.createElement('h1', { style: { fontSize: '24px', fontWeight: '700', margin: '8px 0 4px' } }, 'New User Story'),
    React.createElement('p', { style: { color: '#6b7280', fontSize: '14px', margin: '0 0 24px' } }, 'Paste a user story or feature description. The system will generate test scenarios automatically.'),

    React.createElement('form', { onSubmit: handleSubmit, style: { display: 'flex', flexDirection: 'column', gap: '20px' } },
      error && React.createElement('div', { style: { backgroundColor: '#fef2f2', color: '#dc2626', padding: '12px', borderRadius: '6px', border: '1px solid #fecaca', fontSize: '14px' } }, error),

      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
        'Title *',
        React.createElement('input', { type: 'text', value: title, onChange: function(e) { setTitle(e.target.value); }, placeholder: 'e.g. User Login with Email and Password', style: inputStyle, maxLength: 256 })
      ),

      React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
        'Story Description *',
        React.createElement('textarea', { value: description, onChange: function(e) { setDescription(e.target.value); }, placeholder: 'Paste the full user story here including acceptance criteria...', style: Object.assign({}, inputStyle, { fontFamily: 'inherit', resize: 'vertical', minHeight: '200px' }), maxLength: 10240 }),
        React.createElement('span', { style: { fontSize: '12px', color: '#9ca3af', textAlign: 'right' } }, description.length + '/10,240 characters (min 20)')
      ),

      React.createElement('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-end' } },
        React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500' } },
          'Source',
          React.createElement('select', { value: sourceType, onChange: function(e) { setSourceType(e.target.value); }, style: inputStyle },
            React.createElement('option', { value: 'text' }, 'Pasted Text'),
            React.createElement('option', { value: 'url' }, 'URL (Jira/GitHub/etc.)')
          )
        ),
        sourceType === 'url' && React.createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: '500', flex: 2 } },
          'Source URL',
          React.createElement('input', { type: 'url', value: sourceUrl, onChange: function(e) { setSourceUrl(e.target.value); }, placeholder: 'https://jira.example.com/browse/PROJ-123', style: inputStyle })
        )
      ),

      React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '12px', paddingTop: '12px' } },
        React.createElement('button', { type: 'button', onClick: function() { navigate('/projects/' + projectId + '/stories'); }, style: { padding: '10px 18px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#fff', fontSize: '14px', cursor: 'pointer' } }, 'Cancel'),
        React.createElement('button', { type: 'submit', disabled: submitting, style: { padding: '10px 18px', border: 'none', borderRadius: '6px', backgroundColor: '#2563eb', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer' } }, submitting ? 'Creating...' : 'Create Story & Generate Scenarios')
      )
    )
  );
}
