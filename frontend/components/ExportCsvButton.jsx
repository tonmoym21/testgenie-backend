import React, { useState } from 'react';
import './ExportCsvButton.css';

/**
 * ExportCsvButton Component
 * Triggers CSV export of approved scenarios and initiates browser download
 * 
 * Usage:
 *   <ExportCsvButton storyId={storyId} />
 *   <ExportCsvButton storyId={storyId} disabled={!hasApprovedScenarios} />
 */
export function ExportCsvButton({ storyId, disabled = false }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleExport = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Get auth token from localStorage or sessionStorage
      const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
      if (!token) {
        setError('Authentication required. Please log in.');
        setIsLoading(false);
        return;
      }

      if (!storyId) {
        setError('Invalid story ID.');
        setIsLoading(false);
        return;
      }

      // Call backend export route
      const response = await fetch(`/api/stories/${encodeURIComponent(storyId)}/export-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
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
      setIsLoading(false);

      // Success notification
      alert(`✅ Downloaded ${filename}`);
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

  return (
    <div className="export-csv-button-container">
      <button
        onClick={handleExport}
        disabled={disabled || isLoading}
        className="export-csv-button"
        aria-label="Export test cases to CSV"
        title={
          disabled
            ? 'No approved scenarios to export'
            : 'Export approved scenarios as CSV file'
        }
      >
        {isLoading ? (
          <>
            <span className="spinner"></span>
            <span>Exporting...</span>
          </>
        ) : (
          <>
            <span className="icon">⬇️</span>
            <span>Export to CSV</span>
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
    </div>
  );
}
