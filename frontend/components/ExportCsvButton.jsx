import React, { useState } from 'react';
import './ExportCsvButton.css';

/**
 * ExportCsvButton Component
 * Triggers CSV export of test cases and initiates browser download
 * 
 * Usage:
 *   <ExportCsvButton projectId={projectId} />
 *   <ExportCsvButton projectId={projectId} selectedTestCaseIds={[id1, id2]} />
 *   <ExportCsvButton projectId={projectId} disabled={!hasTestCases} />
 */
export function ExportCsvButton({ projectId, selectedTestCaseIds = null, disabled = false }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Get auth token from localStorage or sessionStorage
      const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
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

      // Build request body
      const body = selectedTestCaseIds && selectedTestCaseIds.length > 0
        ? { testCaseIds: selectedTestCaseIds }
        : {};

      // Call backend export route
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/testcases/export-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
      });

      // Handle errors
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

      // Extract filename from Content-Disposition header
      const contentDisposition = response.headers.get('content-disposition');
      let filename = 'testcases.csv';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="([^"]+)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      // Convert response to blob and trigger download
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

      // Cleanup
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);

      setError(null);
      setSuccess(true);
      setIsLoading(false);

      // Auto-dismiss success message
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

  const buttonLabel = selectedTestCaseIds && selectedTestCaseIds.length > 0
    ? `Export Selected (${selectedTestCaseIds.length})`
    : 'Export All to CSV';

  const tooltipText = disabled
    ? 'No test cases available to export'
    : selectedTestCaseIds && selectedTestCaseIds.length > 0
      ? `Export ${selectedTestCaseIds.length} selected test cases as CSV file`
      : 'Export all test cases as CSV file';

  return (
    <div className="export-csv-button-container">
      <button
        onClick={handleExport}
        disabled={disabled || isLoading}
        className="export-csv-button"
        aria-label={buttonLabel}
        title={tooltipText}
      >
        {isLoading ? (
          <>
            <span className="spinner"></span>
            <span>Exporting...</span>
          </>
        ) : (
          <>
            <span className="icon">⬇️</span>
            <span>{buttonLabel}</span>
          </>
        )}
      </button>

      {error && (
        <div
          className="error-message"
          role="alert"
          aria-live="polite"
        >
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div
          className="success-message"
          role="status"
          aria-live="polite"
        >
          ✅ Test cases exported successfully!
        </div>
      )}
    </div>
  );
}

export default ExportCsvButton;