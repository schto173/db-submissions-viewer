/*
 * Browser-side storage: imported workspaces live in IndexedDB on this computer.
 * Nothing is uploaded anywhere. Also turns a Moodle "Download all submissions"
 * zip into a workspace (one folder per student).
 */
(function (root) {
  'use strict';

  var DB_NAME = 'submissions-viewer', DB_VERSION = 1;
  var MOODLE_RE = /^(.+?)_(\d+)_assign(?:submission|feedback)_(\w+)$/;
  var FLAT_RE = /^(.+?_\d+_assign(?:submission|feedback)_(?:file|onlinetext))_(.+)$/;
  var KIND_BY_EXT = {
    '.sql': 'sql', '.json': 'model', '.mdlz': 'model', '.pdf': 'pdf',
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'other',
    '.txt': 'text', '.md': 'text', '.html': 'text',
    '.zip': 'archive', '.rar': 'archive', '.7z': 'archive',
    '.docx': 'office', '.doc': 'office', '.pptx': 'office', '.xlsx': 'office'
  };
  // Only these types are rendered by the browser; everything else (HTML, SVG, scripts …)
  // is stored as plain text so a submitted file can never run code in this page.
  var SAFE_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  var MAX_UNPACKED = 4 * 1024 * 1024 * 1024;

  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains('workspaces')) d.createObjectStore('workspaces', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: ['ws', 'path'] }).createIndex('ws', 'ws');
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error || new Error('This browser does not allow local storage here.')); };
    });
    return dbp;
  }
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode), out;
        t.oncomplete = function () { resolve(out); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('Storage error')); };
        out = fn(t);
      });
    });
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function ext(name) { var m = /\.[^./\\]+$/.exec(name); return m ? m[0].toLowerCase() : ''; }
  function typeFor(name) { return SAFE_TYPES[ext(name)] || 'text/plain;charset=utf-8'; }

  function safeParts(name) {
    var parts = name.split(/[\\/]+/).filter(function (p) { return p && p !== '.'; });
    if (!parts.length || parts.some(function (p) { return p === '..'; }) || /:/.test(parts[0])) return null;
    if (parts[0] === '__MACOSX' || /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(parts[parts.length - 1])) return null;
    return parts;
  }

  /** Import a Moodle zip. onProgress(text). Resolves to the new workspace id. */
  function importZip(file, onProgress) {
    onProgress = onProgress || function () {};
    var title = file.name.replace(/\.zip$/i, '') || 'Submissions';
    var files = []; // {parts, entry}
    var total = 0;
    onProgress('Reading zip…');
    return Zip.read(file).then(function (entries) {
      entries.forEach(function (e) {
        if (e.dir) return;
        var parts = safeParts(e.name);
        if (!parts) return;
        total += e.size;
        if (total > MAX_UNPACKED) throw new Error('The zip is too large when unpacked (over 4 GB).');
        files.push({ parts: parts, entry: e });
      });
      // unwrap a single wrapping folder (not a student folder)
      for (;;) {
        var tops = {};
        files.forEach(function (f) { tops[f.parts.length > 1 ? f.parts[0] : '\u0000file'] = 1; });
        var keys = Object.keys(tops);
        if (keys.length === 1 && keys[0] !== '\u0000file' && !MOODLE_RE.test(keys[0])) files.forEach(function (f) { f.parts.shift(); });
        else break;
      }
      // not a Moodle export (no student folders / names): treat the whole zip as
      // one student's submission
      var single = !files.some(function (f) { return MOODLE_RE.test(f.parts[0]) || (f.parts.length === 1 && FLAT_RE.test(f.parts[0])); });
      if (single) files.forEach(function (f) { f.parts = [safeFolder(title)].concat(f.parts.length > 1 ? [f.parts.join('_')] : f.parts); });
      // flat layout: Name_123_assignsubmission_file_<file>  ->  folder per student
      if (!single) files.forEach(function (f) {
        if (f.parts.length === 1) {
          var m = FLAT_RE.exec(f.parts[0]);
          if (m && !MOODLE_RE.test(f.parts[0])) f.parts = [m[1], m[2]];
          else f.parts = ['_unassigned', f.parts[0]];
        }
      });
      var students = {};
      files.forEach(function (f) { if (!/^[_.]/.test(f.parts[0])) students[f.parts[0]] = 1; });
      if (!Object.keys(students).length) throw new Error('No submission folders found in this zip. Use Moodle → “Download all submissions”.');
      var id = title + '-' + Date.now().toString(36);
      var records = [], done = 0;
      var unpackOne = function (f) {
        return f.entry.blob(typeFor(f.parts[f.parts.length - 1])).then(function (blob) {
          done++;
          if (done % 10 === 0) onProgress('Unpacking ' + done + ' / ' + files.length + ' files…');
          var path = f.parts.join('/');
          records.push({ ws: id, path: path, blob: blob, modified: f.entry.modified });
          // zips uploaded by students: unpack next to them (one level)
          if (ext(path) === '.zip' && !/^[_.]/.test(f.parts[0])) {
            return Zip.read(blob).then(function (inner) {
              var base = f.parts.slice(0, -1).concat(f.parts[f.parts.length - 1].replace(/\.zip$/i, '') + '_unzipped');
              return Promise.all(inner.filter(function (e) { return !e.dir; }).map(function (e) {
                var ip = safeParts(e.name);
                if (!ip) return null;
                return e.blob(typeFor(e.name)).then(function (b) { records.push({ ws: id, path: base.concat(ip).join('/'), blob: b, modified: e.modified }); });
              }));
            }).catch(function () { /* not a readable zip: keep it as a file */ });
          }
        });
      };
      // unpack sequentially in small batches to keep memory use low
      var i = 0;
      var next = function () {
        if (i >= files.length) return Promise.resolve();
        var batch = files.slice(i, i + 8); i += 8;
        return Promise.all(batch.map(unpackOne)).then(next);
      };
      return next().then(function () {
        onProgress('Saving…');
        var index = buildIndex(records);
        var ws = { id: id, title: title, created: new Date().toISOString(), count: index.length, students: index, single: single };
        return tx(['workspaces', 'files'], 'readwrite', function (t) {
          t.objectStore('workspaces').put(ws);
          var fs = t.objectStore('files');
          records.forEach(function (r) { fs.put(r); });
        }).then(function () {
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
          return id;
        });
      });
    });
  }

  function buildIndex(records) {
    var byStudent = {};
    records.forEach(function (r) {
      var parts = r.path.split('/');
      if (/^[_.]/.test(parts[0]) || parts.length < 2) return;
      (byStudent[parts[0]] = byStudent[parts[0]] || []).push(r);
    });
    return Object.keys(byStudent).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).map(function (dir) {
      var m = MOODLE_RE.exec(dir);
      return {
        id: dir, name: m ? m[1] : dir, moodleId: m ? m[2] : null,
        files: byStudent[dir].sort(function (a, b) { return a.path.toLowerCase().localeCompare(b.path.toLowerCase()); }).map(function (r) {
          var e = ext(r.path);
          return { path: r.path, name: r.path.slice(dir.length + 1), size: r.blob.size, ext: e, kind: KIND_BY_EXT[e] || 'other', modified: r.modified || '' };
        })
      };
    });
  }

  function listWorkspaces() {
    return tx(['workspaces'], 'readonly', function (t) { return req(t.objectStore('workspaces').getAll()); })
      .then(function (p) { return p; }).then(function (list) {
        return (list || []).map(function (w) { return { id: w.id, title: w.title, count: w.count, created: w.created, single: !!w.single }; })
          .sort(function (a, b) { return b.created.localeCompare(a.created); });
      });
  }
  function getWorkspace(id) {
    var ws, files;
    return tx(['workspaces', 'files'], 'readonly', function (t) {
      req(t.objectStore('workspaces').get(id)).then(function (w) { ws = w; });
      req(t.objectStore('files').index('ws').getAll(id)).then(function (f) { files = f; });
    }).then(function () {
      if (!ws) throw new Error('Workspace not found');
      var blobs = {};
      (files || []).forEach(function (r) { blobs[r.path] = r.blob; });
      return { id: ws.id, title: ws.title, students: ws.students, blobs: blobs, single: !!ws.single };
    });
  }
  function removeWorkspace(id) {
    return tx(['workspaces', 'files'], 'readwrite', function (t) {
      t.objectStore('workspaces').delete(id);
      var idx = t.objectStore('files').index('ws');
      var cur = idx.openKeyCursor(IDBKeyRange.only(id));
      cur.onsuccess = function () { var c = cur.result; if (c) { t.objectStore('files').delete(c.primaryKey); c.continue(); } };
    });
  }
  function getSetting(key) { return tx(['settings'], 'readonly', function (t) { return req(t.objectStore('settings').get(key)); }).then(function (p) { return p; }); }
  function setSetting(key, value) { return tx(['settings'], 'readwrite', function (t) { if (value === undefined) t.objectStore('settings').delete(key); else t.objectStore('settings').put(value, key); }); }

  // ---------------------------------------------------- single submission
  // A workspace with one student whose files are added (and removed) one by one.
  function safeFolder(n) { return (String(n || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/^[_.\s]+/, '').trim() || 'Submission').slice(0, 80); }
  function fileRecords(wsId, folder, fileList) {
    var when = new Date().toISOString().slice(0, 16);
    return Array.prototype.map.call(fileList, function (f) {
      var name = String(f.name).split(/[\\/]/).pop() || 'file';
      return { ws: wsId, path: folder + '/' + name, blob: new Blob([f], { type: typeFor(name) }), modified: when };
    });
  }
  function rebuild(wsId, mutate) {
    return tx(['workspaces', 'files'], 'readwrite', function (t) {
      var wsStore = t.objectStore('workspaces'), fs = t.objectStore('files');
      mutate(fs);
      req(wsStore.get(wsId)).then(function (ws) {
        req(fs.index('ws').getAll(wsId)).then(function (records) {
          ws.students = buildIndex(records);
          ws.count = ws.students.length;
          wsStore.put(ws);
        });
      });
    });
  }
  function createSingle(name, fileList) {
    var folder = safeFolder(name);
    var id = 'single-' + Date.now().toString(36);
    var ws = { id: id, title: folder, created: new Date().toISOString(), count: 0, students: [], single: true };
    return tx(['workspaces'], 'readwrite', function (t) { t.objectStore('workspaces').put(ws); })
      .then(function () { return addFiles(id, folder, fileList); })
      .then(function () { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); return { id: id, student: folder }; });
  }
  function addFiles(wsId, folder, fileList) {
    var recs = fileRecords(wsId, safeFolder(folder), fileList);
    return rebuild(wsId, function (fs) { recs.forEach(function (r) { fs.put(r); }); });
  }
  function removeFile(wsId, path) {
    return rebuild(wsId, function (fs) { fs.delete([wsId, path]); });
  }

  root.Store = { createSingle: createSingle, addFiles: addFiles, removeFile: removeFile, importZip: importZip, listWorkspaces: listWorkspaces, getWorkspace: getWorkspace, removeWorkspace: removeWorkspace, getSetting: getSetting, setSetting: setSetting, typeFor: typeFor };
})(window);
