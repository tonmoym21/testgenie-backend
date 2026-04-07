import React, { useState } from 'react';
import { Loader2, Download } from 'lucide-react';

export function ExportCsvButton({ projectId, selectedTestCaseIds = null, disabled = false }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        setError('Authentication required. Please log in.');
        setIsLoading(false);
        return;
      }

      if (!projectId) {
        setError('Invalid project ID.');
        setIsLoading(false);
        return;
      }

      const body =
        selectedTestCaseIds && selectedTestCaseIds.length > 0
          ? { testCaseIds: selectedTestCaseIds }
          : {};

      const API_BASE = window.location.hostname === 'localhost'
        ? '/api'
        : 'https://testgenie-backend-production.up.railway.app/api';

      const response = await fetch(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/testcases/export-csv`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),   // <-- ALWAYS send a JSON body
        }
      );

      if (!response.ok) {
        let errorMessage = `Export failed with status ${response.status}`;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // Response not JSON
        }
        setError(errorMessage);
        setIsLoading(false);
        return;
      }

      const contentDisposition = response.headers.get('content-disposition');
      let filename = 'testcases.csv';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="([^"]+)"/);
        if (match && match[1]) filename = match[1];
      }

      const blob = await response.blob();

      if (!blob || blob.size === 0) {
        setError('Downloaded file is empty.');
        setIsLoading(false);
        return;
      }

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);

      setError(null);
      setSuccess(true);
      setIsLoading(false);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      let errorMessage = 'An unexpected error occurred during export';
      if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
        errorMessage = 'Network error. Please check your connection and try again.';
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }
      setError(errorMessage);
      console.error('[ExportCsvButton] Error:', err);
      setIsLoading(false);
    }
  };

  const buttonLabel =
    selectedTestCaseIds && selectedTestCaseIds.length > 0
      ? `Export Selected (${selectedTestCaseIds.length})`
      : 'Export All to CSV';

  const tooltipText = disabled
    ? 'No test cases available to export'
    : selectedTestCaseIds && selectedTestCaseIds.length > 0
      ? `Export ${selectedTestCaseIds.length} selected test cases as CSV file`
      : 'Export all test cases as CSV file';

  return (
    <div className="relative inline-flex flex-col items-end gap-1">
      <button
        onClick={handleExport}
        disabled={disabled || isLoading}
        className={
          'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ' +
          (disabled || isLoading
            ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
            : 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800')
        }
        aria-label={buttonLabel}
        title={tooltipText}
      >
        {isLoading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            <span>Exporting...</span>
          </>
        ) : (
          <>
            <Download size={16} />
            <span>{buttonLabel}</span>
          </>
        )}
      </button>

      {error && (
        <div
          className="absolute top-full mt-2 right-0 w-64 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 shadow-lg z-50"
          role="alert"
          aria-live="polite"
        >
          {error}
        </div>
      )}

      {success && (
        <div
          className="absolute top-full mt-2 right-0 w-52 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 shadow-lg z-50"
          role="status"
          aria-live="polite"
        >
          Exported successfully!
        </div>
      )}
    </div>
  );
}

export default ExportCsvButton;