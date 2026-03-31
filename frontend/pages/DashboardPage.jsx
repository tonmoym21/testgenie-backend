import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { Loader2, CheckCircle, XCircle, Clock, TrendingUp, BarChart3, Download, Monitor, Globe } from 'lucide-react';

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.request('GET', '/reports/summary');
        setStats(data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await api.request('GET', '/reports/export');
      const csv = convertToCSV(data.data);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `testgenie-report-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-32">
        <Loader2 size={24} className="animate-spin text-brand-600" />
      </div>
    );
  }

  if (!stats || stats.total === 0) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center py-20">
        <BarChart3 size={48} className="mx-auto text-gray-300 mb-4" />
        <h3 className="text-lg font-medium text-gray-600 mb-1">No data yet</h3>
        <p className="text-gray-400 text-sm">Run some tests to see your dashboard</p>
      </div>
    );
  }

  const passedCount = stats.statusCounts.find((s) => s.status === 'passed')?.count || 0;
  const failedCount = stats.statusCounts.find((s) => s.status === 'failed')?.count || 0;
  const uiCount = stats.typeCounts.find((t) => t.type === 'ui')?.count || 0;
  const apiCount = stats.typeCounts.find((t) => t.type === 'api')?.count || 0;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Test execution overview</p>
        </div>
        <button onClick={handleExport} disabled={exporting} className="btn-secondary">
          {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          Export CSV
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Pass Rate" value={`${stats.passRate}%`} icon={<TrendingUp size={20} />}
          color={stats.passRate >= 80 ? 'green' : stats.passRate >= 50 ? 'yellow' : 'red'} />
        <StatCard label="Total Runs" value={stats.total} icon={<BarChart3 size={20} />} color="blue" />
        <StatCard label="Passed" value={passedCount} icon={<CheckCircle size={20} />} color="green" />
        <StatCard label="Failed" value={failedCount} icon={<XCircle size={20} />} color="red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Test Type Breakdown */}
        <div className="card p-5">
          <h3 className="font-semibold text-sm mb-4">By Test Type</h3>
          <div className="space-y-3">
            <TypeBar label="UI Tests" count={uiCount} total={stats.total} icon={<Monitor size={14} />} color="bg-brand-500" />
            <TypeBar label="API Tests" count={apiCount} total={stats.total} icon={<Globe size={14} />} color="bg-purple-500" />
          </div>
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h4 className="text-xs text-gray-400 mb-2">Avg Duration</h4>
            {stats.avgDuration.map((d) => (
              <div key={d.type} className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">{d.type.toUpperCase()}</span>
                <span className="font-mono text-gray-900">{d.avgDurationMs}ms</span>
              </div>
            ))}
          </div>
        </div>

        {/* Daily Trend (text-based chart) */}
        <div className="card p-5">
          <h3 className="font-semibold text-sm mb-4">Last 30 Days</h3>
          {stats.dailyTrend.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No trend data yet</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {stats.dailyTrend.map((day) => {
                const maxVal = Math.max(...stats.dailyTrend.map((d) => d.total), 1);
                return (
                  <div key={day.date} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 w-20 shrink-0 font-mono">
                      {new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    </span>
                    <div className="flex-1 flex h-5 rounded overflow-hidden bg-gray-100">
                      <div
                        className="bg-green-400 transition-all"
                        style={{ width: `${(day.passed / maxVal) * 100}%` }}
                        title={`${day.passed} passed`}
                      />
                      <div
                        className="bg-red-400 transition-all"
                        style={{ width: `${(day.failed / maxVal) * 100}%` }}
                        title={`${day.failed} failed`}
                      />
                    </div>
                    <span className="text-gray-500 w-8 text-right">{day.total}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex gap-4 mt-3 text-xs text-gray-400">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-400" /> Passed</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-400" /> Failed</span>
          </div>
        </div>
      </div>

      {/* Recent Failures */}
      {stats.recentFailures.length > 0 && (
        <div className="card">
          <div className="px-5 py-3 border-b border-gray-100">
            <h3 className="font-semibold text-sm">Recent Failures</h3>
          </div>
          <div className="divide-y divide-gray-50">
            {stats.recentFailures.map((f) => (
              <Link
                key={f.id}
                to={`/executions/${f.id}`}
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
              >
                <div>
                  <span className="text-sm font-medium">{f.testName}</span>
                  <p className="text-xs text-red-500 mt-0.5 truncate max-w-md">{f.error}</p>
                </div>
                <div className="text-xs text-gray-400">
                  {f.durationMs}ms
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon, color }) {
  const colors = {
    green: 'bg-green-50 text-green-600',
    red: 'bg-red-50 text-red-600',
    blue: 'bg-brand-50 text-brand-600',
    yellow: 'bg-yellow-50 text-yellow-600',
  };

  return (
    <div className="card p-5">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${colors[color]}`}>
        {icon}
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function TypeBar({ label, count, total, icon, color }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="flex items-center gap-1.5 text-gray-600">{icon} {label}</span>
        <span className="text-gray-900 font-medium">{count} <span className="text-gray-400 font-normal">({pct}%)</span></span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function convertToCSV(data) {
  if (!data || data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = data.map((row) => headers.map((h) => JSON.stringify(row[h] ?? '')).join(','));
  return [headers.join(','), ...rows].join('\n');
}
