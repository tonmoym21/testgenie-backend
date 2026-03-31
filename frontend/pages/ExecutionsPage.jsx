import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { Loader2, CheckCircle, XCircle, Play, Clock, Monitor, Globe } from 'lucide-react';

const STATUS_ICON = {
  passed: <CheckCircle size={16} className="text-green-500" />,
  failed: <XCircle size={16} className="text-red-500" />,
};

const TYPE_ICON = {
  ui: <Monitor size={14} />,
  api: <Globe size={14} />,
};

export default function ExecutionsPage() {
  const [executions, setExecutions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [pagination, setPagination] = useState({ page: 1, total: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page: pagination.page, limit: 20 };
      if (filter !== 'all') params.status = filter;
      const data = await api.request('GET', `/executions?${new URLSearchParams(params)}`);
      setExecutions(data.data);
      setPagination((p) => ({ ...p, total: data.pagination.total }));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filter, pagination.page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Test Executions</h1>
          <p className="text-gray-500 text-sm mt-1">History of all test runs</p>
        </div>
        <div className="flex gap-2">
          {['all', 'passed', 'failed'].map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPagination((p) => ({ ...p, page: 1 })); }}
              className={`btn text-xs capitalize ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={24} className="animate-spin text-brand-600" />
        </div>
      ) : executions.length === 0 ? (
        <div className="text-center py-20">
          <Play size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600 mb-1">No executions yet</h3>
          <p className="text-gray-400 text-sm">Run a test via the API to see results here</p>
        </div>
      ) : (
        <div className="space-y-2">
          {executions.map((exec) => (
            <Link
              key={exec.id}
              to={`/executions/${exec.id}`}
              className="card p-4 flex items-center justify-between hover:border-brand-300 hover:shadow-md transition-all group"
            >
              <div className="flex items-center gap-3">
                {STATUS_ICON[exec.status] || <Clock size={16} className="text-gray-400" />}
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm">{exec.testName}</h3>
                    <span className="badge bg-gray-100 text-gray-500 flex items-center gap-1">
                      {TYPE_ICON[exec.testType]} {exec.testType.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
                    <span>{exec.durationMs}ms</span>
                    <span>{new Date(exec.completedAt).toLocaleString()}</span>
                    {exec.error && <span className="text-red-400 truncate max-w-xs">{exec.error}</span>}
                  </div>
                </div>
              </div>
              <span className={`badge ${exec.status === 'passed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {exec.status}
              </span>
            </Link>
          ))}
        </div>
      )}

      {pagination.total > 20 && (
        <div className="flex justify-center gap-2 mt-6">
          <button
            onClick={() => setPagination((p) => ({ ...p, page: Math.max(1, p.page - 1) }))}
            disabled={pagination.page === 1}
            className="btn-secondary text-xs"
          >
            Previous
          </button>
          <span className="text-sm text-gray-400 py-2">
            Page {pagination.page} of {Math.ceil(pagination.total / 20)}
          </span>
          <button
            onClick={() => setPagination((p) => ({ ...p, page: p.page + 1 }))}
            disabled={pagination.page >= Math.ceil(pagination.total / 20)}
            className="btn-secondary text-xs"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
