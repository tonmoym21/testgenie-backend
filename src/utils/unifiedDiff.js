// src/utils/unifiedDiff.js
// Minimal unified-diff generator. Standalone (no `diff` package) because we
// only need to render the patch for storage and human review, not to apply it
// programmatically — that responsibility stays with `git apply` downstream.

/**
 * Render a unified diff between two text blobs. Output matches the format
 * `git diff` produces (--- / +++ headers + @@ hunks). LCS-based, O(N*M),
 * fine for spec files (hundreds of lines, not thousands).
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {string} filename  used in the --- / +++ headers
 * @param {number} context   lines of unchanged context per hunk (default 3)
 * @returns {string}         empty string when texts are identical
 */
function unifiedDiff(oldText, newText, filename = 'file', context = 3) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  if (oldText === newText) return '';

  const ops = diffLines(a, b);
  const hunks = groupHunks(ops, context);
  if (hunks.length === 0) return '';

  const header = `--- a/${filename}\n+++ b/${filename}\n`;
  return header + hunks.map(renderHunk).join('');
}

// ---------------------------------------------------------------------------
// LCS-based line diff
// ---------------------------------------------------------------------------

function diffLines(a, b) {
  const m = a.length, n = b.length;
  // dp[i][j] = LCS length of a[0..i) vs b[0..j)
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack into a flat op list: { type: ' '|'-'|'+', line, oldIdx, newIdx }
  const ops = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: ' ', line: a[i - 1], oldIdx: i, newIdx: j });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: '-', line: a[i - 1], oldIdx: i, newIdx: j });
      i--;
    } else {
      ops.push({ type: '+', line: b[j - 1], oldIdx: i, newIdx: j });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: '-', line: a[i - 1], oldIdx: i, newIdx: j }); i--; }
  while (j > 0) { ops.push({ type: '+', line: b[j - 1], oldIdx: i, newIdx: j }); j--; }
  ops.reverse();
  return ops;
}

// ---------------------------------------------------------------------------
// Hunk grouping: keep `context` unchanged lines around each change block
// ---------------------------------------------------------------------------

function groupHunks(ops, context) {
  const changedIdx = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== ' ') changedIdx.push(k);
  }
  if (changedIdx.length === 0) return [];

  const hunks = [];
  let start = Math.max(0, changedIdx[0] - context);
  let end = Math.min(ops.length - 1, changedIdx[0] + context);

  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k];
    if (idx - context <= end + 1) {
      end = Math.min(ops.length - 1, idx + context);
    } else {
      hunks.push(ops.slice(start, end + 1));
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  hunks.push(ops.slice(start, end + 1));
  return hunks;
}

function renderHunk(hunkOps) {
  const oldLines = hunkOps.filter((o) => o.type !== '+');
  const newLines = hunkOps.filter((o) => o.type !== '-');
  const oldStart = oldLines.length > 0 ? oldLines[0].oldIdx : 0;
  const newStart = newLines.length > 0 ? newLines[0].newIdx : 0;
  const head = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@\n`;
  return head + hunkOps.map((o) => `${o.type}${o.line}\n`).join('');
}

module.exports = { unifiedDiff };
