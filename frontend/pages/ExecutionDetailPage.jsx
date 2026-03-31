import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../services/api';
import { ArrowLeft, Loader2, CheckCircle, XCircle, Clock, Image, Terminal, AlertTriangle, Info } from 'lucide-react';

const LOG_ICON = {
  info: <Info size={12} className="text-blue-400 mt-0.5 shrink-0" />,
  warn: <AlertTriangle size={12} className="text-yellow-500 mt-0.5 shrink-0" />,
  error: <XCircle size={12} className="text-red-500 mt-0.5 shrink-0" />,
  debug: <Terminal size={12} className="text-gray-400 mt-0.5 shrink-0" />,
};

export default function ExecutionDetailPage() {
  const { executionId } = useParams();
  const [exec, setExec] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.request('GET', `/executions/${executionId}`);
        setExec(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [executionId]);

  if (loading) {
    return (
      <div className="flex justify-center py-32">
        <Loader2 size={24} className="animate-spin text-brand-600" />
      </div>
    );
  }

  if (!exec) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">Execution not found</p>
        <Link to="/executions" className="text-brand-600 text-sm mt-2 inline-block">Back to executions</Link>
      </div>
    );
  }

  const logs = typeof exec.logs === 'string' ? JSON.parse(exec.logs) : exec.logs || [];
  const screenshots = typeof exec.screenshots === 'string' ? JSON.parse(exec.screenshots) : exec.screenshots || [];
  const filteredLogs = showDebug ? logs : logs.filter((l) => l.level !== 'debug');

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link to="/executions" className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1 mb-3">
        <ArrowLeft size={14} /> Back to Executions
      </Link>

      {/* Header */}
      <div className="card p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              {exec.status === 'passed' ? (
                <CheckCircle size={24} className="text-green-500" />
              ) : (
                <XCircle size={24} className="text-red-500" />
              )}
              <h1 className="text-xl font-semibold">{exec.testName}</h1>
            </div>
            {exec.error && (
              <div className="mt-3 bg-red-50 text-red-700 text-sm px-4 py-3 rounded-lg border border-red-200">
                {exec.error}
              </div>
            )}
          </div>
          <span className={`badge text-sm px-3 py-1 ${exec.status === 'passed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {exec.status.toUpperCase()}
          </span>
        </div>

        <div className="flex gap-6 mt-4 text-sm text-gray-500">
          <span className="flex items-center gap-1.5"><Clock size={14} /> {exec.durationMs}ms</span>
          <span>Type: {exec.testType?.toUpperCase()}</span>
          <span>Completed: {new Date(exec.completedAt).toLocaleString()}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Logs */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Terminal size={16} /> Execution Logs
              </h2>
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
                Show debug
              </label>
            </div>
            <div className="p-4 max-h-[600px] overflow-y-auto">
              {filteredLogs.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No logs available</p>
              ) : (
                <div className="space-y-1.5">
                  {filteredLogs.map((log, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs font-mono">
                      {LOG_ICON[log.level] || LOG_ICON.info}
                      <span className="text-gray-400 shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={`${log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-yellow-600' : 'text-gray-700'}`}>
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Screenshots */}
        <div>
          <div className="card">
            <div className="px-5 py-3 border-b border-gray-100">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Image size={16} /> Screenshots ({screenshots.length})
              </h2>
            </div>
            <div className="p-4">
              {screenshots.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No screenshots captured</p>
              ) : (
                <div className="space-y-3">
                  {screenshots.map((filename, i) => (
                    <div key={i} className="border rounded-lg overflow-hidden">
                      <img
                        src={`/api/screenshots/${filename}`}
                        alt={`Screenshot ${i + 1}`}
                        className="w-full h-auto"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                      <div className="px-3 py-2 bg-gray-50 text-xs text-gray-500 truncate">
                        {filename}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Test Definition */}
          {exec.testDefinition && (
            <div className="card mt-6">
              <div className="px-5 py-3 border-b border-gray-100">
                <h2 className="font-semibold text-sm">Test Definition</h2>
              </div>
              <div className="p-4">
                <pre className="text-xs font-mono bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64">
                  {JSON.stringify(typeof exec.testDefinition === 'string' ? JSON.parse(exec.testDefinition) : exec.testDefinition, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
