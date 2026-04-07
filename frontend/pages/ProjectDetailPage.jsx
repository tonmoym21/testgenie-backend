import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/api';
import { Loader2, Plus, Trash2, AlertCircle, BookOpen } from 'lucide-react';
import ExportCsvButton from '../components/ExportCsvButton';
import { useParams, useNavigate } from 'react-router-dom';

export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [testCases, setTestCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({ title: '', content: '', priority: 'medium' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);

  // Load project and test cases
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [projectData, testCasesData] = await Promise.all([
          api.request('GET', `/projects/${projectId}`),
          api.request('GET', `/projects/${projectId}/testcases`),
        ]);
        setProject(projectData);
        setTestCases(testCasesData.data || []);
        setError(null);
      } catch (err) {
        console.error('Error loading project:', err);
        setError('Failed to load project');
      } finally {
        setLoading(false);
      }
    }
    if (projectId) load();
  }, [projectId]);

  // Handle add test case
  const handleAddTestCase = async (e) => {
    e.preventDefault();
    if (!formData.title.trim() || !formData.content.trim()) {
      setError('Title and content are required');
      return;
    }

    try {
      setSubmitting(true);
      const newTestCase = await api.request('POST', `/projects/${projectId}/testcases`, formData);
      setTestCases([newTestCase, ...testCases]);
      setFormData({ title: '', content: '', priority: 'medium' });
      setShowAddForm(false);
      setError(null);
    } catch (err) {
      console.error('Error adding test case:', err);
      setError('Failed to add test case');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle delete test case
  const handleDeleteTestCase = async (testCaseId) => {
    if (!window.confirm('Delete this test case?')) return;

    try {
      await api.request('DELETE', `/projects/${projectId}/testcases/${testCaseId}`);
      setTestCases(testCases.filter((tc) => tc.id !== testCaseId));
      setSelectedIds(selectedIds.filter((id) => id !== testCaseId));
    } catch (err) {
      console.error('Error deleting test case:', err);
      setError('Failed to delete test case');
    }
  };

  // Toggle test case selection
  const toggleSelection = (id) => {
    setSelectedIds(selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id]);
  };

  if (loading) {
    return (
      <div className="flex justify-center py-32">
        <Loader2 size={24} className="animate-spin text-brand-600" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center py-20">
        <AlertCircle size={48} className="mx-auto text-gray-300 mb-4" />
        <h3 className="text-lg font-medium text-gray-600 mb-1">Project not found</h3>
        <p className="text-gray-400 text-sm">The project you're looking for doesn't exist.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-gray-500 text-sm mt-1">Test Cases</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/projects/' + projectId + '/stories')}
            className="btn-secondary flex items-center gap-2"
          >
            <BookOpen size={16} /> Stories
          </button>
          <ExportCsvButton
  projectId={projectId}
  selectedTestCaseIds={selectedIds.length > 0 ? selectedIds : null}
  disabled={testCases.length === 0}
/>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus size={16} /> Add Test Case
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle size={18} className="text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Add Test Case Form */}
      {showAddForm && (
        <div className="card p-6 mb-8">
          <h3 className="font-semibold mb-4">New Test Case</h3>
          <form onSubmit={handleAddTestCase} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., User can login with email"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Content / Steps</label>
              <textarea
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                placeholder="e.g., 1. Navigate to login\n2. Enter email and password\n3. Click submit"
                rows="4"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button type="submit" disabled={submitting} className="btn-primary">
                {submitting ? <Loader2 size={16} className="animate-spin" /> : 'Create Test Case'}
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Test Cases List */}
      {testCases.length === 0 ? (
        <div className="card p-12 text-center">
          <AlertCircle size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600 mb-1">No test cases yet</h3>
          <p className="text-gray-400 text-sm mb-6">Create your first test case to get started</p>
          <button onClick={() => setShowAddForm(true)} className="btn-primary">
            Add Test Case
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {testCases.map((tc) => (
            <div key={tc.id} className="card p-4 flex items-start gap-3 hover:bg-gray-50 transition-colors">
              <input
                type="checkbox"
                checked={selectedIds.includes(tc.id)}
                onChange={() => toggleSelection(tc.id)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-gray-900 truncate">{tc.title}</h4>
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{tc.content}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                  <span className="px-2 py-1 bg-gray-100 rounded capitalize">{tc.priority}</span>
                  <span>{new Date(tc.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                onClick={() => handleDeleteTestCase(tc.id)}
                className="text-gray-400 hover:text-red-600 transition-colors p-2"
                title="Delete test case"
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Selection Summary */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-4 right-4 bg-brand-600 text-white px-4 py-2 rounded-lg shadow-lg text-sm">
          {selectedIds.length} test case{selectedIds.length !== 1 ? 's' : ''} selected
        </div>
      )}
    </div>
  );
}