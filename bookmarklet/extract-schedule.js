/**
 * NJIT Banner Schedule Extractor
 *
 * Run this on https://generalssb-prod.ec.njit.edu/BannerExtensibility/customPage/page/stuRegCrseSched
 * while logged in. It reads the subject list from the Angular scope, fetches all
 * sections for every subject, then downloads a single combined Excel-compatible
 * CSV in the same format the njit-empty-rooms app expects.
 *
 * Usage:
 *   1. Log into Banner SSB and navigate to the course schedule page.
 *   2. Open DevTools → Console.
 *   3. Paste this entire script and press Enter.
 *   4. Wait for the "Download ready" alert — a CSV file will be saved.
 *
 * To make a bookmarklet, minify this file and prepend "javascript:" to the result.
 */

(async function () {
  // ── 1. Grab Angular scope ──────────────────────────────────────────────────

  const rootEl = document.querySelector('[ng-controller]') ||
                 document.querySelector('[data-ng-controller]') ||
                 document.querySelector('.ng-scope');

  if (!rootEl) {
    alert('Could not find Angular root element. Are you on the Banner schedule page?');
    return;
  }

  const $scope = angular.element(rootEl).scope();
  if (!$scope) {
    alert('Could not access Angular $scope. Make sure you are on the schedule page.');
    return;
  }

  // ── 2. Get term and subject list ───────────────────────────────────────────

  const term = $scope.selectBlockTermSelect;
  if (!term) {
    alert('No term selected. Please select a term first, then run the script.');
    return;
  }

  // Subject list is loaded into the subjListTableDS or similar
  // Try several known binding names used in the page
  let subjects = [];

  if ($scope.subjListTableDS && $scope.subjListTableDS.data) {
    subjects = $scope.subjListTableDS.data.map(s => s.CODE || s.code || s.SUBJECT || s.subject).filter(Boolean);
  }

  if (subjects.length === 0) {
    // Fall back: look for subjList or similar
    for (const key of Object.keys($scope)) {
      if (key.toLowerCase().includes('subj') && Array.isArray($scope[key])) {
        const sample = $scope[key][0];
        if (sample) {
          const codeKey = Object.keys(sample).find(k => k.match(/code|subject/i));
          if (codeKey) {
            subjects = $scope[key].map(s => s[codeKey]).filter(Boolean);
            break;
          }
        }
      }
    }
  }

  if (subjects.length === 0) {
    // Last resort: fetch from virtualDomains directly
    console.log('Fetching subject list from API...');
    try {
      const subResp = await fetch('/BannerExtensibility/virtualDomains/stuRegCrseSchedSubjList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, pageSize: 150, offset: 0 }),
        credentials: 'include',
      });
      const subData = await subResp.json();
      const rows = subData.data || subData.rows || subData;
      if (Array.isArray(rows)) {
        const codeKey = rows[0] ? Object.keys(rows[0]).find(k => k.match(/code|subject/i)) : null;
        if (codeKey) subjects = rows.map(r => r[codeKey]).filter(Boolean);
      }
    } catch (e) {
      console.error('Subject list fetch failed:', e);
    }
  }

  if (subjects.length === 0) {
    alert('Could not find the subject list. Try selecting a term and waiting for the page to fully load.');
    return;
  }

  console.log(`Found ${subjects.length} subjects for term ${term}:`, subjects);

  // ── 3. CSV helpers ─────────────────────────────────────────────────────────

  const CSV_HEADERS = [
    'Term', 'Course', 'Title', 'Section', 'CRN', 'Days', 'Times',
    'Location', 'Status', 'Max', 'Now', 'Instructor', 'Delivery Mode',
    'Credits', 'Info', 'Comments',
  ];

  // Map API field names → CSV header names
  const FIELD_MAP = {
    TERM: 'Term',
    COURSE: 'Course',
    TITLE: 'Title',
    SECTION: 'Section',
    CRN: 'CRN',
    DAYS: 'Days',
    TIMES: 'Times',
    LOCATION: 'Location',
    STATUS: 'Status',
    MAX: 'Max',
    NOW: 'Now',
    INSTRUCTOR: 'Instructor',
    INSTRUCTION_METHOD: 'Delivery Mode',
    CREDITS: 'Credits',
    INFO_LINK: 'Info',
    COMMENTS: 'Comments',
  };

  function csvCell(val) {
    const s = val === null || val === undefined ? '' : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function rowToCSV(apiRow) {
    return CSV_HEADERS.map(header => {
      // Find the API key whose mapped name is this header
      const apiKey = Object.keys(FIELD_MAP).find(k => FIELD_MAP[k] === header);
      const val = apiKey ? apiRow[apiKey] : '';
      return csvCell(val);
    }).join(',');
  }

  // ── 4. Fetch all subjects ──────────────────────────────────────────────────

  const allRows = [];
  const failed = [];

  const ENDPOINT = '/BannerExtensibility/virtualDomains/stuRegCrseSchedSectionsExcel';

  // Show progress indicator
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 999999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: monospace; color: #fff; font-size: 16px;
  `;
  const progressText = document.createElement('div');
  progressText.textContent = 'Extracting schedule...';
  const progressBar = document.createElement('div');
  progressBar.style.cssText = 'width: 400px; height: 8px; background: #333; border-radius: 4px; margin-top: 16px;';
  const progressFill = document.createElement('div');
  progressFill.style.cssText = 'height: 100%; background: #cc0000; border-radius: 4px; width: 0%; transition: width 0.2s;';
  progressBar.appendChild(progressFill);
  overlay.appendChild(progressText);
  overlay.appendChild(progressBar);
  document.body.appendChild(overlay);

  for (let i = 0; i < subjects.length; i++) {
    const subj = subjects[i];
    progressText.textContent = `Fetching ${subj} (${i + 1}/${subjects.length})...`;
    progressFill.style.width = `${Math.round(((i + 1) / subjects.length) * 100)}%`;

    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          term,
          subject: subj,
          prof_ucid: '',
          attr: '',
          pageSize: -1,
          offset: 0,
        }),
        credentials: 'include',
      });

      if (!resp.ok) {
        console.warn(`${subj}: HTTP ${resp.status}`);
        failed.push(subj);
        continue;
      }

      const data = await resp.json();
      const rows = data.data || data.rows || data;
      if (Array.isArray(rows)) {
        allRows.push(...rows);
        console.log(`${subj}: ${rows.length} sections`);
      } else {
        console.warn(`${subj}: unexpected response shape`, data);
      }
    } catch (e) {
      console.error(`${subj} fetch failed:`, e);
      failed.push(subj);
    }

    // Small delay to avoid hammering the server
    await new Promise(r => setTimeout(r, 50));
  }

  document.body.removeChild(overlay);

  if (allRows.length === 0) {
    alert('No rows returned. The API response format may have changed — check the console for details.');
    return;
  }

  console.log(`Total sections fetched: ${allRows.length}`);
  if (failed.length > 0) {
    console.warn(`Failed subjects (${failed.length}):`, failed);
  }

  // ── 5. Build CSV ───────────────────────────────────────────────────────────

  // Detect actual field names from first row (API may use lowercase or camelCase)
  const firstRow = allRows[0];
  const actualKeys = Object.keys(firstRow);

  // Build a case-insensitive lookup so FIELD_MAP still works
  const keyMap = {};
  for (const k of actualKeys) {
    keyMap[k.toUpperCase()] = k;
  }

  function rowToCSVActual(apiRow) {
    return CSV_HEADERS.map(header => {
      const apiKey = Object.keys(FIELD_MAP).find(k => FIELD_MAP[k] === header);
      if (!apiKey) return '';
      const actualKey = keyMap[apiKey] || apiKey;
      return csvCell(apiRow[actualKey]);
    }).join(',');
  }

  const csvLines = [CSV_HEADERS.join(',')];
  for (const row of allRows) {
    csvLines.push(rowToCSVActual(row));
  }
  const csvContent = csvLines.join('\n');

  // ── 6. Trigger download ────────────────────────────────────────────────────

  const termLabel = term.replace(/\s+/g, '_');
  const filename = `Course_Schedule_${termLabel}.csv`;

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const msg = `Download ready: ${filename}\n${allRows.length} sections across ${subjects.length - failed.length} subjects.` +
    (failed.length > 0 ? `\n\nFailed (${failed.length}): ${failed.join(', ')}` : '');
  alert(msg);
})();
