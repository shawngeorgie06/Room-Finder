/* Query and transport boundary shared by the browser and executable Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomFinderReliability = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const TIMEZONE = 'America/New_York';
  const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  function campusTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = type => parts.find(p => p.type === type).value;
    return { day: get('weekday'), at: `${get('hour')}:${get('minute')}` };
  }
  function readQuery(params) {
    const rawDay = params.get('day') || '';
    const day = /^[0-6]$/.test(rawDay) ? DAYS[Number(rawDay)] :
      (DAYS.find(d => d.toLowerCase() === rawDay.toLowerCase()) || rawDay);
    return Object.freeze({
      day, at: params.get('at') || '', for: Number(params.get('for') || 0),
      until: params.get('until') || '', building: params.get('building') || '',
    });
  }
  function queryParams(query, includeBuilding = false) {
    const params = new URLSearchParams();
    for (const key of ['day', 'at', 'for', 'until']) if (query[key]) params.set(key, String(query[key]));
    if (includeBuilding && query.building) params.set('building', query.building);
    return params;
  }
  function validateQuery(query, nowAt = campusTime().at) {
    if (query.day && !DAYS.includes(query.day)) return 'Choose a weekday from Monday to Sunday.';
    if ((query.at && !validTime(query.at)) || (query.until && !validTime(query.until))) return 'Enter a valid time (00:00–23:59 Eastern).';
    // Explicit end wins: an old duration preference must not override a valid gap.
    if (query.until) {
      if (minutes(query.until) <= minutes(query.at || nowAt)) return 'End time must be after the start time on the same day. Overnight windows are not supported.';
    } else if (!Number.isInteger(query.for) || query.for < 0 || query.for > 1440) {
      return 'Choose a duration between 0 and 1440 minutes.';
    }
    return '';
  }
  function contextLabel(query, context = null, offline = false) {
    const effective = context || campusTime();
    const day = context?.day || query.day || effective.day;
    const at = context?.at || query.at || effective.at;
    const preview = context ? context.preview : Boolean(query.day || query.at);
    const format = value => validTime(value) ? `${Number(value.slice(0, 2)) % 12 || 12}:${value.slice(3)} ${Number(value.slice(0, 2)) >= 12 ? 'PM' : 'AM'}` : 'time unknown';
    // A replayed answer describes the moment it was retrieved. Only a live
    // response may be labelled "Now"; a preview is hypothetical either way.
    return `${preview ? 'Preview' : offline ? 'Last known' : 'Now'} · ${day} · ${format(at)} ET` +
      (query.until ? ` – ${format(query.until)} ET` : query.for ? ` · ${query.for}+ min` : '');
  }
  function failure(kind, message, status) {
    return Object.assign(new Error(message), { kind, status });
  }
  async function request(url, options = {}) {
    const { fetchImpl = globalThis.fetch, timeoutMs = 12000, signal, responseType = 'json', ...init } = options;
    const controller = new AbortController();
    let timer, onAbort;
    const stop = new Promise((_, reject) => {
      onAbort = () => { controller.abort(); reject(failure('cancelled', 'Request superseded.')); };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(failure('timeout', 'The server took too long to respond.')); }, timeoutMs);
    });
    try {
      return await Promise.race([stop, (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (!response.ok) {
          let problem = {};
          try { problem = await response.json(); } catch (_) { /* bounded by the same timeout */ }
          if (problem.error_code === 'window_ended') throw failure('window-ended', 'This requested window has ended. Choose a later end time or clear the window.', response.status);
          if (problem.error_code === 'duration_exceeds_day') throw failure('invalid', 'This duration extends past midnight. Choose a shorter duration or an earlier start time in the filters.', response.status);
          if (problem.error_code === 'invalid_window') throw failure('invalid', 'This window is not valid. Edit the start time, end time, or duration in the filters; the window must end on the same day.', response.status);
          if ([400,404,413,422].includes(response.status)) {
            const diagnostic = typeof problem.error === 'string' && problem.error.trim()
              ? problem.error.slice(0,600) : `Request could not be accepted (${response.status}). Check the file or selected semester.`;
            throw failure('validation', diagnostic, response.status);
          }
          const message = response.status === 401 ? 'Password not accepted. Enter the upload password and retry.' :
            response.status === 503 ? (/^\/api\/(?:upload|export)-schedule(?:\?|$)/.test(url)
              ? 'This service is unavailable. Upload/export requires a configured upload password; contact the administrator, then retry.'
              : 'The schedule service is temporarily unavailable. Please retry shortly.') :
            response.status === 429 ? 'Too many requests. Wait a moment, then retry.' :
            `Request failed (${response.status}). Please retry.`;
          throw failure(response.status === 401 ? 'permission-denied' : 'error', message, response.status);
        }
        const data = responseType === 'blob' ? await response.blob() : await response.json();
        const get = name => response.headers.get(name);
        const cache = get('X-Room-Finder-Cache') === 'offline' ? 'offline' : 'network';
        const rawStamp = get('X-Room-Finder-Fetched-At');
        const parsed = rawStamp ? Date.parse(rawStamp) : NaN;
        const fetchedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() :
          cache === 'offline' ? null : new Date().toISOString();
        const day = get('X-Query-Day'), at = get('X-Query-Time');
        const timezone = get('X-Query-Timezone'), preview = get('X-Query-Preview');
        const disposition = get('Content-Disposition') || '';
        const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
        let filename = /filename="([^"]+)"/i.exec(disposition)?.[1] || /filename=([^;]+)/i.exec(disposition)?.[1] || '';
        if (encodedName) { try { filename = decodeURIComponent(encodedName); } catch (_) { /* use plain filename */ } }
        filename = filename.replace(/\\/g,'/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,255);
        return { data, filename, fetchedAt, cache, version: get('X-Schedule-Version'),
          context: day && at && timezone && preview !== null ? { day, at, timezone, preview: preview === '1' } : null };
      })()]);
    } catch (error) {
      if (error.kind) throw error;
      throw failure(globalThis.navigator?.onLine === false ? 'offline' : 'error', 'Could not reach the server. Check your connection and retry.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  function snapshotMetadata(packets) {
    const first = packets[0];
    const versions = new Set(packets.map(p => p.version || null));
    const contexts = new Set(packets.map(p => JSON.stringify(p.context || null)));
    if (versions.size > 1 || contexts.size > 1) throw failure('inconsistent', 'Schedule changed during refresh. A consistent snapshot could not be verified.');
    if (first.context && first.context.timezone !== TIMEZONE) throw failure('inconsistent', 'Unexpected schedule timezone. A consistent snapshot could not be verified.');
    // Unknown is deliberately not replaced with the time of an offline replay.
    const fetchedAt = packets.every(p => p.fetchedAt) ? packets.map(p => p.fetchedAt).sort()[0] : null;
    return { version: first.version, context: first.context, fetchedAt,
      offline: packets.some(p => p.cache === 'offline'), verified: Boolean(first.version && first.context) };
  }
  function createGeneration() {
    let active = null, number = 0;
    return {
      begin(key) {
        active?.controller.abort();
        const controller = new AbortController();
        active = { number: ++number, key, controller, signal: controller.signal };
        return active;
      },
      current(ticket) { return active === ticket && !ticket.signal.aborted; },
      commit(ticket, write) { if (active !== ticket || ticket.signal.aborted) return false; write(); return true; },
    };
  }
  return { readQuery, queryParams, validateQuery, campusTime, contextLabel, request, snapshotMetadata, createGeneration };
});
