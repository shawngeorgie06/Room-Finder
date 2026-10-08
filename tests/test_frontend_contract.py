"""Guards the contract between app.js and index.html.

Every element app.js looks up with $('some-id') must exist in the template.
Render functions are all null-guarded, so an orphaned reference is silent at
runtime — it just renders nothing. This test makes it loud instead.
"""
import os
import re
import json
import subprocess
from pathlib import Path


def run_reliability(script):
    """Execute the shipping query/transport helpers, not a copy of their logic."""
    module = Path(ROOT) / 'static' / 'reliability.js'
    result = subprocess.run(
        ['node', '-e', f'const R = require({json.dumps(str(module))});\n'
         + '(async () => {\n' + script + '\n})().catch(e => {console.error(e); process.exit(1)});'],
        capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_canonical_query_roundtrips_legacy_days_and_explicit_end():
    result = run_reliability("""
        const q = R.readQuery(new URLSearchParams('day=0&at=13:00&for=120&until=14:00&building=CKB'));
        console.log(JSON.stringify([q, R.queryParams(q, true).toString(),
            R.validateQuery(q, '13:00'), R.validateQuery({...q, until:'13:00'}, '13:00'),
            R.validateQuery({...q, until:'12:00'}, '13:00')]));
    """)
    assert result[0] == dict(day='Monday', at='13:00', **{'for': 120}, until='14:00', building='CKB')
    assert 'until=14%3A00' in result[1] and 'for=120' in result[1]
    assert result[2] == ''
    assert 'after' in result[3] and 'after' in result[4]


def test_query_validation_and_eastern_context_do_not_use_browser_timezone():
    result = run_reliability("""
        const invalid = ['24:00', 'banana'].map(at => R.validateQuery({day:'Monday', at, for:0, until:'', building:''}, '13:00'));
        const time = R.campusTime(new Date('2026-10-06T01:15:00Z'));
        console.log(JSON.stringify({invalid, time, label: R.contextLabel({day:'Monday', at:'13:00', for:0, until:'15:00', building:''})}));
    """)
    assert all(result['invalid'])
    assert result['time'] == {'day': 'Monday', 'at': '21:15'}
    assert result['label'] == 'Preview · Monday · 1:00 PM ET – 3:00 PM ET'


def test_replayed_context_is_never_labelled_now():
    """An offline replay answers for its retrieval time, not the present."""
    result = run_reliability("""
        const query = {day:'', at:'', for:0, until:'', building:''};
        const live = {day:'Monday', at:'13:00', timezone:'America/New_York', preview:false};
        console.log(JSON.stringify([
            R.contextLabel(query, live, false),
            R.contextLabel(query, live, true),
            R.contextLabel({...query, day:'Monday'}, {...live, preview:true}, true),
        ]));
    """)
    assert result[0] == 'Now · Monday · 1:00 PM ET'
    assert result[1] == 'Last known · Monday · 1:00 PM ET'
    assert result[2] == 'Preview · Monday · 1:00 PM ET'


def test_fetch_preserves_original_offline_timestamp_and_empty_success():
    result = run_reliability("""
        const packet = await R.request('/api/rooms', {fetchImpl: async () => new Response('[]', {headers: {
            'X-Room-Finder-Cache':'offline', 'X-Room-Finder-Fetched-At':'2026-10-05T16:00:00Z',
            'X-Schedule-Version':'v1', 'X-Query-Day':'Monday', 'X-Query-Time':'13:00',
            'X-Query-Timezone':'America/New_York', 'X-Query-Preview':'1'}})});
        const unknown = await R.request('/api/rooms', {fetchImpl: async () => new Response('[]', {headers: {'X-Room-Finder-Cache':'offline'}})});
        console.log(JSON.stringify({data:packet.data, stamp:packet.fetchedAt, cache:packet.cache, unknown:unknown.fetchedAt}));
    """)
    assert result == {'data': [], 'stamp': '2026-10-05T16:00:00.000Z', 'cache': 'offline', 'unknown': None}


def test_fetch_bounds_body_read_and_rejects_http_failures():
    result = run_reliability("""
        const errors = [];
        for (const fetchImpl of [async () => new Response('{}', {status:503}),
            async () => ({ok:true, headers:new Headers(), json:() => new Promise(() => {})})]) {
            try { await R.request('/api/rooms', {fetchImpl, timeoutMs:10}); }
            catch(e) { errors.push(e.kind); }
        }
        console.log(JSON.stringify(errors));
    """)
    assert result == ['error', 'timeout']


def test_auth_configuration_recovery_is_not_shown_for_public_schedule_outage():
    result = run_reliability("""
        const messages = [];
        for (const url of ['/api/rooms', '/api/export-schedule', '/api/upload-schedule']) {
            try { await R.request(url, {fetchImpl:async () => new Response('{}', {status:503})}); }
            catch(e) { messages.push(e.message); }
        }
        console.log(JSON.stringify(messages));
    """)
    assert 'password' not in result[0].lower()
    assert all('configured upload password' in message for message in result[1:])


def test_transport_preserves_bounded_literal_validation_and_attachment_name():
    result = run_reliability("""
        const messages = [];
        for (const status of [400,404,413,422]) {
            try { await R.request('/api/upload-schedule',{fetchImpl:async()=>new Response(JSON.stringify({error:'<b>Fix the file</b>'+ 'x'.repeat(800)}),{status})}); }
            catch(e) {messages.push({kind:e.kind,message:e.message});}
        }
        const file = await R.request('/api/export-schedule?term=202690',{responseType:'blob',fetchImpl:async()=>new Response('bytes',{headers:{'Content-Disposition':'attachment; filename=Course_Schedule_202690.xlsx'}})});
        console.log(JSON.stringify({messages,filename:file.filename}));
    """)
    assert all(message['kind'] == 'validation' for message in result['messages'])
    assert all(message['message'].startswith('<b>Fix the file</b>') and len(message['message']) <= 600 for message in result['messages'])
    assert result['filename'] == 'Course_Schedule_202690.xlsx'


def test_unloaded_saved_roster_is_unknown_not_proven_absent():
    result = run_app("""
        global.localStorage.getItem=()=> '["CKB|217"]';
        console.log(JSON.stringify(savedRooms().map(room=>({room,status:roomStatus(room).text}))));
    """)
    assert result[0]['status'] == 'Availability unknown'
    assert not result[0]['room'].get('missingFromSchedule')


def test_snapshot_rejects_mixed_version_or_query_and_never_renews_replay():
    result = run_reliability("""
        const p = {version:'v1', context:{day:'Monday',at:'13:00',timezone:'America/New_York',preview:true},
            fetchedAt:'2026-10-05T16:00:00.000Z', cache:'offline'};
        const errors = [];
        for (const other of [{...p,version:'v2'}, {...p,context:{...p.context,at:'13:01'}}, {...p,version:null}]) {
            try { R.snapshotMetadata([p,other]); } catch(e) {errors.push(e.kind);}
        }
        console.log(JSON.stringify({errors, meta:R.snapshotMetadata([p,{...p,fetchedAt:'2026-10-05T17:00:00.000Z',cache:'network'}])}));
    """)
    assert result['errors'] == ['inconsistent'] * 3
    assert result['meta']['fetchedAt'] == '2026-10-05T16:00:00.000Z'
    assert result['meta']['offline'] is True


def run_app(script):
    """Run the actual app orchestration in Node; renderer behavior lives in browser tests."""
    bootstrap = r"""
        const fs = require('node:fs'), vm = require('node:vm');
        global.RoomFinderReliability = R;
        global.window = {location:{search:'',pathname:'/',href:'http://test/'},history:{replaceState(){}},addEventListener(){}};
        global.document = {getElementById:() => null,addEventListener(){},activeElement:null,
            querySelectorAll:() => [],createElement:() => ({})};
        global.localStorage = {getItem:() => null,setItem(){}};
        global.setInterval = () => 0;
        vm.runInThisContext(fs.readFileSync(APP_PATH, 'utf8').replace(/init\(\);\s*$/, ''));
    """.replace('APP_PATH', json.dumps(APP_JS))
    return run_reliability(bootstrap + '\n' + script)


def test_empty_roster_is_success_not_fallback_to_stale_free_rooms():
    result = run_app("""
        state.allRoomsCache = []; state.allRoomsCacheKey = ''; state.allRoomsCacheReady = true;
        state.allRoomsData = [{building:'OLD',room:'101'}];
        console.log(JSON.stringify(searchRoomSource()));
    """)
    assert result == []


def test_all_availability_query_paths_include_explicit_end():
    result = run_app("""
        state.timeAt = '13:00'; state.timeUntil = '15:00'; state.dayAt = 'Monday'; state.timeFor = 30;
        console.log(JSON.stringify(Object.fromEntries(filterParams())));
    """)
    assert result == {'at': '13:00', 'until': '15:00', 'day': 'Monday', 'for': '30'}


def test_window_ended_is_distinct_from_retryable_http_error():
    result = run_reliability("""
        try { await R.request('/api/rooms?until=12:00', {fetchImpl:async () => new Response(JSON.stringify({error_code:'window_ended'}), {status:400})}); }
        catch(e) { console.log(JSON.stringify({kind:e.kind,message:e.message})); }
    """)
    assert result['kind'] == 'window-ended'
    assert 'ended' in result['message']


def test_impossible_duration_and_invalid_preview_are_terminal_validation_errors():
    result = run_reliability("""
        const errors = [];
        for (const error_code of ['duration_exceeds_day', 'invalid_window']) {
            try { await R.request('/api/rooms?for=120', {fetchImpl:async () => new Response(JSON.stringify({error_code}), {status:400})}); }
            catch(e) { errors.push({kind:e.kind,message:e.message}); }
        }
        console.log(JSON.stringify(errors));
    """)
    assert all(error['kind'] == 'invalid' for error in result)
    assert 'shorter duration' in result[0]['message']
    assert 'start time' in result[1]['message']


def test_detail_uses_additive_availability_without_claiming_busy_room_free():
    result = run_app("""
        state.soonThresholdMins = 60;
        console.log(JSON.stringify([
          roomStatus(detailRoomFacts({occupied_now:false,minutes_until_next:50})).kind,
          nextAvailabilityText({occupied_now:true,available_from_min:1250,available_until_min:null}),
          nextAvailabilityText({occupied_now:true,next_free_window:null})
        ]));
    """)
    assert result[0] == 'soon'
    assert '8:50 PM' in result[1]
    assert 'In use' in result[2] and 'rest of the day' not in result[2]


def test_exact_detail_identity_does_not_change_legacy_first_dash_parsing():
    result = run_app("""
        state.detailIdentity={key:'A-B-C-1',building:'A-B',room:'C-1'};
        const exact=splitDetailRoom('A-B-C-1');
        state.detailIdentity=null;
        console.log(JSON.stringify([exact,splitDetailRoom('A-B-C-1')]));
    """)
    assert result == [['A-B', 'C-1'], ['A', 'B-C-1']]


def test_latest_generation_guards_commit_even_when_abort_is_ignored():
    result = run_reliability("""
        const gate = R.createGeneration();
        const first = gate.begin('Monday');
        const second = gate.begin('Tuesday');
        const commits = [];
        gate.commit(second, () => commits.push('new'));
        gate.commit(first, () => commits.push('old'));
        console.log(JSON.stringify({commits, aborted:first.signal.aborted}));
    """)
    assert result == {'commits': ['new'], 'aborted': True}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, 'static', 'app.js')
INDEX_HTML = os.path.join(ROOT, 'templates', 'index.html')

# Ids app.js creates at runtime rather than reading from the template.
DYNAMIC_IDS = {'search-opt'}


def referenced_element_ids():
    """Ids app.js passes to $() or setText() as plain string literals."""
    js = open(APP_JS, encoding='utf-8').read()
    # Capture ids from $('id') calls
    dollar_ids = set(re.findall(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""", js))
    # Capture ids from setText('id', ...) calls
    settext_ids = set(re.findall(r"""setText\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,""", js))
    ids = dollar_ids | settext_ids
    return {i for i in ids if not any(i.startswith(d) for d in DYNAMIC_IDS)}


def declared_element_ids():
    """Ids declared in the template."""
    html = open(INDEX_HTML, encoding='utf-8').read()
    return set(re.findall(r"""\bid=["']([A-Za-z0-9_-]+)["']""", html))


def test_every_referenced_element_exists_in_template():
    missing = sorted(referenced_element_ids() - declared_element_ids())
    assert not missing, (
        "app.js reads elements that the template does not define: "
        + ", ".join(missing)
        + ". Either restore the element or delete the dead render code."
    )


def test_contract_test_sees_a_realistic_number_of_ids():
    """Guards the regexes themselves — if a refactor changes how elements are
    looked up, this test fails rather than the contract silently passing on an
    empty set."""
    assert len(referenced_element_ids()) > 40
    assert len(declared_element_ids()) > 80


def test_component_helpers_exist_and_use_tokens():
    """The helpers must read colours from CSS custom properties, not hex.

    Hardcoded hex in JS-generated markup is why the palette drifted to 126
    hand-typed values in the first place.
    """
    js = open(APP_JS, encoding='utf-8').read()
    for fn in ('function roomStatus', 'function statusPill', 'function groupLabel'):
        assert fn in js, f"missing helper: {fn}"

    start = js.index('// ── Component helpers')
    end = js.index('// ── End component helpers')
    helpers = js[start:end]
    assert 'var(--free)' in helpers
    assert 'var(--soon)' in helpers
    assert 'var(--busy)' in helpers
    assert not re.search(r'#[0-9a-fA-F]{6}', helpers), \
        "component helpers must use var(--token), not hardcoded hex"


def _restore_state_body():
    js = open(APP_JS, encoding='utf-8').read()
    start = js.index('function restoreStateFromURL')
    return js[start:start + 2500]


def test_all_shareable_view_values_are_still_handled():
    """Shared links are an advertised feature; these four must keep working."""
    body = _restore_state_body()
    for view in ('dashboard', 'rooms', 'map', 'settings'):
        assert f"'{view}'" in body, f"view={view} no longer handled"
    assert "'buildings'" in body, "view=buildings alias missing"


def test_view_alias_variable_is_reassignable():
    """The 'buildings' alias reassigns `view`, so `view` must not be a const.

    This test exists because its predecessor did not catch a real crash. That
    test only asserted the string 'buildings' appeared in the function body —
    and it DID appear, on the very line that threw. `const view = ...` followed
    by `view = 'dashboard'` raises TypeError, which aborts init() and leaves the
    whole app dead on /?view=buildings, while the server still returns HTTP 200.
    A guard rail that passes on broken code is not a guard rail.
    """
    body = _restore_state_body()

    reassigns = re.search(r"^\s*if \(view === 'buildings'\) view = ", body, re.M)
    assert reassigns, "the buildings->dashboard alias reassignment is missing"

    decl = re.search(r"^\s*(const|let|var)\s+view\s*=", body, re.M)
    assert decl, "could not find the declaration of `view` in restoreStateFromURL"
    assert decl.group(1) != 'const', (
        "`view` is declared with const but is reassigned by the 'buildings' "
        "alias — this throws TypeError and kills init(). Use `let`."
    )


def test_saved_rooms_filter_has_markup_state_and_shareable_url_support():
    """Saved is a Rooms scope, so it must survive refreshes and shared links."""
    js = open(APP_JS, encoding='utf-8').read()
    html = open(INDEX_HTML, encoding='utf-8').read()
    assert 'savedOnly: false' in js
    assert "params.set('saved', '1')" in js
    assert "params.get('saved')" in js
    assert 'function setSavedOnly(enabled)' in js  # async- prefix allowed
    # Saved mode must read the every-room cache, not the free-rooms feed:
    # /api/rooms omits occupied rooms, so a saved room would disappear the
    # moment a class started in it.
    # Execute collection semantics, including occupied and vanished pins. A
    # source-slice assertion cannot prove hidden filters leave pins intact.
    pins = run_app("""
        state.building = 'FMH'; state.timeFor = 120;
        state.allRoomsCacheReady = true;
        state.allRoomsCache = [{building:'CKB',room:'G-08',empty:false,matches_requested_window:false}];
        global.localStorage.getItem = () => '["CKB|G-08","OLD|100A"]';
        console.log(JSON.stringify(savedRooms()));
    """)
    assert pins == [dict(building='CKB', room='G-08', empty=False, matches_requested_window=False),
                    dict(building='OLD', room='100A', missingFromSchedule=True)]
    assert 'id="rooms-all-btn"' in html
    assert 'id="saved-rooms-btn"' in html
    assert 'No saved rooms yet' in js
    assert 'Tap ★ on any room to save it.' in js
