/* Submissions viewer – main application. All student content is treated as
 * untrusted text: it is only ever inserted with textContent or after escaping. */
(function () {
  'use strict';

  // ================================================================ state
  var S = {
    ws: null, workspaces: [], index: null, students: [], byId: {}, solution: null, solutionError: null, ref: null,
    controllers: [], shell: null, gen: 0, urls: {},
    ui: Object.assign({ view: 'conceptual', cmpSolution: false, wrap: false, collapse: true, lastTab: 'review', sort: { key: 'name', asc: true }, issPanel: true },
      safeJson(localStorage.getItem('subviewer.ui')) || {})
  };
  function saveUi() { try { localStorage.setItem('subviewer.ui', JSON.stringify(S.ui)); } catch (e) { /* ignore */ } }
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  var VIEW_LABEL = { conceptual: 'MCD', logical: 'MLD', physical: 'EMLD' };
  var VIEW_TITLE = { conceptual: 'MCD · conceptual', logical: 'MLD · logical', physical: 'EMLD · extended logical / physical' };
  var TABS = [
    { key: 'review', label: 'Review' },
    { key: 'diagram', label: 'Diagram' },
    { key: 'sql', label: 'SQL' },
    { key: 'data', label: 'Tables & data' },
    { key: 'docs', label: 'Documents' },
    { key: 'files', label: 'Files' }
  ];
  var ENT_LETTER = { users: 'U', stations: 'S', ports: 'P', locations: 'L', activations: 'A' };
  var SEV = {
    error: { label: 'mistake', cls: 'error' },
    deviation: { label: 'solution', cls: 'deviation' },
    convention: { label: 'naming', cls: 'convention' },
    minor: { label: 'minor', cls: 'minor' }
  };
  var AREA_TITLE = { solution: 'Deviations from the model solution', naming: 'Naming convention', other: 'Modelling / SQL mistakes' };

  // ============================================================== helpers
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // only used with escaped strings
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid instanceof Node ? kid : String(kid));
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function rich(str) {
    return String(str).split('`').map(function (p, i) { return i % 2 ? h('code', null, p) : p; });
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fileUrl(path) { return (S.urls && S.urls[path]) || '#'; }
  function plural(n, s, p) { return n + ' ' + (n === 1 ? s : (p || s + 's')); }
  function studentHref(id, tab, q) { return '#/s/' + encodeURIComponent(id) + '/' + (tab || 'review') + (q ? '?' + q : ''); }

  function fetchText(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      return r.arrayBuffer();
    }).then(function (ab) {
      var b = new Uint8Array(ab);
      if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
      if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
      try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return new TextDecoder('windows-1252').decode(b); }
    });
  }

  function destroyControllers() {
    S.controllers.forEach(function (c) { try { c.destroy(); } catch (e) { /* ignore */ } });
    S.controllers = [];
  }

  // ========================================================= data loading
  function loadStudent(st) {
    if (st._loading) return st._loading;
    st._loading = (function () {
      var d = { sql: [], models: [], pdfs: [], images: [], others: [] };
      var jobs = st.files.map(function (f) {
        if (f.kind === 'sql') {
          return fetchText(fileUrl(f.path)).then(function (text) {
            text = text.replace(/\r\n?/g, '\n');
            var entry = { file: f, text: text };
            try { entry.parsed = SqlParse.parse(text); entry.analysis = SqlParse.analyze(entry.parsed); }
            catch (e) { entry.error = 'Parser failed: ' + e.message; }
            d.sql.push(entry);
          }).catch(function (e) { d.sql.push({ file: f, text: '', error: 'Could not load: ' + e.message }); });
        }
        if (f.kind === 'model') {
          return fetchText(fileUrl(f.path)).then(function (t) {
            d.models.push({ file: f, model: Diagram.load(JSON.parse(t)) });
          }).catch(function (e) { d.models.push({ file: f, error: 'Not valid JSON: ' + e.message }); });
        }
        if (f.kind === 'pdf') d.pdfs.push(f);
        else if (f.kind === 'image') d.images.push(f);
        else d.others.push(f);
        return null;
      });
      return Promise.all(jobs).then(function () {
        var byName = function (a, b) { return a.file.name.localeCompare(b.file.name); };
        d.sql.sort(byName); d.models.sort(byName);
        d.sqlMain = d.sql.filter(function (x) { return x.parsed; })[0] || null;
        d.modelMain = d.models.filter(function (x) { return x.model && x.model.kind === 'modelizer'; })[0] || null;
        d.issues = collectIssues(d);
        d.summary = summarize(d);
        st.data = d;
        return d;
      });
    })();
    return st._loading;
  }

  function collectIssues(d) {
    var list = [];
    if (!d.sql.length) list.push({ sev: 'error', area: 'other', where: 'SQL', text: 'No .sql file submitted.' });
    d.sql.forEach(function (x) { if (x.error) list.push({ sev: 'error', area: 'other', where: 'SQL', text: x.file.name + ': ' + x.error }); });
    if (!d.models.length) list.push({ sev: 'error', area: 'other', where: 'MCD', text: 'No Modelizer (.json/.mdlz) file submitted.' });
    d.models.forEach(function (m) {
      if (m.error) list.push({ sev: 'error', area: 'other', where: 'MCD', text: m.file.name + ': ' + m.error });
      else if (m.model.kind !== 'modelizer') list.push({ sev: 'minor', area: 'other', where: 'MCD', text: m.file.name + ' is not a Modelizer file (' + (m.model.kind === 'drawio' ? 'draw.io export' : 'unknown format') + '); the diagrams can only be checked in the PDF.' });
    });
    if (!d.pdfs.length && !d.images.length) list.push({ sev: 'error', area: 'other', where: 'MCD', text: 'No PDF or image with MCD, MLD and EMLD.' });
    try {
      var res = Checks.analyze({ model: d.modelMain && d.modelMain.model, parsed: d.sqlMain && d.sqlMain.parsed, sqlText: d.sqlMain ? d.sqlMain.text : '', reference: S.ref });
      list = list.concat(res.issues);
      d.ruleDefs = res.rules; d.ruleChecked = res.checked;
    } catch (e) { list.push({ sev: 'error', area: 'other', where: 'SQL', text: 'Checks failed: ' + e.message }); }
    if (d.sqlMain) {
      var SQLMAP = { error: 'error', warn: 'error', info: 'minor' };
      d.sqlMain.analysis.hints.forEach(function (x) {
        if (x.level === 'naming') return; // covered by the convention checks
        var line = x.table ? lineOfTable(d.sqlMain.parsed, x.table) : null;
        list.push({ sev: SQLMAP[x.level] || 'minor', area: 'other', where: 'SQL', table: x.table, line: line, text: (x.table ? q(x.table) + ': ' : '') + x.text, orphanRows: x.orphanRows, column: x.column });
      });
    }
    if (d.modelMain && d.sqlMain) {
      var df = computeDiff(d.modelMain.model, d.sqlMain.parsed);
      d.diff = df;
      df.onlyM.forEach(function (t) { list.push({ sev: 'error', area: 'other', where: 'EMLD', view: 'physical', text: 'Table ' + q(t.name) + ' is in the EMLD but not in the SQL dump.' }); });
      df.onlyS.forEach(function (t) { list.push({ sev: 'error', area: 'other', where: 'SQL', table: t.name, line: t.line, text: 'Table ' + q(t.name) + ' is in the SQL dump but not in the EMLD.' }); });
      df.cols.forEach(function (x) {
        if (x.om.length) list.push({ sev: 'error', area: 'other', where: 'SQL', table: x.table, line: lineOfTable(d.sqlMain.parsed, x.table), text: q(x.table) + ': EMLD columns missing in SQL: ' + x.om.map(q).join(', ') + '.' });
        if (x.os.length) list.push({ sev: 'error', area: 'other', where: 'SQL', table: x.table, line: lineOfTable(d.sqlMain.parsed, x.table), text: q(x.table) + ': SQL columns missing in the EMLD: ' + x.os.map(q).join(', ') + '.' });
      });
    }
    return list;
  }
  function q(s) { return '`' + s + '`'; }
  function lineOfTable(parsed, name) { var t = parsed.byName[(name || '').toLowerCase()]; return t ? t.line : null; }

  function summarize(d) {
    var s = { tables: 0, columns: 0, fks: 0, rows: 0, views: 0, modelClasses: null, entities: null, extra: [], count: { error: 0, deviation: 0, convention: 0, minor: 0 } };
    var a = d.sqlMain && d.sqlMain.analysis;
    if (a) { Object.assign(s, { tables: a.stats.tables, columns: a.stats.columns, fks: a.stats.fks, rows: a.stats.rows, views: a.stats.views }); s.entities = a.entities; }
    var mm = d.modelMain && d.modelMain.model;
    if (mm) {
      s.modelClasses = mm.classes.filter(function (c) { return Diagram.vis(c, 'conceptual'); }).length;
      if (!s.entities) s.entities = SqlParse.detectEntities(Diagram.toSchema(mm).map(function (t) { return t.name; }));
    }
    var names = d.sqlMain ? d.sqlMain.parsed.tables.map(function (t) { return t.name; }) : (mm ? Diagram.toSchema(mm).map(function (t) { return t.name; }) : []);
    if (s.entities) {
      var core = {};
      s.entities.forEach(function (e) { e.matches.forEach(function (m) { core[m] = 1; }); });
      s.extra = names.filter(function (n) { return !core[n]; });
    }
    d.issues.forEach(function (i) { s.count[i.sev] = (s.count[i.sev] || 0) + 1; });
    s.namingFindings = s.count.convention;
    s.rules = ruleStats(d);
    s.count.convention = s.rules.fail;
    return s;
  }

  /** One entry per convention rule: how often it was checked and violated. */
  function ruleStats(d) {
    var out = { list: [], ok: 0, fail: 0, minorFail: 0, na: 0 };
    (d.ruleDefs || []).forEach(function (r) {
      var checked = (d.ruleChecked || {})[r.id] || 0;
      var viol = d.issues.filter(function (i) { return i.rule === r.id; });
      var status = !checked && !viol.length ? 'na' : !viol.length ? 'ok' : r.minor ? 'minor' : 'fail';
      out.list.push({ rule: r, checked: Math.max(checked, viol.length), violations: viol, status: status });
      if (status === 'ok') out.ok++; else if (status === 'fail') out.fail++; else if (status === 'minor') out.minorFail++; else out.na++;
    });
    out.applicable = out.ok + out.fail + out.minorFail;
    return out;
  }

  function computeDiff(model, parsed) {
    var schema = Diagram.toSchema(model);
    var norm = SqlParse.normName;
    var mt = {}, sq = {};
    schema.forEach(function (t) { mt[norm(t.name)] = t; });
    parsed.tables.forEach(function (t) { sq[norm(t.name)] = t; });
    var res = { onlyM: schema.filter(function (t) { return !sq[norm(t.name)]; }), onlyS: parsed.tables.filter(function (t) { return !mt[norm(t.name)]; }), cols: [] };
    schema.filter(function (t) { return sq[norm(t.name)]; }).forEach(function (t) {
      var s = sq[norm(t.name)], mc = {}, scn = {};
      t.columns.forEach(function (c) { mc[c.name.toLowerCase()] = 1; });
      s.columns.forEach(function (c) { scn[(c.name || '').toLowerCase()] = 1; });
      var om = t.columns.filter(function (c) { return !scn[c.name.toLowerCase()]; }).map(function (c) { return c.name; });
      var os = s.columns.filter(function (c) { return !mc[(c.name || '').toLowerCase()]; }).map(function (c) { return c.name; });
      if (om.length || os.length) res.cols.push({ table: s.name, om: om, os: os });
    });
    return res;
  }

  // ================================================================ boot
  function boot() {
    window.addEventListener('hashchange', route);
    document.getElementById('search').addEventListener('input', renderSidebar);
    document.addEventListener('keydown', onKey);
    document.getElementById('side-toggle').addEventListener('click', toggleSidebar);
    document.getElementById('ws-select').addEventListener('change', function (e) { openWorkspace(e.target.value); });
    document.getElementById('ws-remove').addEventListener('click', removeWorkspace);
    var fileIn = document.getElementById('import-file');
    document.getElementById('import-btn').addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', function () { if (fileIn.files[0]) uploadZip(fileIn.files[0]); fileIn.value = ''; });
    var ft = document.getElementById('findings-toggle');
    ft.checked = showFindings();
    ft.addEventListener('change', function () { setFindings(ft.checked); });
    applyFindingsClass();
    setupDrop();
    applySidebar();
    loadSolution().then(function () { return Store.listWorkspaces(); }).then(function (ws) {
      S.workspaces = ws;
      var saved = localStorage.getItem('subviewer.ws');
      var pick = ws.filter(function (w) { return w.id === saved; })[0] || ws[0];
      renderWsSelect();
      if (pick) openWorkspace(pick.id, true); else { S.index = null; S.students = []; renderSidebar(); route(); }
    }).catch(function (e) {
      document.getElementById('main').innerHTML = '<div class="err-box">Could not start: ' + esc(e.message) + '. Please use a current Chrome, Edge or Firefox.</div>';
    });
  }

  // ------------------------------------------------------ findings on/off
  function showFindings() { return S.ui.findings !== false; }
  function applyFindingsClass() { document.body.classList.toggle('no-findings', !showFindings()); }
  function setFindings(on) {
    S.ui.findings = !!on; saveUi();
    document.getElementById('findings-toggle').checked = !!on;
    applyFindingsClass();
    S.shell = null;
    route();
  }

  // ----------------------------------------------------- reference files
  // Defaults come from reference/reference.js; a teacher can load their own
  // model solution / user story, which is kept in this browser.
  function loadSolution() {
    var R = window.REFERENCE || {};
    S.refFiles = { story: (R.story || []).slice(), convention: (R.convention || []).slice(), images: (R.images || []).slice(), solution: R.solution ? [{ name: R.solution.name }] : [] };
    S.customSolution = false; S.customStory = false;
    return Promise.all([Store.getSetting('solution').catch(function () { return null; }), Store.getSetting('story').catch(function () { return null; })]).then(function (res) {
      var sol = res[0], story = res[1];
      var data = R.solution ? R.solution.data : null;
      if (sol && sol.data) { data = sol.data; S.refFiles.solution = [{ name: sol.name }]; S.customSolution = true; S.refFiles.images = []; }
      if (story && story.blob) { S.refFiles.story = [{ name: story.name, url: URL.createObjectURL(story.blob) }]; S.customStory = true; }
      S.solution = null; S.ref = null; S.solutionError = null;
      if (!data) { S.solutionError = 'No model solution loaded.'; return; }
      try { S.solution = Diagram.load(data); S.ref = Checks.buildReference(S.solution); }
      catch (e) { S.solutionError = e.message; }
    });
  }
  function chooseFile(accept, cb) {
    var inp = h('input', { type: 'file', accept: accept });
    inp.addEventListener('change', function () { if (inp.files[0]) cb(inp.files[0]); });
    inp.click();
  }
  function replaceSolution() {
    chooseFile('.mdlz,.json', function (f) {
      f.text().then(function (t) {
        var data = JSON.parse(t);
        if (Diagram.load(data).kind !== 'modelizer') throw new Error('This is not a Modelizer file.');
        return Store.setSetting('solution', { name: f.name, data: data });
      }).then(reloadReference).catch(function (e) { alert('Could not use this file: ' + e.message); });
    });
  }
  function replaceStory() {
    chooseFile('.pdf', function (f) { Store.setSetting('story', { name: f.name, blob: new Blob([f], { type: 'application/pdf' }) }).then(reloadReference); });
  }
  function resetReference(key) { Store.setSetting(key, undefined).then(reloadReference); }
  function reloadReference() {
    return loadSolution().then(function () {
      S.students.forEach(function (st) { st._loading = null; st.data = null; });
      S.shell = null;
      if (S.ws) openWorkspace(S.ws, true); else route();
    });
  }

  // ------------------------------------------------------------ workspaces
  function renderWsSelect() {
    var sel = document.getElementById('ws-select');
    sel.innerHTML = '';
    var rm = document.getElementById('ws-remove');
    if (!S.workspaces.length) { sel.appendChild(h('option', { value: '' }, 'No submissions yet')); sel.disabled = true; rm.hidden = true; return; }
    sel.disabled = false;
    var cur = S.workspaces.filter(function (w) { return w.id === S.ws; })[0];
    rm.hidden = false;
    rm.disabled = !cur;
    rm.title = cur ? 'Remove the imported workspace "' + cur.title + '" from this browser (your zip file is not touched)' : '';
    S.workspaces.forEach(function (w) { sel.appendChild(h('option', { value: w.id, selected: w.id === S.ws }, w.title + ' (' + w.count + ')')); });
  }

  function removeWorkspace() {
    var w = S.workspaces.filter(function (x) { return x.id === S.ws; })[0];
    if (!w) return;
    if (!confirm('Remove the workspace "' + w.title + '"?\n\nThis deletes the ' + w.count + ' imported submissions from this browser. Your original zip file is not touched and you can import it again.')) return;
    Store.removeWorkspace(w.id).then(function () { return Store.listWorkspaces(); }).then(function (ws) {
      S.workspaces = ws;
      destroyControllers(); S.shell = null;
      if (ws.length) openWorkspace(ws[0].id);
      else {
        revokeUrls();
        S.ws = null; S.index = null; S.students = []; S.byId = {};
        localStorage.removeItem('subviewer.ws');
        renderWsSelect(); renderSidebar();
        if (location.hash !== '#/' && location.hash !== '') location.hash = '#/'; else route();
      }
    }).catch(function (e) { alert('Could not remove the workspace: ' + e.message); });
  }

  function revokeUrls() {
    Object.keys(S.urls || {}).forEach(function (k) { URL.revokeObjectURL(S.urls[k]); });
    S.urls = {};
  }

  function openWorkspace(id, keepRoute) {
    var gen = ++S.gen;
    S.ws = id;
    localStorage.setItem('subviewer.ws', id);
    renderWsSelect();
    S.shell = null;
    return Store.getWorkspace(id).then(function (ws) {
      if (gen !== S.gen) return;
      revokeUrls();
      Object.keys(ws.blobs).forEach(function (p) { S.urls[p] = URL.createObjectURL(ws.blobs[p]); });
      S.index = { title: ws.title, students: ws.students, single: ws.single };
      S.students = ws.students; S.byId = {};
      S.students.forEach(function (s) { s._loading = null; s.data = null; S.byId[s.id] = s; });
      document.title = ws.title + ' · DB submissions viewer';
      renderSidebar();
      var target = keepRoute === 'student' || (!keepRoute && ws.single && S.students.length === 1) ? studentHref(S.students[0].id, 'review') : '#/';
      if (typeof keepRoute === 'string' && keepRoute !== 'student') target = keepRoute;
      if (keepRoute === true || location.hash === target) route(); else location.hash = target;
      var queue = S.students.slice();
      var worker = function () {
        var st = queue.shift();
        if (!st || gen !== S.gen) return Promise.resolve();
        return loadStudent(st).catch(function () { /* shown per student */ }).then(function () { if (gen === S.gen) onStudentLoaded(st); return worker(); });
      };
      for (var i = 0; i < 4; i++) worker();
    }).catch(function (e) {
      document.getElementById('main').innerHTML = '<div class="err-box">Could not open this workspace: ' + esc(e.message) + '</div>';
    });
  }

  function onStudentLoaded(st) {
    var row = document.querySelector('tr[data-sid="' + CSS.escape(st.id) + '"]');
    if (row) row.replaceWith(overviewRow(st));
    var sumEl = document.getElementById('ov-summary');
    if (sumEl) fillOverviewStats(sumEl);
    renderSidebar();
  }

  // --------------------------------------------------------------- import
  function uploadZip(file) {
    if (!/\.zip$/i.test(file.name)) { addSingleFiles([file]); return; }
    var main = document.getElementById('main');
    destroyControllers(); S.shell = null;
    main.innerHTML = '';
    var msg = h('div', { class: 'muted' }, 'Reading ' + file.name + ' (' + fmtSize(file.size) + ')…');
    var bar = h('div', { class: 'progress indeterminate' }, h('div', { class: 'progress-bar' }));
    main.appendChild(h('div', { class: 'page' }, h('div', { class: 'card upload-card' }, h('div', { class: 'card-body' },
      h('h2', null, 'Importing submissions'), msg, bar, h('div', { class: 'faint small', style: { marginTop: '8px' } }, 'The zip is unpacked inside this browser. Nothing is uploaded.')))));
    Store.importZip(file, function (t) { msg.textContent = t; }).then(function (id) {
      return Store.listWorkspaces().then(function (ws) { S.workspaces = ws; return openWorkspace(id); });
    }).catch(function (e) {
      main.innerHTML = '';
      main.appendChild(h('div', { class: 'err-box' }, 'Import failed: ' + e.message));
    });
  }
  function setupDrop() {
    var ov = document.getElementById('drop-overlay'), depth = 0;
    var hasFile = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0; };
    window.addEventListener('dragenter', function (e) { if (!hasFile(e)) return; depth++; ov.hidden = false; e.preventDefault(); });
    window.addEventListener('dragover', function (e) { if (hasFile(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; });
    window.addEventListener('drop', function (e) {
      if (!hasFile(e)) return;
      e.preventDefault(); depth = 0; ov.hidden = true;
      var files = Array.prototype.slice.call(e.dataTransfer.files);
      if (!files.length) return;
      // one zip = class import (or a zipped single submission); loose files = single submission
      if (files.length === 1 && /\.zip$/i.test(files[0].name) && !(curWs() && curWs().single)) uploadZip(files[0]);
      else addSingleFiles(files);
    });
  }

  function curWs() { return S.workspaces.filter(function (w) { return w.id === S.ws; })[0] || null; }

  // ----------------------------------------------------- single submission
  // Files dropped or chosen while a single submission is open are added to it;
  // otherwise a new single submission is started.
  function pickSingleFiles(forceNew) {
    var inp = h('input', { type: 'file', multiple: true, accept: '.json,.mdlz,.sql,.pdf,.png,.jpg,.jpeg,.zip,.txt' });
    inp.addEventListener('change', function () { if (inp.files.length) addSingleFiles(Array.prototype.slice.call(inp.files), forceNew); });
    inp.click();
  }
  function addSingleFiles(files, forceNew) {
    var ws = curWs();
    var job;
    if (ws && ws.single && !forceNew && S.students[0]) {
      job = Store.addFiles(ws.id, S.students[0].id, files).then(function () { return { id: ws.id }; });
    } else {
      var name = prompt('Name for this submission (e.g. the student\'s name):', 'My submission');
      if (name === null) return;
      job = Store.createSingle(name, files);
    }
    job.then(function (res) {
      return Store.listWorkspaces().then(function (list) { S.workspaces = list; return openWorkspace(res.id, 'student'); });
    }).catch(function (e) { alert('Could not add the files: ' + e.message); });
  }
  function removeSingleFile(path) {
    var ws = curWs();
    if (!ws || !confirm('Remove ' + path.split('/').pop() + ' from this submission?')) return;
    Store.removeFile(ws.id, path).then(function () {
      return Store.listWorkspaces().then(function (list) { S.workspaces = list; return openWorkspace(ws.id, location.hash); });
    }).catch(function (e) { alert('Could not remove the file: ' + e.message); });
  }

  // ============================================================== sidebar
  function applySidebar() { document.body.classList.toggle('no-sidebar', S.ui.sidebarOpen === false); }
  function toggleSidebar() { S.ui.sidebarOpen = S.ui.sidebarOpen === false; saveUi(); applySidebar(); }

  function renderSidebar() {
    var ul = document.getElementById('student-list');
    var qv = document.getElementById('search').value.trim().toLowerCase();
    var cur = currentStudentId();
    ul.innerHTML = '';
    S.students.filter(function (s) { return !qv || s.name.toLowerCase().indexOf(qv) >= 0 || (s.moodleId || '').indexOf(qv) >= 0; }).forEach(function (s) {
      var c = s.data && s.data.summary.count;
      ul.appendChild(h('li', null, h('a', { href: studentHref(s.id, S.ui.lastTab), class: s.id === cur ? 'active' : null, title: s.id },
        h('span', { class: 'sname' }, s.name),
        c && showFindings() ? h('span', { class: 'mini-counts' },
          c.deviation ? h('span', { class: 'mc deviation', title: 'deviations from the solution' }, c.deviation) : null,
          c.convention ? h('span', { class: 'mc convention', title: 'naming-convention rules broken' }, c.convention) : null,
          c.error ? h('span', { class: 'mc error', title: 'mistakes' }, c.error) : null) : null)));
    });
  }
  function currentStudentId() { var p = parseHash().parts; return p[0] === 's' ? p[1] : null; }

  // =============================================================== router
  function parseHash() {
    var raw = location.hash.replace(/^#/, '') || '/';
    var qi = raw.indexOf('?');
    var path = qi >= 0 ? raw.slice(0, qi) : raw;
    return { parts: path.split('/').filter(Boolean).map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } }), q: new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '') };
  }

  function route() {
    var r = parseHash(), p = r.parts, nav = 'overview';
    if (p[0] === 's' && S.byId[p[1]]) {
      nav = '';
      var tab = TABS.some(function (t) { return t.key === p[2]; }) ? p[2] : 'review';
      S.ui.lastTab = tab; saveUi();
      renderStudent(S.byId[p[1]], tab, r.q);
    } else if (p[0] === 'compare') { nav = 'compare'; S.shell = null; renderCompare(r.q); }
    else if (p[0] === 'ref' && p[1] === 'story') { nav = 'story'; S.shell = null; renderStory(); }
    else if (p[0] === 'ref' && p[1] === 'convention') { nav = 'convention'; S.shell = null; renderPdfPage((S.refFiles || {}).convention, 'Naming convention'); }
    else if (p[0] === 'ref' && p[1] === 'solution') { nav = 'solution'; S.shell = null; renderSolution(r.q); }
    else { S.shell = null; renderOverview(); }
    Array.prototype.forEach.call(document.querySelectorAll('.topnav a'), function (a) { a.classList.toggle('active', a.getAttribute('data-nav') === nav); });
    renderSidebar();
  }

  function setMain(node, full) {
    destroyControllers();
    var main = document.getElementById('main');
    main.innerHTML = '';
    main.style.overflow = full ? 'hidden' : 'auto';
    main.appendChild(node);
  }

  // ============================================================= overview
  function importHero() {
    var fileIn = document.getElementById('import-file');
    return h('div', { class: 'hero-row' },
      h('div', { class: 'card hero', onclick: function () { fileIn.click(); } },
        h('div', { class: 'hero-icon' }, '⭱'),
        h('h2', null, 'Whole class: Moodle zip'),
        h('div', { class: 'muted' }, 'In Moodle open the assignment → “View all submissions” → “Download all submissions”. Drop that zip here or click to choose it.')),
      h('div', { class: 'card hero', onclick: function () { pickSingleFiles(true); } },
        h('div', { class: 'hero-icon' }, '＋'),
        h('h2', null, 'One submission: single files'),
        h('div', { class: 'muted' }, 'Check one student’s work: add the Modelizer file (.json / .mdlz), the .sql dump and the PDF – all at once or one by one.')),
      h('p', { class: 'faint small hero-note' }, 'Everything stays in this browser; nothing is uploaded.'));
  }

  function renderOverview() {
    var page = h('div', { class: 'page' });
    if (!S.index || !S.students.length) {
      page.appendChild(h('div', { class: 'ov-head' }, h('h1', null, 'Submissions viewer')));
      page.appendChild(importHero());
      if (S.index) page.appendChild(h('p', { class: 'muted' }, 'This workspace contains no submission folders.'));
      setMain(page);
      return;
    }
    page.appendChild(h('div', { class: 'ov-head' },
      h('div', null, h('div', { class: 'muted small' }, 'Moodle submissions'), h('h1', null, S.index.title)),
      h('div', { class: 'grow' }),
      S.ws
        ? h('button', { class: 'btn danger', onclick: removeWorkspace, title: 'Delete this imported workspace (your zip file is not touched)' }, '🗑 Remove this import') : null,
      h('button', { class: 'btn', onclick: function () { pickSingleFiles(true); } }, '＋ Check one submission'),
      h('button', { class: 'btn', onclick: function () { document.getElementById('import-file').click(); } }, '⭱ Import another zip')));
    var stats = h('div', { class: 'stat-strip', id: 'ov-summary' });
    page.appendChild(stats);
    fillOverviewStats(stats);
    var cols = [
      { key: 'name', label: 'Student' },
      { key: 'files', label: 'Files' },
      { key: 'model', label: 'MCD classes', num: true },
      { key: 'tables', label: 'Tables', num: true },
      { key: 'rows', label: 'Rows', num: true, title: 'Rows inserted by the SQL file' },
      { key: 'entities', label: 'Core entities', title: 'U = users, S = stations, P = ports, L = locations, A = activations (detected from names)' },
    ];
    if (showFindings()) cols = cols.concat([
      { key: 'deviation', label: 'vs. solution', num: true, title: 'Deviations from the model solution (additions are allowed and not counted)' },
      { key: 'convention', label: 'Naming rules', num: true, title: 'Naming-convention rules broken (each rule counts once, however often it is broken) / rules that apply' },
      { key: 'error', label: 'Mistakes', num: true, title: 'Modelling / SQL mistakes (missing keys, wrong arrows, FK errors in the data, EMLD ≠ SQL, …)' },
      { key: 'minor', label: 'Minor', num: true }
    ]);
    var thead = h('tr', null, cols.map(function (c) {
      var sorted = S.ui.sort.key === c.key;
      return h('th', { class: 'sortable' + (c.num ? ' num' : '') + (sorted ? ' sorted' + (S.ui.sort.asc ? ' asc' : '') : ''), title: c.title || null,
        onclick: function () { S.ui.sort = { key: c.key, asc: sorted ? !S.ui.sort.asc : c.key === 'name' }; saveUi(); renderOverview(); } }, c.label);
    }));
    page.appendChild(h('div', { class: 'card' }, h('table', { class: 'grid' }, h('thead', null, thead), h('tbody', null, sortedStudents().map(overviewRow)))));
    page.appendChild(h('p', { class: 'muted small', style: { marginTop: '12px' } },
      'Checked against the model solution and the CNES “Naming Conventions for Database Modeling”. Entities, attributes and tables beyond the solution are allowed and not reported.'));
    setMain(page);
  }

  function fillOverviewStats(el) {
    var n = S.students.length, loaded = S.students.filter(function (s) { return s.data; });
    var cnt = function (f) { return loaded.filter(f).length; };
    el.innerHTML = '';
    [[n, 'submissions'], [cnt(function (s) { return s.data.sql.length; }) + '/' + n, 'with SQL file'], [cnt(function (s) { return s.data.modelMain; }) + '/' + n, 'with Modelizer file'],
      [cnt(function (s) { return s.data.pdfs.length || s.data.images.length; }) + '/' + n, 'with PDF/images'], [cnt(function (s) { return s.data.summary.count.deviation === 0 && s.data.modelMain; }), 'match the solution']].slice(0, showFindings() ? 5 : 4)
      .forEach(function (x) { el.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v' }, x[0]), h('div', { class: 'l' }, x[1]))); });
    if (loaded.length < n) el.appendChild(h('div', { class: 'stat' }, h('div', { class: 'v faint' }, loaded.length + '/' + n), h('div', { class: 'l' }, 'checking…')));
  }

  function sortValue(st, key) {
    var d = st.data, s = d && d.summary;
    switch (key) {
      case 'name': return st.name.toLowerCase();
      case 'files': return st.files.length;
      case 'model': return s && s.modelClasses !== null ? s.modelClasses : -1;
      case 'tables': return s ? s.tables : -1;
      case 'rows': return s ? s.rows : -1;
      case 'entities': return s && s.entities ? s.entities.filter(function (e) { return e.matches.length; }).length : -1;
      default: return s ? s.count[key] || 0 : -1;
    }
  }
  function sortedStudents() {
    var k = S.ui.sort.key, asc = S.ui.sort.asc ? 1 : -1;
    return S.students.slice().sort(function (a, b) {
      var x = sortValue(a, k), y = sortValue(b, k);
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * asc;
    });
  }

  function countCell(n, cls, st, area) {
    if (n === undefined) return h('span', { class: 'faint' }, '…');
    if (!n) return h('span', { class: 'chip ok' }, '✓');
    return h('a', { class: 'chip ' + cls, href: studentHref(st.id, 'review') + (area ? '' : ''), onclick: function (e) { e.stopPropagation(); } }, n);
  }

  function overviewRow(st) {
    var d = st.data, s = d && d.summary;
    var kinds = {}; st.files.forEach(function (f) { kinds[f.kind] = (kinds[f.kind] || 0) + 1; });
    var ftypes = h('span', { class: 'ftype' },
      h('span', { class: kinds.sql ? 'on sql' : '', title: plural(kinds.sql || 0, 'SQL file') }, 'SQL'),
      h('span', { class: kinds.model ? 'on mdl' : '', title: plural(kinds.model || 0, 'model file') }, 'MDL'),
      h('span', { class: kinds.pdf || kinds.image ? 'on pdf' : '', title: plural((kinds.pdf || 0) + (kinds.image || 0), 'PDF/image') }, 'PDF'));
    var dash = function () { return h('span', { class: 'faint' }, d ? '–' : '…'); };
    var ents = s && s.entities ? h('span', { class: 'dots' }, s.entities.map(function (e) {
      return h('span', { class: 'dot ' + (e.matches.length ? (e.exact ? 'ok' : 'loose') : 'miss'), title: e.label + ': ' + (e.matches.join(', ') || 'not found') }, ENT_LETTER[e.key]);
    })) : dash();
    return h('tr', { class: 'clickable', 'data-sid': st.id, onclick: function () { location.hash = studentHref(st.id, 'review'); } },
      h('td', { style: { whiteSpace: 'nowrap' } }, h('a', { href: studentHref(st.id, 'review'), onclick: function (e) { e.stopPropagation(); } }, st.name), st.moodleId ? h('span', { class: 'faint small' }, '  #' + st.moodleId) : null),
      h('td', null, ftypes),
      h('td', { class: 'num' }, s && s.modelClasses !== null ? s.modelClasses : dash()),
      h('td', { class: 'num' }, s && d.sqlMain ? s.tables : dash()),
      h('td', { class: 'num' }, s && d.sqlMain ? s.rows : dash()),
      h('td', null, ents),
      (showFindings() ? ['deviation', 'convention', 'error', 'minor'] : []).map(function (k) {
        var checkable = d && (d.modelMain || d.sqlMain);
        if (s && !checkable && k !== 'error') return h('td', { class: 'num', title: 'Nothing to check automatically (no SQL or Modelizer file)' }, h('span', { class: 'faint' }, 'n/a'));
        if (s && k === 'convention' && s.rules.applicable) {
          var broken = s.rules.fail;
          return h('td', { class: 'num', title: s.rules.ok + ' rules respected, ' + broken + ' broken' + (s.rules.minorFail ? ', ' + s.rules.minorFail + ' minor' : '') + ' (' + s.namingFindings + ' findings)' },
            h('a', { class: 'chip ' + (broken ? 'convention' : 'ok'), href: studentHref(st.id, 'review'), onclick: function (e) { e.stopPropagation(); } }, (broken ? broken : '✓') + ' / ' + s.rules.applicable));
        }
        return h('td', { class: 'num' }, s ? countCell(s.count[k], k, st) : dash());
      }));
  }

  // ============================================================== student
  function renderStudent(st, tab, qp) {
    var shell = S.shell;
    if (!shell || shell.id !== st.id) { shell = buildShell(st); S.shell = shell; setMain(shell.root, true); }
    else destroyControllers();
    shell.tabLinks.forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-tab') === tab); });
    shell.body.innerHTML = '';
    shell.body.className = 's-body';
    shell.body.appendChild(h('div', { class: 'loading' }, 'Loading files…'));
    loadStudent(st).then(function (d) {
      if (S.shell !== shell) return;
      updateTabCounts(shell, d);
      shell.body.innerHTML = '';
      ({ review: tabReview, diagram: tabDiagram, sql: tabSql, data: tabData, docs: tabDocs, files: tabFiles })[tab](st, d, shell.body, qp);
    }).catch(function (e) {
      shell.body.innerHTML = '';
      shell.body.appendChild(h('div', { class: 'err-box' }, 'Could not load this submission: ' + e.message));
    });
  }

  function buildShell(st) {
    var idx = S.students.indexOf(st), prev = S.students[idx - 1], next = S.students[idx + 1];
    var tabLinks = TABS.map(function (t, i) { return h('a', { href: studentHref(st.id, t.key), 'data-tab': t.key, title: 'Shortcut: ' + (i + 1) }, t.label, h('span', { class: 'n' })); });
    var head = h('div', { class: 's-head' },
      h('div', { class: 's-title' },
        h('a', { class: 'btn icon-btn', href: prev ? studentHref(prev.id, S.ui.lastTab) : null, title: prev ? 'Previous: ' + prev.name + ' (K)' : '' }, '‹'),
        h('a', { class: 'btn icon-btn', href: next ? studentHref(next.id, S.ui.lastTab) : null, title: next ? 'Next: ' + next.name + ' (J)' : '' }, '›'),
        h('h1', null, st.name),
        st.moodleId ? h('span', { class: 'faint' }, '#' + st.moodleId) : null,
        S.students.length > 1 ? h('span', { class: 'faint small' }, (idx + 1) + ' / ' + S.students.length) : null,
        S.index && S.index.single ? h('div', { class: 's-files' },
          h('button', { class: 'btn small primary', onclick: function () { pickSingleFiles(false); }, title: 'Add more files to this submission (a file with the same name is replaced)' }, '＋ Add files'),
          h('span', { class: 'faint small' }, 'or drop files anywhere')) : null),
      h('div', { class: 'tabs' }, tabLinks));
    var body = h('div', { class: 's-body' });
    return { id: st.id, root: h('div', { class: 'student' }, h('div', { class: 'student-main' }, head, body)), body: body, tabLinks: tabLinks };
  }

  function updateTabCounts(shell, d) {
    var c = d.summary.count;
    var counts = { review: showFindings() ? (c.deviation + c.convention + c.error) || '' : '', diagram: d.models.length, sql: d.sql.length, data: d.sqlMain ? d.sqlMain.parsed.tables.length : 0, docs: d.pdfs.length + d.images.length, files: '' };
    shell.tabLinks.forEach(function (a) { a.querySelector('.n').textContent = String(counts[a.getAttribute('data-tab')]); });
  }

  // ------------------------------------------------------- issue lists
  function issueHref(st, i) {
    if (i.view) return studentHref(st.id, 'diagram', 'view=' + i.view + (i.classId ? '&c=' + encodeURIComponent(i.classId) : i.edgeId ? '&e=' + encodeURIComponent(i.edgeId) : ''));
    if (i.where === 'SQL' && i.line) return studentHref(st.id, 'sql', 'line=' + i.line);
    if (i.where === 'SQL' && i.table) return studentHref(st.id, 'data', 't=' + encodeURIComponent(i.table));
    return null;
  }
  function issueItem(st, i, onClick) {
    var href = onClick ? null : issueHref(st, i);
    var inner = [h('span', { class: 'sev-tag ' + i.sev }, SEV[i.sev].label), h('span', { class: 'where-tag' }, i.where + (i.line ? ':' + i.line : '')), h('span', { class: 'itext' }, rich(i.text))];
    if (onClick) return h('a', { class: 'issue', href: 'javascript:void 0', onclick: function () { onClick(i); } }, inner);
    return href ? h('a', { class: 'issue', href: href }, inner) : h('div', { class: 'issue' }, inner);
  }
  var SEV_ORDER = { error: 0, deviation: 1, convention: 2, minor: 3 };
  var WHERE_ORDER = { MCD: 0, MLD: 1, EMLD: 2, SQL: 3 };
  function sortIssues(list) {
    return list.slice().sort(function (a, b) { return (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || (WHERE_ORDER[a.where] - WHERE_ORDER[b.where]) || ((a.line || 0) - (b.line || 0)); });
  }

  // --------------------------------------------------------------- review
  function tabReview(st, d, body) {
    var s = d.summary;
    var wrap = h('div', { class: 'review' });
    var sqlEntry = d.sqlMain;
    var statItems = [
      [s.modelClasses === null ? '–' : s.modelClasses, 'MCD classes'], [sqlEntry ? s.tables : '–', 'tables'], [sqlEntry ? s.fks : '–', 'foreign keys'], [sqlEntry ? s.rows : '–', 'sample rows'],
      [s.count.deviation, 'vs. solution', 'deviation'], [s.rules.applicable ? s.rules.fail + ' / ' + s.rules.applicable : '–', 'naming rules broken', 'convention'], [s.count.error, 'mistakes', 'error'], [s.count.minor, 'minor', 'minor']
    ].slice(0, showFindings() ? 8 : 4);
    wrap.appendChild(h('div', { class: 'card full' }, h('div', { class: 'card-body' },
      h('div', { class: 'stats' }, statItems.map(function (x) { return h('div', { class: 'stat' + (x[2] ? ' sev-stat ' + x[2] + (x[0] ? '' : ' zero') : '') }, h('div', { class: 'v' }, x[0]), h('div', { class: 'l' }, x[1])); })))));

    // coverage
    var ents = h('div', { class: 'ent-list' });
    if (!s.entities) ents.appendChild(h('div', { class: 'muted' }, 'No SQL or Modelizer file to detect entities from – check the documents.'));
    (s.entities || []).forEach(function (e) {
      ents.appendChild(h('div', { class: 'ent' },
        h('span', { class: 'dot ' + (e.matches.length ? (e.exact ? 'ok' : 'loose') : 'miss') }, ENT_LETTER[e.key]),
        h('span', { class: 'lbl' }, e.label, ' ', h('span', { class: 'de' }, e.de)),
        e.matches.length ? h('span', null, e.matches.map(function (m) { return h('a', { class: 'chip accent', href: d.sqlMain ? studentHref(st.id, 'data', 't=' + encodeURIComponent(m)) : studentHref(st.id, 'diagram') }, m); })) : h('span', { class: 'chip err' }, 'not found')));
    });
    var extra = s.extra.length ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'muted small' }, 'Additional tables (beyond the solution – allowed):'),
      h('div', { class: 'row wrap', style: { marginTop: '4px' } }, s.extra.map(function (m) { return h('span', { class: 'chip' }, m); }))) : null;
    wrap.appendChild(h('div', { class: 'card full' }, h('div', { class: 'card-head' }, h('h2', null, 'Required entities (user story)')), h('div', { class: 'card-body' }, ents, extra)));

    if (!showFindings()) {
      wrap.appendChild(h('div', { class: 'card full' }, h('div', { class: 'card-body muted' }, 'Findings are switched off. Turn on “Findings” in the top bar to see the checks against the model solution and the naming convention.')));
      body.appendChild(wrap);
      return;
    }
    // naming convention scorecard: every rule once
    if (s.rules.applicable) wrap.appendChild(ruleCard(st, d));

    // issues by area
    ['solution', 'naming', 'other'].forEach(function (area) {
      var list = sortIssues(d.issues.filter(function (i) { return i.area === area; }));
      var card = h('div', { class: 'card full' }, h('div', { class: 'card-head' }, h('h2', null, AREA_TITLE[area]),
        h('span', { class: 'chip ' + (list.length ? (area === 'solution' ? 'deviation' : area === 'naming' ? 'convention' : 'error') : 'ok') }, list.length || '✓'),
        area === 'naming' ? h('a', { class: 'small', href: '#/ref/convention', style: { marginLeft: 'auto' } }, 'Open the convention') : null,
        area === 'solution' ? h('a', { class: 'small', href: 'javascript:void 0', onclick: function () { S.ui.cmpSolution = true; saveUi(); location.hash = studentHref(st.id, 'diagram'); }, style: { marginLeft: 'auto' } }, 'Diagram next to the solution') : null));
      var b = h('div', { class: 'card-body issue-list' });
      if (!list.length) b.appendChild(h('div', { class: 'muted' }, area === 'solution' ? 'Everything the solution requires is there.' : 'Nothing found.'));
      list.forEach(function (i) { b.appendChild(issueItem(st, i)); });
      card.appendChild(b);
      wrap.appendChild(card);
    });
    body.appendChild(wrap);
  }

  function ruleCard(st, d) {
    var R = d.summary.rules;
    var card = h('div', { class: 'card full' }, h('div', { class: 'card-head' },
      h('h2', null, 'Naming convention – rule by rule'),
      h('span', { class: 'chip ok' }, R.ok + ' respected'),
      R.fail ? h('span', { class: 'chip convention' }, R.fail + ' broken') : null,
      R.minorFail ? h('span', { class: 'chip minor' }, R.minorFail + ' minor') : null,
      h('a', { class: 'small', href: '#/ref/convention', style: { marginLeft: 'auto' } }, 'Open the convention')));
    var tbl = h('table', { class: 'grid rules' }, h('thead', null, h('tr', null,
      h('th', null, ''), h('th', null, 'Rule'), h('th', null, 'Where'), h('th', { class: 'num' }, 'Correct'), h('th', null, 'Examples of violations'))));
    var tb = h('tbody');
    var order = { fail: 0, minor: 1, ok: 2, na: 3 };
    R.list.slice().sort(function (a, b) { return order[a.status] - order[b.status]; }).forEach(function (x) {
      var okCount = Math.max(0, x.checked - x.violations.length);
      var pct = x.checked ? Math.round(100 * okCount / x.checked) : 0;
      var icon = { ok: '✓', fail: '✗', minor: '~', na: '–' }[x.status];
      var ex = x.violations.slice(0, 3).map(function (i) { var href = issueHref(st, i); return h(href ? 'a' : 'span', { class: 'rule-ex', href: href }, rich(i.text)); });
      var more = x.violations.length > 3 ? h('details', null, h('summary', null, '+' + (x.violations.length - 3) + ' more'),
        x.violations.slice(3).map(function (i) { var href = issueHref(st, i); return h(href ? 'a' : 'span', { class: 'rule-ex', href: href }, rich(i.text)); })) : null;
      tb.appendChild(h('tr', { class: 'rule-' + x.status },
        h('td', { class: 'rule-icon' }, icon),
        h('td', null, x.rule.title),
        h('td', null, h('span', { class: 'where-tag' }, x.rule.where)),
        h('td', { class: 'num', style: { whiteSpace: 'nowrap' } }, x.status === 'na' ? h('span', { class: 'faint', title: 'Nothing in this submission that this rule applies to' }, 'n/a') :
          [h('span', { class: 'rule-bar' }, h('span', { style: { width: pct + '%' } })), ' ', okCount + ' / ' + x.checked]),
        h('td', { class: 'rule-exs' }, ex, more)));
    });
    tbl.appendChild(tb);
    card.appendChild(h('div', { class: 'card-body', style: { padding: '0' } }, tbl));
    return card;
  }

  // -------------------------------------------------------------- diagram
  function viewSeg(onChange, counts) {
    var seg = h('div', { class: 'seg' });
    Diagram.VIEWS.forEach(function (v) {
      seg.appendChild(h('button', { class: S.ui.view === v ? 'on' : '', title: VIEW_TITLE[v], 'data-v': v, onclick: function () {
        S.ui.view = v; saveUi();
        Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
        onChange(v);
      } }, VIEW_LABEL[v], counts && counts[v] ? h('span', { class: 'seg-count' }, counts[v]) : null));
    });
    return seg;
  }

  function diagramPane(model, label, issues) {
    var pane = h('div', { class: 'dg-pane' });
    var canvas = h('div', { class: 'dg-canvas' });
    pane.appendChild(canvas);
    if (label) pane.appendChild(h('div', { class: 'dg-pane-label' }, label));
    if (!model || model.kind !== 'modelizer') {
      canvas.appendChild(model && model.kind === 'drawio' ? drawioOutline(model) : h('div', { class: 'empty' }, h('h3', null, 'No diagram'), 'This file is not a Modelizer model.'));
      return { pane: pane, ctl: null };
    }
    var ctl = Diagram.render(canvas, model, { view: S.ui.view, issues: issues || [] });
    S.controllers.push(ctl);
    pane.appendChild(h('div', { class: 'zoom-ctl' },
      h('button', { class: 'btn', title: 'Zoom in', onclick: function () { ctl.zoom(1.25); } }, '+'),
      h('button', { class: 'btn', title: 'Zoom out', onclick: function () { ctl.zoom(0.8); } }, '−'),
      h('button', { class: 'btn', title: 'Fit to screen', onclick: function () { ctl.fit(); } }, '⤢')));
    return { pane: pane, ctl: ctl };
  }

  function drawioOutline(m) {
    var box = h('div', { class: 'drawio-outline' });
    box.appendChild(h('div', { class: 'hint info' }, 'This is a draw.io / diagrams.net export without layout information, so it cannot be checked automatically. Entities and attributes are listed below; see the PDF for the drawing.'));
    m.pages.forEach(function (p) {
      box.appendChild(h('h2', { style: { margin: '18px 0 10px' } }, p.name));
      p.entities.filter(function (e) { return e.children.length; }).forEach(function (e) {
        box.appendChild(h('div', { class: 'card drawio-ent' }, h('div', { class: 'card-head' }, e.label || '(unnamed)'), h('ul', null, e.children.map(function (c) { return h('li', null, c); }))));
      });
      var loose = p.entities.filter(function (e) { return !e.children.length && e.label; });
      if (loose.length) box.appendChild(h('div', { class: 'row wrap', style: { margin: '4px 0 8px' } }, h('span', { class: 'muted small' }, 'Other shapes / labels:'), loose.map(function (e) { return h('span', { class: 'chip' }, e.label); })));
    });
    return box;
  }

  function tabDiagram(st, d, body, qp) {
    body.className = 's-body fill';
    if (!d.models.length) { body.appendChild(emptyState('No model file', 'This submission has no Modelizer .json/.mdlz file.', d.pdfs.length ? h('a', { class: 'btn', href: studentHref(st.id, 'docs') }, 'Open the PDF instead') : null)); return; }
    if (qp.get('view') && Diagram.VIEWS.indexOf(qp.get('view')) >= 0) { S.ui.view = qp.get('view'); saveUi(); }
    var fi = Math.min(+(qp.get('f') || 0), d.models.length - 1);
    var entry = d.models[fi];
    var isModelizer = entry.model && entry.model.kind === 'modelizer';
    var issues = entry === d.modelMain && showFindings() ? d.issues.filter(function (i) { return i.view; }) : [];
    var counts = {}; issues.forEach(function (i) { counts[i.view] = (counts[i.view] || 0) + 1; });
    var ctl = null, solCtl = null;
    var panel = h('aside', { class: 'iss-panel' + (S.ui.issPanel ? '' : ' collapsed') });
    function fillPanel() {
      panel.innerHTML = '';
      var list = sortIssues(issues.filter(function (i) { return i.view === S.ui.view; }));
      panel.appendChild(h('div', { class: 'iss-panel-head' }, h('strong', null, 'Findings in the ' + VIEW_LABEL[S.ui.view]), h('span', { class: 'chip ' + (list.length ? 'err' : 'ok') }, list.length || '✓')));
      var b = h('div', { class: 'iss-panel-body issue-list' });
      if (!list.length) b.appendChild(h('div', { class: 'muted small' }, 'Nothing found in this view.'));
      list.forEach(function (i) { b.appendChild(issueItem(st, i, function (x) { if (ctl) ctl.focus(x); })); });
      panel.appendChild(b);
    }
    var bar = h('div', { class: 'toolbar' },
      isModelizer ? viewSeg(function (v) { if (ctl) ctl.setView(v); if (solCtl) solCtl.setView(v); fillPanel(); }, counts) : null,
      d.models.length > 1 ? fileSelect(d.models, fi, function (i) { location.hash = studentHref(st.id, 'diagram', 'f=' + i); }) : h('span', { class: 'muted small' }, entry.file.name),
      h('div', { class: 'grow' }),
      showFindings() ? h('span', { class: 'legend' }, ['error', 'deviation', 'convention', 'minor'].map(function (k) { return h('span', { class: 'lg ' + k }, SEV[k].label); })) : null,
      S.solution && isModelizer ? h('label', { class: 'check' }, (function () {
        var cb = h('input', { type: 'checkbox' }); cb.checked = S.ui.cmpSolution;
        cb.addEventListener('change', function () { S.ui.cmpSolution = cb.checked; saveUi(); renderStudent(st, 'diagram', new URLSearchParams(fi ? 'f=' + fi : '')); });
        return cb;
      })(), 'Model solution side by side') : null,
      isModelizer && showFindings() ? h('button', { class: 'btn small', onclick: function () { S.ui.issPanel = !S.ui.issPanel; saveUi(); panel.classList.toggle('collapsed', !S.ui.issPanel); } }, 'Findings') : null,
      h('a', { class: 'btn small', href: fileUrl(entry.file.path), target: '_blank', title: 'Raw file – can be imported in modelizer.lu' }, 'Raw JSON'));
    var host = h('div', { class: 'dg-host' });
    body.appendChild(bar);
    body.appendChild(host);
    if (entry.error) { host.appendChild(h('div', { class: 'err-box' }, entry.error)); return; }
    var a = diagramPane(entry.model, S.ui.cmpSolution && isModelizer ? st.name : null, issues);
    host.appendChild(a.pane); ctl = a.ctl;
    if (S.ui.cmpSolution && S.solution && isModelizer) { var b2 = diagramPane(S.solution, 'Model solution'); host.appendChild(b2.pane); solCtl = b2.ctl; }
    if (isModelizer && showFindings()) { host.appendChild(panel); fillPanel(); }
    var focusRef = qp.get('c') ? { classId: qp.get('c') } : qp.get('e') ? { edgeId: qp.get('e') } : null;
    if (focusRef && ctl) setTimeout(function () { ctl.focus(focusRef); }, 120);
  }

  function fileSelect(list, idx, onChange) {
    var sel = h('select', null, list.map(function (x, i) { return h('option', { value: i, selected: i === idx }, x.file.name); }));
    sel.addEventListener('change', function () { onChange(+sel.value); });
    return sel;
  }
  function emptyState(title, text, extra) {
    return h('div', { class: 'empty' }, h('h3', null, title), h('div', null, text), extra ? h('div', { style: { marginTop: '14px' } }, extra) : null);
  }

  // ------------------------------------------------------------------ sql
  var KW = new Set(('ADD ALL ALTER AND AS ASC AUTO_INCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CHANGE CHARACTER CHARSET CHECK COLLATE COLUMN COMMENT COMMIT ' +
    'CONSTRAINT CREATE CURRENT_TIMESTAMP DATABASE DEFAULT DEFINER DELETE DELIMITER DESC DISABLE DISTINCT DROP EACH ELSE ENABLE END ENGINE EXISTS FOR FOREIGN FROM ' +
    'FULLTEXT FUNCTION GENERATED GROUP HAVING IF IGNORE IN INDEX INNER INSERT INTO IS JOIN KEY KEYS LEFT LIKE LIMIT LOCK MODIFY NAMES NO NOT NULL ON OR ORDER OUTER ' +
    'PRIMARY PROCEDURE REFERENCES RENAME REPLACE RESTRICT RETURNS RIGHT ROW SCHEMA SECURITY SELECT SET SQL START TABLE TABLES TEMPORARY THEN TO TRANSACTION TRIGGER ' +
    'TRUNCATE UNION UNIQUE UNLOCK UNSIGNED UPDATE USE USING VALUES VIEW WHEN WHERE WITH WRITE ZEROFILL ALGORITHM ACTION ALWAYS STORED VIRTUAL TRUE FALSE AFTER ' +
    'DECLARE RETURN CALL DO EVENT SCHEDULE EVERY INTERVAL TIME_ZONE GRANT REVOKE PRIVILEGES IDENTIFIED USER CROSS NATURAL OFFSET DUPLICATE COUNT').split(' '));
  var TY = new Set(('INT INTEGER TINYINT SMALLINT MEDIUMINT BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOL BOOLEAN DATE DATETIME TIMESTAMP TIME YEAR CHAR ' +
    'VARCHAR BINARY VARBINARY TINYTEXT TEXT MEDIUMTEXT LONGTEXT TINYBLOB BLOB MEDIUMBLOB LONGBLOB ENUM JSON POINT GEOMETRY SERIAL InnoDB MyISAM utf8mb4 utf8 latin1').toUpperCase().split(' '));

  function highlightLines(text) {
    var toks = SqlParse.lex(text, 1);
    var lines = [[]];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], cls = '';
      switch (t.t) {
        case 'comment': cls = 'c'; break;
        case 'ccomment': cls = 'cc'; break;
        case 'str': cls = 's'; break;
        case 'qident': cls = 'i'; break;
        case 'num': cls = 'n'; break;
        case 'var': cls = 'v'; break;
        case 'punct': case 'op': cls = 'p'; break;
        case 'word':
          var u = t.v.toUpperCase();
          if (TY.has(u)) cls = 't'; else if (KW.has(u)) cls = 'k';
          else { var nx = toks[i + 1]; if (nx && nx.t === 'punct' && nx.v === '(') cls = 'f'; }
          break;
      }
      var parts = t.v.split('\n');
      for (var p = 0; p < parts.length; p++) { if (p > 0) lines.push([]); if (parts[p]) lines[lines.length - 1].push([cls, parts[p]]); }
    }
    return lines.map(function (segs) {
      var len = 0; segs.forEach(function (s) { len += s[1].length; });
      return { segs: segs, len: len, text: segs.map(function (s) { return s[1]; }).join('') };
    });
  }

  function lineHtml(line, limit, marks, curMark) {
    var out = '', pos = 0, mi = 0;
    var end = limit ? Math.min(limit, line.len) : line.len;
    for (var k = 0; k < line.segs.length && pos < end; k++) {
      var cls = line.segs[k][0], s = line.segs[k][1];
      var segEnd = Math.min(pos + s.length, end), cursor = pos, html = '';
      while (cursor < segEnd) {
        while (mi < marks.length && marks[mi][1] <= cursor) mi++;
        var m = marks[mi];
        if (m && m[0] < segEnd && m[1] > cursor) {
          var ms = Math.max(m[0], cursor), me = Math.min(m[1], segEnd);
          if (ms > cursor) html += esc(s.slice(cursor - pos, ms - pos));
          html += '<mark' + (m[2] === curMark ? ' class="cur"' : '') + '>' + esc(s.slice(ms - pos, me - pos)) + '</mark>';
          cursor = me;
        } else { html += esc(s.slice(cursor - pos, segEnd - pos)); cursor = segEnd; }
      }
      out += cls ? '<span class="tk-' + cls + '">' + html + '</span>' : html;
      pos += s.length;
    }
    return out;
  }

  function tabSql(st, d, body, qp) {
    body.className = 's-body fill';
    if (!d.sql.length) { body.appendChild(emptyState('No SQL file', 'This submission contains no .sql file.')); return; }
    var fi = Math.min(+(qp.get('f') || 0), d.sql.length - 1);
    var entry = d.sql[fi];
    if (!entry._lines) entry._lines = highlightLines(entry.text);
    var lines = entry._lines, LIMIT = 220, expanded = new Set(), matches = [], cur = -1;
    // findings per line
    var lineIss = {};
    if (entry === d.sqlMain && showFindings()) d.issues.forEach(function (i) { if (i.where === 'SQL' && i.line) (lineIss[i.line] = lineIss[i.line] || []).push(i); });
    var issLines = Object.keys(lineIss).map(Number).sort(function (a, b) { return a - b; });
    var issCur = -1;

    var code = h('div', { class: 'code' + (S.ui.wrap ? ' wrap' : '') });
    var count = h('span', { class: 'search-count' });
    var search = h('input', { type: 'search', placeholder: 'Search in file…  (Enter = next)' });

    function worst(list) { return list.reduce(function (a, i) { return SEV_ORDER[i.sev] < SEV_ORDER[a] ? i.sev : a; }, 'minor'); }
    function renderLine(i) {
      var line = lines[i];
      var lm = matches.filter(function (m) { return m.line === i; }).map(function (m) { return [m.start, m.end, m.idx]; });
      var needFull = lm.some(function (m) { return m[1] > LIMIT; });
      var cut = S.ui.collapse && line.len > LIMIT && !expanded.has(i) && !needFull;
      var html = lineHtml(line, cut ? LIMIT : 0, lm, cur);
      if (cut) html += '<span class="more" data-ln="' + i + '">… +' + (line.len - LIMIT).toLocaleString() + ' chars</span>';
      var li = lineIss[i + 1];
      var note = li ? '<div class="line-iss">' + li.map(function (x) { return '<span class="sev-tag ' + x.sev + '">' + SEV[x.sev].label + '</span> ' + esc(x.text.replace(/`/g, '')); }).join('<br>') + '</div>' : '';
      return '<span class="no' + (li ? ' bad ' + worst(li) : '') + '">' + (i + 1) + '</span><span class="tx">' + html + note + '</span>';
    }
    function renderAll() {
      var buf = [];
      for (var i = 0; i < lines.length; i++) buf.push('<div class="ln' + (lineIss[i + 1] ? ' has-iss' : '') + '" id="L' + (i + 1) + '">' + renderLine(i) + '</div>');
      code.innerHTML = buf.join('');
    }
    function rerenderLine(i) { var el = code.children[i]; if (el) el.innerHTML = renderLine(i); }
    code.addEventListener('click', function (e) { var m = e.target.closest('.more'); if (m) { var i = +m.getAttribute('data-ln'); expanded.add(i); rerenderLine(i); } });

    function doSearch() {
      var term = search.value, touched = new Set(matches.map(function (m) { return m.line; }));
      matches = []; cur = -1;
      if (term.length >= 2) {
        var tl = term.toLowerCase();
        lines.forEach(function (l, i) { var t = l.text.toLowerCase(), p = t.indexOf(tl); while (p >= 0 && matches.length < 5000) { matches.push({ line: i, start: p, end: p + tl.length, idx: matches.length }); touched.add(i); p = t.indexOf(tl, p + tl.length); } });
      }
      touched.forEach(rerenderLine);
      count.textContent = term.length >= 2 ? (matches.length ? matches.length + ' hits' : 'no hits') : '';
      if (matches.length) go(0);
    }
    function go(k) {
      if (!matches.length) return;
      var prevLine = cur >= 0 ? matches[cur].line : -1;
      cur = (k + matches.length) % matches.length;
      if (prevLine >= 0) rerenderLine(prevLine);
      rerenderLine(matches[cur].line);
      count.textContent = (cur + 1) + ' / ' + matches.length;
      var mk = code.querySelector('mark.cur'); if (mk) mk.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    var tmr;
    search.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(doSearch, 150); });
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1)); } if (e.key === 'Escape') { search.value = ''; doSearch(); } });
    var wrapCb = h('input', { type: 'checkbox' }); wrapCb.checked = S.ui.wrap;
    wrapCb.addEventListener('change', function () { S.ui.wrap = wrapCb.checked; saveUi(); code.classList.toggle('wrap', S.ui.wrap); });
    var colCb = h('input', { type: 'checkbox' }); colCb.checked = S.ui.collapse;
    colCb.addEventListener('change', function () { S.ui.collapse = colCb.checked; saveUi(); expanded.clear(); renderAll(); });
    var issCount = h('span', { class: 'search-count' });
    function nextIss(dir) {
      if (!issLines.length) return;
      issCur = (issCur + dir + issLines.length) % issLines.length;
      issCount.textContent = (issCur + 1) + ' / ' + issLines.length;
      jump(issLines[issCur]);
    }
    var bar = h('div', { class: 'toolbar' },
      d.sql.length > 1 ? fileSelect(d.sql, fi, function (i) { location.hash = studentHref(st.id, 'sql', 'f=' + i); }) : h('strong', null, entry.file.name),
      h('span', { class: 'muted small' }, plural(lines.length, 'line') + ' · ' + fmtSize(entry.file.size)),
      dumpOrigin(entry.text),
      !showFindings() ? null : issLines.length ? h('span', { class: 'search-box' },
        h('span', { class: 'chip err' }, plural(issLines.length, 'line') + ' with findings'),
        h('button', { class: 'btn small', title: 'Previous finding', onclick: function () { nextIss(-1); } }, '↑'),
        h('button', { class: 'btn small', title: 'Next finding', onclick: function () { nextIss(1); } }, '↓'), issCount) : h('span', { class: 'chip ok' }, 'no findings in the SQL'),
      h('div', { class: 'sep' }),
      h('span', { class: 'search-box' }, search, h('button', { class: 'btn small', onclick: function () { go(cur - 1); } }, '↑'), h('button', { class: 'btn small', onclick: function () { go(cur + 1); } }, '↓'), count),
      h('div', { class: 'grow' }),
      h('label', { class: 'check' }, colCb, 'Shorten long lines'),
      h('label', { class: 'check' }, wrapCb, 'Wrap'),
      h('a', { class: 'btn small', href: fileUrl(entry.file.path), target: '_blank' }, 'Raw'));

    var outline = h('nav', { class: 'sql-outline' });
    var parsed = entry.parsed;
    if (parsed) {
      var KLBL = { database: 'db', table: 'table', insert: 'data', alter: 'alter', view: 'view', routine: 'proc', unknown: '?' };
      [['database', 'Database'], ['table', 'CREATE TABLE'], ['insert', 'INSERT'], ['alter', 'ALTER TABLE'], ['view', 'Views'], ['routine', 'Routines'], ['unknown', 'Unrecognised']].forEach(function (g) {
        var list = parsed.statements.filter(function (s) { return s.kind === g[0]; });
        if (!list.length) return;
        outline.appendChild(h('div', { class: 'grp' }, g[1] + ' (' + list.length + ')'));
        list.forEach(function (s) {
          var nIss = 0;
          for (var L = s.line; L <= s.endLine; L++) if (lineIss[L]) nIss += lineIss[L].length;
          outline.appendChild(h('a', { href: 'javascript:void 0', title: 'Line ' + s.line, onclick: function () { jump(s.line); } },
            h('span', { class: 'k' }, KLBL[s.kind]), h('span', { class: 't' }, s.name || s.verb),
            nIss ? h('span', { class: 'mc error', title: nIss + ' finding(s)' }, nIss) : null,
            h('span', { class: 'r' }, s.kind === 'insert' ? (s.rows === null ? '?' : s.rows) : s.line)));
        });
      });
    } else outline.appendChild(h('div', { class: 'err-box' }, entry.error || 'Not parsed'));

    function jump(line) {
      var el = document.getElementById('L' + line);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
    body.appendChild(bar);
    body.appendChild(h('div', { class: 'sql-layout' }, outline, code));
    renderAll();
    var ln = +(qp.get('line') || 0);
    if (ln) requestAnimationFrame(function () { jump(ln); });
  }

  function dumpOrigin(text) {
    var head = text.slice(0, 1500), m;
    if (/phpMyAdmin SQL Dump/i.test(head)) { m = /Server[- ]version:?\s*([^\n]+)/i.exec(head); return h('span', { class: 'chip' }, 'phpMyAdmin' + (m ? ' · ' + m[1].trim() : '')); }
    if (/MySQL dump/i.test(head)) { m = /Server version\s*([^\n]+)/i.exec(head); return h('span', { class: 'chip' }, 'mysqldump' + (m ? ' · ' + m[1].trim() : '')); }
    if (/Navicat/i.test(head)) return h('span', { class: 'chip' }, 'Navicat');
    if (/HeidiSQL/i.test(head)) return h('span', { class: 'chip' }, 'HeidiSQL');
    return h('span', { class: 'chip' }, 'hand-written / other');
  }

  // ---------------------------------------------------------------- data
  function fmtVal(v) { return v === null ? 'NULL' : v === undefined ? '' : typeof v === 'object' ? v.expr : String(v); }

  function tabData(st, d, body, qp) {
    body.className = 's-body fill';
    if (!d.sql.length) { body.appendChild(emptyState('No SQL file', 'There is nothing to show without a .sql file.')); return; }
    var fi = Math.min(+(qp.get('f') || 0), d.sql.length - 1);
    var entry = d.sql[fi];
    if (!entry.parsed) { body.appendChild(h('div', { class: 'err-box' }, entry.error || 'Could not parse')); return; }
    var parsed = entry.parsed, tables = parsed.tables;
    var sel = qp.get('t'), selView = qp.get('v');
    var current = sel ? parsed.byName[sel.toLowerCase()] : null;
    var view = selView ? parsed.views.filter(function (v) { return v.name === selView; })[0] : null;
    if (!current && !view) current = tables[0] || null;
    var qs = function (extra) { return (fi ? 'f=' + fi + '&' : '') + extra; };
    var issues = entry === d.sqlMain && showFindings() ? d.issues.filter(function (i) { return i.where === 'SQL' && i.table; }) : [];
    var perTable = {}; issues.forEach(function (i) { var k = i.table.toLowerCase(); perTable[k] = (perTable[k] || 0) + 1; });
    var list = h('nav', { class: 'td-list' });
    list.appendChild(h('div', { class: 'sidebar-sep' }, 'Tables (' + tables.length + ')'));
    tables.forEach(function (t) {
      list.appendChild(h('a', { href: studentHref(st.id, 'data', qs('t=' + encodeURIComponent(t.name))), class: t === current ? 'active' : null },
        h('span', { class: 't' }, t.name), perTable[t.name.toLowerCase()] ? h('span', { class: 'mc error', title: 'findings' }, perTable[t.name.toLowerCase()]) : null,
        h('span', { class: 'r', title: 'rows' }, t.rows.length)));
    });
    if (parsed.views.length) {
      list.appendChild(h('div', { class: 'sidebar-sep' }, 'Views (' + parsed.views.length + ')'));
      parsed.views.forEach(function (v) { list.appendChild(h('a', { href: studentHref(st.id, 'data', qs('v=' + encodeURIComponent(v.name))), class: v === view ? 'active' : null }, h('span', { class: 't' }, v.name))); });
    }
    var detail = h('div', { class: 'td-detail' });
    if (d.sql.length > 1) body.appendChild(h('div', { class: 'toolbar' }, fileSelect(d.sql, fi, function (i) { location.hash = studentHref(st.id, 'data', 'f=' + i); })));
    body.appendChild(h('div', { class: 'td-layout' }, list, detail));
    if (view) { renderView(st, view, detail, fi); return; }
    if (!current) { detail.appendChild(emptyState('No tables', 'The SQL file contains no CREATE TABLE statements.')); return; }
    renderTable(st, parsed, issues, current, detail, fi);
  }

  function renderView(st, v, detail, fi) {
    detail.appendChild(h('div', { class: 'row' }, h('h2', null, v.name), h('span', { class: 'chip' }, 'VIEW'),
      h('a', { class: 'btn small', href: studentHref(st.id, 'sql', (fi ? 'f=' + fi + '&' : '') + 'line=' + v.line) }, 'Show in SQL file')));
    var code = h('div', { class: 'code wrap card', style: { marginTop: '14px', padding: '10px 0' } });
    code.innerHTML = highlightLines(v.sql).map(function (l, i) { return '<div class="ln"><span class="no">' + (i + 1) + '</span><span class="tx">' + lineHtml(l, 0, [], -1) + '</span></div>'; }).join('');
    detail.appendChild(code);
  }

  function renderTable(st, parsed, issues, t, detail, fi) {
    var fiq = fi ? 'f=' + fi + '&' : '';
    var link = function (tbl) { return studentHref(st.id, 'data', fiq + 't=' + encodeURIComponent(tbl)); };
    detail.appendChild(h('div', { class: 'row wrap' },
      h('h2', null, t.name),
      t.options.engine ? h('span', { class: 'chip' }, t.options.engine) : null,
      h('span', { class: 'chip accent' }, plural(t.rows.length, 'row')),
      h('div', { class: 'grow' }),
      h('a', { class: 'btn small', href: studentHref(st.id, 'sql', fiq + 'line=' + t.line) }, 'Show in SQL file')));
    var mine = sortIssues(issues.filter(function (i) { return i.table.toLowerCase() === t.name.toLowerCase(); }));
    if (mine.length) {
      var hb = h('div', { class: 'issue-list', style: { marginTop: '12px' } });
      mine.forEach(function (i) { hb.appendChild(issueItem(st, i)); });
      detail.appendChild(hb);
    }
    var incoming = [];
    parsed.tables.forEach(function (o) { o.foreignKeys.forEach(function (f) { if ((f.refTable || '').toLowerCase() === t.name.toLowerCase()) incoming.push({ table: o.name, fk: f }); }); });
    detail.appendChild(h('div', { class: 'section-title' }, h('h3', null, 'Columns')));
    var tb = h('tbody');
    t.columns.forEach(function (c, i) {
      var keys = [];
      if (c.isPK) keys.push(h('span', { class: 'badge pk' }, 'PK'));
      (c.fks || []).forEach(function (f) { keys.push(h('a', { class: 'badge fk', href: link(f.refTable), title: f.name ? 'Constraint ' + f.name : 'Foreign key' }, 'FK → ' + f.refTable + '.' + (f.refColumn || '?'))); });
      if (c.isUnique) keys.push(h('span', { class: 'badge uq' }, 'UQ'));
      if (c.inCompositeUnique) keys.push(h('span', { class: 'badge uq', title: 'part of a composite UNIQUE key' }, 'UQ*'));
      if (c.autoIncrement) keys.push(h('span', { class: 'badge ai' }, 'AI'));
      var colIss = mine.filter(function (x) { return x.text.indexOf('`' + t.name + '.' + c.name + '`') >= 0; });
      tb.appendChild(h('tr', { class: colIss.length ? 'row-iss' : null, title: colIss.map(function (x) { return x.text.replace(/`/g, ''); }).join('\n') || null },
        h('td', { class: 'faint' }, i + 1), h('td', { class: 'name' }, c.name), h('td', { class: 'type' }, c.type || '?'),
        h('td', null, c.nullable ? h('span', { class: 'faint' }, 'yes') : h('span', { class: 'badge nn' }, 'NOT NULL')),
        h('td', { class: 'def' }, c.defaultValue === undefined ? '' : fmtVal(c.defaultValue)), h('td', null, keys),
        h('td', { class: 'small' }, c.comment ? '“' + c.comment + '”' : '')));
    });
    detail.appendChild(h('div', { class: 'card cols-wrap' }, h('table', { class: 'grid cols-table' },
      h('thead', null, h('tr', null, ['#', 'Name', 'Type', 'Null', 'Default', 'Keys', 'Comment'].map(function (x) { return h('th', null, x); }))), tb)));
    var kv = h('div', { class: 'kv card', style: { padding: '12px 14px' } });
    var addKv = function (k, v) { kv.appendChild(h('div', { class: 'k' }, k)); kv.appendChild(h('div', null, v)); };
    addKv('Primary key', t.primaryKey.length ? h('code', null, t.primaryKey.join(', ')) : h('span', { class: 'chip err' }, 'none'));
    t.uniques.forEach(function (u) { addKv('Unique', [u.name && !u.inline ? h('code', { class: 'faint' }, u.name + ' ') : null, h('code', null, '(' + u.columns.join(', ') + ')')]); });
    t.foreignKeys.forEach(function (f) {
      addKv('Foreign key', [f.name ? h('code', { class: 'faint' }, f.name + ' ') : null, h('code', null, '(' + f.columns.join(', ') + ') → '), h('a', { href: link(f.refTable) }, h('code', null, f.refTable)), h('code', null, '(' + f.refColumns.join(', ') + ')'),
        f.onDelete ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'ON DELETE ' + f.onDelete) : null, f.onUpdate ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'ON UPDATE ' + f.onUpdate) : null]);
    });
    t.checks.forEach(function (k) { addKv('Check', [k.name ? h('code', { class: 'faint' }, k.name + ' ') : null, h('code', null, k.expr)]); });
    t.indexes.forEach(function (ix) { addKv('Index', [ix.name ? h('code', { class: 'faint' }, ix.name + ' ') : null, h('code', null, '(' + ix.columns.join(', ') + ')')]); });
    if (incoming.length) addKv('Referenced by', incoming.map(function (x, i) { return [i ? ', ' : '', h('a', { href: link(x.table) }, h('code', null, x.table + '.' + x.fk.columns.join('+')))]; }));
    detail.appendChild(h('div', { class: 'section-title' }, h('h3', null, 'Keys & constraints')));
    detail.appendChild(kv);

    detail.appendChild(h('div', { class: 'section-title' }, h('h3', null, 'Sample data'), h('span', { class: 'muted small' }, plural(t.rows.length, 'row'))));
    if (!t.rows.length) { detail.appendChild(h('div', { class: 'muted' }, 'No rows are inserted into this table.')); return; }
    var orphans = new Set();
    issues.forEach(function (x) {
      if (x.table && x.table.toLowerCase() === t.name.toLowerCase() && x.orphanRows) {
        var ci = t.columns.findIndex(function (c) { return c.name.toLowerCase() === x.column.toLowerCase(); });
        x.orphanRows.forEach(function (r) { orphans.add(r + ':' + ci); });
      }
    });
    var fkLookup = t.columns.map(function (c) {
      if (!c.fks || !c.fks.length) return null;
      var rt = parsed.byName[(c.fks[0].refTable || '').toLowerCase()];
      if (!rt || !rt.rows.length) return null;
      var ri = rt.columns.findIndex(function (x) { return (x.name || '').toLowerCase() === (c.fks[0].refColumn || '').toLowerCase(); });
      if (ri < 0) return null;
      var map = new Map(); rt.rows.forEach(function (r) { map.set(fmtVal(r[ri]).toLowerCase(), r); });
      return { table: rt, map: map };
    });
    var LIMIT = 200, showAll = false;
    var wrap = h('div', { class: 'data-wrap' });
    function draw() {
      var rows = showAll ? t.rows : t.rows.slice(0, LIMIT);
      var out = ['<table class="data"><thead><tr><th class="rn">#</th>'];
      t.columns.forEach(function (c) { out.push('<th title="' + esc(c.type || '') + '">' + esc(c.name) + '</th>'); });
      out.push('</tr></thead><tbody>');
      rows.forEach(function (r, ri) {
        out.push('<tr><td class="rn">' + (ri + 1) + '</td>');
        t.columns.forEach(function (c, ci) {
          var v = r[ci], cls = [], title = '', txt;
          if (v === undefined) { if (c.defaultValue !== undefined) { txt = fmtVal(c.defaultValue); cls.push('dflt'); title = 'not inserted – DEFAULT'; } else { txt = c.nullable ? 'NULL' : ''; cls.push('null'); } }
          else if (v === null) { txt = 'NULL'; cls.push('null'); }
          else {
            txt = fmtVal(v);
            if (typeof v === 'number') cls.push('n');
            if (t.autoCells && t.autoCells.has(ri + ':' + ci)) { cls.push('auto'); title = 'generated by AUTO_INCREMENT'; }
            var lk = fkLookup[ci];
            if (lk) { var ref = lk.map.get(txt.toLowerCase()); if (ref) { cls.push('fkv'); title = lk.table.name + ': ' + lk.table.columns.slice(0, 5).map(function (x, k) { return x.name + '=' + fmtVal(ref[k]); }).join(', '); } }
          }
          if (orphans.has(ri + ':' + ci)) { cls.push('orphan'); title = 'No matching row in the referenced table'; }
          if (!title && txt.length > 50) title = txt;
          out.push('<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(txt.length > 120 ? txt.slice(0, 120) + '…' : txt) + '</td>');
        });
        out.push('</tr>');
      });
      out.push('</tbody></table>');
      wrap.innerHTML = out.join('');
      if (!showAll && t.rows.length > LIMIT) wrap.appendChild(h('div', { style: { padding: '8px' } }, h('button', { class: 'btn small', onclick: function () { showAll = true; draw(); } }, 'Show all ' + t.rows.length + ' rows')));
    }
    draw();
    detail.appendChild(wrap);
  }

  // ------------------------------------------------------------ documents
  function tabDocs(st, d, body, qp) {
    body.className = 's-body fill';
    var docs = d.pdfs.concat(d.images);
    if (!docs.length) { body.appendChild(emptyState('No documents', 'This submission contains no PDF or image files.')); return; }
    var di = Math.min(+(qp.get('d') || 0), docs.length - 1), f = docs[di];
    body.appendChild(h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, docs.map(function (x, i) { return h('button', { class: i === di ? 'on' : '', onclick: function () { location.hash = studentHref(st.id, 'docs', 'd=' + i); } }, x.name); })),
      h('span', { class: 'muted small' }, fmtSize(f.size)), h('div', { class: 'grow' }), h('a', { class: 'btn small', href: fileUrl(f.path), target: '_blank' }, 'Open in new tab ↗')));
    if (f.kind === 'pdf') body.appendChild(h('iframe', { class: 'doc-frame', src: fileUrl(f.path) + '#view=FitH', title: f.name }));
    else body.appendChild(h('div', { class: 'img-gallery' }, h('img', { src: fileUrl(f.path), alt: f.name })));
  }

  // ---------------------------------------------------------------- files
  function tabFiles(st, d, body) {
    var tb = h('tbody');
    var openTab = { sql: 'sql', model: 'diagram', pdf: 'docs', image: 'docs' };
    st.files.forEach(function (f) {
      var idx = f.kind === 'sql' ? d.sql.findIndex(function (x) { return x.file === f; }) : f.kind === 'model' ? d.models.findIndex(function (x) { return x.file === f; }) : d.pdfs.concat(d.images).indexOf(f);
      tb.appendChild(h('tr', null, h('td', null, h('code', null, f.name)), h('td', null, h('span', { class: 'chip' }, f.kind)), h('td', { class: 'num' }, fmtSize(f.size)), h('td', { class: 'muted' }, f.modified.replace('T', ' ')),
        h('td', null, h('div', { class: 'row' },
          openTab[f.kind] ? h('a', { class: 'btn small', href: studentHref(st.id, openTab[f.kind], (f.kind === 'pdf' || f.kind === 'image' ? 'd=' : 'f=') + idx) }, 'View') : null,
          h('a', { class: 'btn small', href: fileUrl(f.path), target: '_blank' }, 'Raw'),
          h('a', { class: 'btn small', href: fileUrl(f.path), download: f.name.split('/').pop() }, 'Download'),
          S.index && S.index.single ? h('button', { class: 'btn small danger', onclick: function () { removeSingleFile(f.path); } }, 'Remove') : null))));
    });
    body.appendChild(h('div', { class: 'page' }, h('div', { class: 'card' }, h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Modified'), h('th', null, ''))), tb))));
  }

  // ============================================================= compare
  function renderCompare(qp) {
    var a = qp.get('a') || '__solution', b = qp.get('b') || (S.students[0] && S.students[0].id), mode = qp.get('mode') || 'diagram';
    var setQ = function (k, v) { var p = new URLSearchParams(qp.toString()); p.set('a', a); p.set('b', b); p.set('mode', mode); p.set(k, v); location.hash = '#/compare?' + p.toString(); };
    var page = h('div', { class: 'page-full' }), ctls = [];
    page.appendChild(h('div', { class: 'toolbar' }, h('strong', null, 'Compare'),
      h('div', { class: 'seg' }, [['diagram', 'Diagram'], ['schema', 'Tables']].map(function (m) { return h('button', { class: mode === m[0] ? 'on' : '', onclick: function () { setQ('mode', m[0]); } }, m[1]); })),
      mode === 'diagram' ? viewSeg(function (v) { ctls.forEach(function (c) { if (c) c.setView(v); }); }) : null));
    var host = h('div', { class: 'dg-host' });
    page.appendChild(host);
    setMain(page, true);
    var load = function (id) {
      if (id === '__solution') return Promise.resolve({ name: 'Model solution', model: S.solution, parsed: null, issues: [] });
      var st = S.byId[id];
      if (!st) return Promise.resolve(null);
      return loadStudent(st).then(function (d) { return { name: st.name, st: st, model: d.modelMain && d.modelMain.model || (d.models[0] && d.models[0].model), parsed: d.sqlMain && d.sqlMain.parsed, issues: showFindings() ? d.issues.filter(function (i) { return i.view; }) : [] }; });
    };
    Promise.all([a, b].map(load)).then(function (srcs) {
      host.innerHTML = '';
      var schemas = srcs.map(function (s) { return s ? schemaOf(s) : []; });
      srcs.forEach(function (src, i) {
        var col = h('div', { class: 'dg-pane' });
        var sel = h('select', null, [h('option', { value: '__solution', selected: [a, b][i] === '__solution' }, '★ Model solution')].concat(S.students.map(function (s) { return h('option', { value: s.id, selected: [a, b][i] === s.id }, s.name); })));
        sel.addEventListener('change', function () { setQ(i ? 'b' : 'a', sel.value); });
        col.appendChild(h('div', { class: 'cmp-pane-head' }, sel, src && src.st ? h('a', { class: 'btn small', href: studentHref(src.st.id, 'review') }, 'Open') : null));
        host.appendChild(col);
        if (!src) return;
        if (mode === 'diagram') { var p = diagramPane(src.model, null, src.issues); p.pane.style.flex = '1'; col.appendChild(p.pane); ctls.push(p.ctl); }
        else {
          var names = new Set(schemas[1 - i].map(function (t) { return SqlParse.normName(t.name); }));
          var list = h('div', { class: 'schema-list' });
          schemas[i].forEach(function (t) {
            list.appendChild(h('div', { class: 'card schema-tbl' }, h('div', { class: 'card-head' + (names.has(SqlParse.normName(t.name)) ? ' matched' : '') }, t.name),
              h('ul', null, t.columns.map(function (c) { return h('li', null, c.key ? h('span', { class: 'badge ' + c.key.toLowerCase() }, c.key) : null, ' ', c.name, h('span', { class: 'ty' }, c.type)); }))));
          });
          col.appendChild(list);
        }
      });
    });
  }
  function schemaOf(src) {
    if (src.parsed) return src.parsed.tables.map(function (t) { return { name: t.name, columns: t.columns.map(function (c) { return { name: c.name, type: c.type, key: c.isPK ? 'PK' : (c.fks && c.fks.length ? 'FK' : '') }; }) }; });
    return (src.model && Diagram.toSchema(src.model) || []).map(function (t) { return { name: t.name, columns: t.columns.map(function (c) { return { name: c.name, type: c.type, key: /^pk/i.test(c.name) ? 'PK' : /^(pk)?fk/i.test(c.name) ? 'FK' : '' }; }) }; });
  }

  // ========================================================== reference
  function renderPdfPage(list, title, extra) {
    var page = h('div', { class: 'page-full' });
    var f = (list || [])[0];
    page.appendChild(h('div', { class: 'toolbar' }, h('strong', null, title), f ? h('span', { class: 'muted small' }, f.name) : null, h('div', { class: 'grow' }), extra || null,
      f ? h('a', { class: 'btn small', href: f.url, target: '_blank' }, 'Open in new tab ↗') : null));
    if (!f) { page.appendChild(emptyState('No document', 'No PDF is available for this page.')); setMain(page, true); return; }
    page.appendChild(h('iframe', { class: 'doc-frame', src: f.url + '#view=FitH', title: title }));
    setMain(page, true);
  }
  function renderStory() {
    renderPdfPage(S.refFiles.story, 'User story', [
      h('button', { class: 'btn small', onclick: replaceStory, title: 'Use the user story of your own assignment (kept in this browser)' }, 'Use my own PDF…'),
      S.customStory ? h('button', { class: 'btn small', onclick: function () { resetReference('story'); } }, 'Back to the default') : null]);
  }
  function renderSolution(qp) {
    var page = h('div', { class: 'page-full' }), mode = qp.get('mode') || 'interactive', imgs = (S.refFiles || {}).images || [], ctl = null;
    var sol = (S.refFiles.solution || [])[0];
    page.appendChild(h('div', { class: 'toolbar' }, h('strong', null, 'Model solution'), sol ? h('span', { class: 'muted small' }, sol.name + (S.customSolution ? ' (your own)' : '')) : null,
      h('div', { class: 'seg' }, [['interactive', 'Interactive'], ['png', 'PNG exports (' + imgs.length + ')']].map(function (m) { return h('button', { class: mode === m[0] ? 'on' : '', onclick: function () { location.hash = '#/ref/solution?mode=' + m[0]; } }, m[1]); })),
      mode === 'interactive' ? viewSeg(function (v) { if (ctl) ctl.setView(v); }) : null,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: replaceSolution, title: 'Check the submissions against your own Modelizer model solution (.mdlz / .json). It is kept in this browser.' }, 'Use my own model solution…'),
      S.customSolution ? h('button', { class: 'btn small', onclick: function () { resetReference('solution'); } }, 'Back to the default') : null));
    if (mode === 'png') {
      var g = h('div', { class: 'img-gallery' });
      if (!imgs.length) g.appendChild(emptyState('No PNG exports', S.customSolution ? 'PNG exports are only bundled for the default solution.' : 'No PNG exports available.'));
      imgs.forEach(function (im) { g.appendChild(h('figure', null, h('figcaption', null, im.name), h('img', { src: im.url, alt: im.name }))); });
      page.appendChild(g); setMain(page, true); return;
    }
    var host = h('div', { class: 'dg-host' });
    page.appendChild(host); setMain(page, true);
    if (!S.solution) { host.appendChild(h('div', { class: 'err-box' }, S.solutionError || 'No model solution loaded.')); return; }
    var p = diagramPane(S.solution, null); host.appendChild(p.pane); ctl = p.ctl;
  }

  // ============================================================ keyboard
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (e.key === 'b' || e.key === 'B') { toggleSidebar(); e.preventDefault(); return; }
    if (e.key === 'f' || e.key === 'F') { setFindings(!showFindings()); e.preventDefault(); return; }
    var r = parseHash();
    if (!(r.parts[0] === 's' && S.byId[r.parts[1]])) return;
    var st = S.byId[r.parts[1]], idx = S.students.indexOf(st), tab = r.parts[2] || 'review';
    if (e.key === 'j' || e.key === 'J') { var n = S.students[idx + 1]; if (n) location.hash = studentHref(n.id, tab); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'K') { var p = S.students[idx - 1]; if (p) location.hash = studentHref(p.id, tab); e.preventDefault(); }
    else if (/^[1-6]$/.test(e.key)) { location.hash = studentHref(st.id, TABS[+e.key - 1].key); e.preventDefault(); }
  }

  boot();
})();
