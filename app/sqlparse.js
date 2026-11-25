/*
 * Lightweight MySQL/MariaDB dump parser.
 * Understands phpMyAdmin dumps, mysqldump output and hand-written scripts well
 * enough to recover tables, columns, keys, foreign keys, checks, views and the
 * rows inserted with INSERT statements. It does not validate SQL.
 * Works in the browser (window.SqlParse) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ lexer
  var WORD_RE = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
  var NUM_RE = /(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
  var VAR_RE = /@@?[\p{L}\p{N}_$.]+/uy;
  var WS_RE = /[ \t\r\n\f\v ﻿]+/y;

  function countNl(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }

  function readQuoted(text, i, q) {
    // returns end index (exclusive) of a quoted token starting at i
    var j = i + 1, n = text.length;
    while (j < n) {
      var c = text[j];
      if (c === '\\' && q !== '`') { j += 2; continue; }
      if (c === q) {
        if (text[j + 1] === q) { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return n; // unterminated
  }

  function unquote(raw) {
    var q = raw[0];
    var body = raw.slice(1, raw[raw.length - 1] === q && raw.length > 1 ? -1 : raw.length);
    if (q === '`') return body.replace(/``/g, '`');
    var dbl = q + q;
    var out = '';
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      if (c === '\\' && i + 1 < body.length) {
        var d = body[++i];
        out += d === 'n' ? '\n' : d === 't' ? '\t' : d === 'r' ? '\r' : d === '0' ? '\0' :
          d === 'Z' ? '\x1a' : d === 'b' ? '\b' : d;
      } else if (c === q && body[i + 1] === q) {
        out += q; i++;
      } else out += c;
    }
    return out;
  }

  /**
   * Tokenize SQL text. Token: {t, v, line, start}
   * t: ws | comment | ccomment | str | qident | num | word | var | punct | op
   */
  function lex(text, baseLine) {
    var toks = [], i = 0, n = text.length, line = baseLine || 1;
    function push(t, start, end) {
      var v = text.slice(start, end);
      toks.push({ t: t, v: v, line: line, start: start });
      line += countNl(v);
      i = end;
    }
    while (i < n) {
      var c = text[i];
      WS_RE.lastIndex = i;
      if (WS_RE.test(text)) { push('ws', i, WS_RE.lastIndex); continue; }
      if (c === '-' && text[i + 1] === '-' && (i + 2 >= n || /[ \t\r\n]/.test(text[i + 2]))) {
        var e = text.indexOf('\n', i); push('comment', i, e < 0 ? n : e); continue;
      }
      if (c === '#') { var e2 = text.indexOf('\n', i); push('comment', i, e2 < 0 ? n : e2); continue; }
      if (c === '/' && text[i + 1] === '*') {
        var e3 = text.indexOf('*/', i + 2); e3 = e3 < 0 ? n : e3 + 2;
        push(text[i + 2] === '!' ? 'ccomment' : 'comment', i, e3); continue;
      }
      if (c === "'" || c === '"') { push('str', i, readQuoted(text, i, c)); continue; }
      if (c === '`') { push('qident', i, readQuoted(text, i, '`')); continue; }
      if ((c === 'x' || c === 'X' || c === 'b' || c === 'B' || c === 'n' || c === 'N') && text[i + 1] === "'") {
        push('str', i, readQuoted(text, i + 1, "'")); continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        NUM_RE.lastIndex = i;
        if (NUM_RE.test(text)) { push('num', i, NUM_RE.lastIndex); continue; }
      }
      WORD_RE.lastIndex = i;
      if (WORD_RE.test(text)) { push('word', i, WORD_RE.lastIndex); continue; }
      if (c === '@') {
        VAR_RE.lastIndex = i;
        if (VAR_RE.test(text)) { push('var', i, VAR_RE.lastIndex); continue; }
      }
      if ('(),;.'.indexOf(c) >= 0) { push('punct', i, i + 1); continue; }
      var two = text.substr(i, 2);
      if (['<=', '>=', '<>', '!=', ':=', '||', '&&', '<<', '>>', '->'].indexOf(two) >= 0) { push('op', i, i + 2); continue; }
      push('op', i, i + 1);
    }
    return toks;
  }

  // Expand /*!40101 ... */ conditional comments into real tokens, drop ws/comments.
  function significant(toks) {
    var out = [];
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k];
      if (tk.t === 'ws' || tk.t === 'comment') continue;
      if (tk.t === 'ccomment') {
        var m = /^\/\*!(\d*)/.exec(tk.v);
        var inner = tk.v.slice(m[0].length, tk.v.endsWith('*/') ? -2 : tk.v.length);
        var sub = significant(lex(inner, tk.line));
        for (var s = 0; s < sub.length; s++) out.push(sub[s]);
        continue;
      }
      out.push(tk);
    }
    return out;
  }

  // ------------------------------------------------------ statement split
  function splitStatements(text) {
    var toks = lex(text, 1);
    var stmts = [], cur = [], delim = ';', i = 0;
    function flush(endLine) {
      var sig = significant(cur);
      if (sig.length) {
        stmts.push({
          toks: sig,
          line: sig[0].line,
          endLine: endLine || sig[sig.length - 1].line,
          start: firstStart(cur),
          end: lastEnd(cur)
        });
      }
      cur = [];
    }
    function firstStart(arr) {
      for (var a = 0; a < arr.length; a++) if (arr[a].t !== 'ws' && arr[a].t !== 'comment') return arr[a].start;
      return arr.length ? arr[0].start : 0;
    }
    function lastEnd(arr) {
      for (var a = arr.length - 1; a >= 0; a--) if (arr[a].t !== 'ws' && arr[a].t !== 'comment') return arr[a].start + arr[a].v.length;
      return 0;
    }
    function hasSig() {
      for (var a = 0; a < cur.length; a++) if (cur[a].t !== 'ws' && cur[a].t !== 'comment') return true;
      return false;
    }
    while (i < toks.length) {
      var tk = toks[i];
      if (tk.t === 'word' && tk.v.toUpperCase() === 'DELIMITER' && !hasSig()) {
        var eol = text.indexOf('\n', tk.start); if (eol < 0) eol = text.length;
        var d = text.slice(tk.start + tk.v.length, eol).trim();
        if (d) delim = d;
        while (i < toks.length && toks[i].start < eol) i++;
        cur = [];
        continue;
      }
      if (delim === ';') {
        if (tk.t === 'punct' && tk.v === ';') { flush(tk.line); i++; continue; }
      } else if (tk.t !== 'ws' && tk.t !== 'comment' && tk.t !== 'str' && tk.t !== 'qident' &&
        text.startsWith(delim, tk.start)) {
        var endPos = tk.start + delim.length, ln = tk.line;
        while (i < toks.length && toks[i].start < endPos) i++;
        flush(ln);
        continue;
      }
      cur.push(tk); i++;
    }
    flush();
    return stmts;
  }

  // ------------------------------------------------------------- cursor
  function Cur(toks) { this.t = toks; this.i = 0; }
  Cur.prototype.peek = function (k) { return this.t[this.i + (k || 0)] || null; };
  Cur.prototype.next = function () { return this.t[this.i++] || null; };
  Cur.prototype.eof = function () { return this.i >= this.t.length; };
  Cur.prototype.isWord = function (w, k) {
    var tk = this.peek(k);
    return !!tk && tk.t === 'word' && tk.v.toUpperCase() === w;
  };
  Cur.prototype.isPunct = function (p, k) {
    var tk = this.peek(k);
    return !!tk && tk.t === 'punct' && tk.v === p;
  };
  Cur.prototype.isOp = function (p, k) {
    var tk = this.peek(k);
    return !!tk && tk.t === 'op' && tk.v === p;
  };
  Cur.prototype.acceptWord = function () {
    for (var a = 0; a < arguments.length; a++) if (!this.isWord(arguments[a], a)) return false;
    this.i += arguments.length;
    return true;
  };
  Cur.prototype.acceptOneOf = function (list) {
    var tk = this.peek();
    if (tk && tk.t === 'word' && list.indexOf(tk.v.toUpperCase()) >= 0) { this.i++; return tk.v.toUpperCase(); }
    return null;
  };
  Cur.prototype.acceptPunct = function (p) { if (this.isPunct(p)) { this.i++; return true; } return false; };
  Cur.prototype.acceptOp = function (p) { if (this.isOp(p)) { this.i++; return true; } return false; };
  // Returns tokens inside the parenthesis group starting at the current '('.
  Cur.prototype.group = function () {
    if (!this.isPunct('(')) return null;
    var depth = 0, start = this.i;
    for (var j = this.i; j < this.t.length; j++) {
      var tk = this.t[j];
      if (tk.t === 'punct' && tk.v === '(') depth++;
      else if (tk.t === 'punct' && tk.v === ')') {
        depth--;
        if (depth === 0) { this.i = j + 1; return this.t.slice(start + 1, j); }
      }
    }
    this.i = this.t.length;
    return this.t.slice(start + 1);
  };
  Cur.prototype.ident = function () {
    var tk = this.peek();
    if (!tk) return null;
    if (tk.t === 'qident' || tk.t === 'str') { this.i++; return unquote(tk.v); }
    if (tk.t === 'word') { this.i++; return tk.v; }
    return null;
  };
  // schema.table → table
  Cur.prototype.qname = function () {
    var a = this.ident();
    if (a !== null && this.isPunct('.')) { this.i++; var b = this.ident(); return b === null ? a : b; }
    return a;
  };
  Cur.prototype.rest = function () { var r = this.t.slice(this.i); this.i = this.t.length; return r; };

  function splitCommas(toks) {
    var parts = [], cur = [], depth = 0;
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k];
      if (tk.t === 'punct' && tk.v === '(') depth++;
      else if (tk.t === 'punct' && tk.v === ')') depth--;
      if (depth === 0 && tk.t === 'punct' && tk.v === ',') { parts.push(cur); cur = []; continue; }
      cur.push(tk);
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  function joinToks(toks) {
    var out = '';
    for (var k = 0; k < toks.length; k++) {
      var tk = toks[k], prev = toks[k - 1];
      var glue = prev && !(prev.t === 'punct' && (prev.v === '(' || prev.v === '.')) &&
        !(tk.t === 'punct' && (tk.v === ')' || tk.v === ',' || tk.v === '.')) &&
        !(tk.t === 'punct' && tk.v === '(' && prev.t === 'word');
      out += (glue ? ' ' : '') + tk.v;
    }
    return out;
  }

  function identList(toks) {
    // `a`(10), `b` DESC  → ['a','b']
    return splitCommas(toks).map(function (p) {
      var c = new Cur(p); return c.ident();
    }).filter(function (x) { return x !== null; });
  }

  // ------------------------------------------------------------- values
  function tokValue(g) {
    if (g.length === 1) {
      var tk = g[0];
      if (tk.t === 'str') {
        if (/^[xXbB]'/.test(tk.v)) return { expr: tk.v };
        if (/^[nN]'/.test(tk.v)) return unquote(tk.v.slice(1));
        return unquote(tk.v);
      }
      if (tk.t === 'num') {
        if (/^0x/i.test(tk.v)) return { expr: tk.v };
        var num = Number(tk.v);
        return (isFinite(num) && String(num) === tk.v.replace(/^0+(?=\d)/, '')) ? num : tk.v;
      }
      if (tk.t === 'word') {
        var u = tk.v.toUpperCase();
        if (u === 'NULL') return null;
        if (u === 'TRUE') return 1;
        if (u === 'FALSE') return 0;
        return { expr: tk.v };
      }
    }
    if (g.length === 2 && g[0].t === 'op' && (g[0].v === '-' || g[0].v === '+') && g[1].t === 'num') {
      var nv = Number(g[0].v + g[1].v);
      return isFinite(nv) ? nv : g[0].v + g[1].v;
    }
    return { expr: joinToks(g) };
  }

  function valueToString(v) {
    if (v === null) return 'NULL';
    if (v === undefined) return '';
    if (typeof v === 'object') return v.expr;
    return String(v);
  }

  // ---------------------------------------------------------- definitions
  var COL_STOP = ['NOT', 'NULL', 'DEFAULT', 'AUTO_INCREMENT', 'UNIQUE', 'PRIMARY', 'KEY', 'COMMENT',
    'UNSIGNED', 'SIGNED', 'ZEROFILL', 'CHARACTER', 'CHARSET', 'COLLATE', 'ON', 'CHECK', 'REFERENCES',
    'GENERATED', 'AS', 'VIRTUAL', 'STORED', 'PERSISTENT', 'INVISIBLE', 'VISIBLE', 'COLUMN_FORMAT',
    'STORAGE', 'CONSTRAINT', 'SERIAL', 'BINARY', 'ASCII', 'UNICODE', 'SRID'];

  function parseColumn(toks) {
    var c = new Cur(toks);
    var col = {
      name: c.ident(), type: '', baseType: '', typeArgs: [], unsigned: false, nullable: true,
      explicitNull: null, defaultValue: undefined, autoIncrement: false, unique: false, primary: false,
      comment: '', onUpdate: '', checks: [], inlineRef: null, generated: ''
    };
    // type
    var tt = c.peek();
    if (tt && tt.t === 'word') {
      c.next();
      var base = tt.v.toLowerCase();
      if (base === 'double' && c.isWord('PRECISION')) { c.next(); base = 'double precision'; }
      if ((base === 'character' || base === 'char') && c.isWord('VARYING')) { c.next(); base = 'varchar'; }
      if (base === 'national') { var nx = c.next(); base = nx ? nx.v.toLowerCase() : base; }
      col.baseType = base;
      var args = c.isPunct('(') ? c.group() : null;
      if (args) {
        col.typeArgs = splitCommas(args).map(function (p) { var v = tokValue(p); return v && typeof v === 'object' ? v.expr : v; });
        col.type = base + '(' + splitCommas(args).map(joinToks).join(',') + ')';
      } else col.type = base;
      if (base === 'serial') { col.autoIncrement = true; col.nullable = false; col.unique = true; col.baseType = 'bigint'; col.unsigned = true; }
    }
    while (!c.eof()) {
      var tk = c.peek();
      var u = tk.t === 'word' ? tk.v.toUpperCase() : null;
      if (u === 'NOT' && c.isWord('NULL', 1)) { c.i += 2; col.nullable = false; col.explicitNull = false; }
      else if (u === 'NULL') { c.next(); col.nullable = true; col.explicitNull = true; }
      else if (u === 'DEFAULT') {
        c.next();
        if (c.isPunct('(')) { col.defaultValue = { expr: '(' + joinToks(c.group()) + ')' }; }
        else {
          var g = [c.next()];
          if (g[0] && g[0].t === 'op' && (g[0].v === '-' || g[0].v === '+')) g.push(c.next());
          if (g[0] && g[0].t === 'word' && c.isPunct('(')) { var fa = c.group(); g.push({ t: 'punct', v: '(' }); g = g.concat(fa); g.push({ t: 'punct', v: ')' }); }
          col.defaultValue = tokValue(g.filter(Boolean));
        }
      }
      else if (u === 'AUTO_INCREMENT') { c.next(); col.autoIncrement = true; }
      else if (u === 'UNIQUE') { c.next(); col.unique = true; c.acceptOneOf(['KEY', 'INDEX']); }
      else if (u === 'PRIMARY') { c.next(); c.acceptWord('KEY'); col.primary = true; col.nullable = false; }
      else if (u === 'KEY') { c.next(); col.primary = true; col.nullable = false; }
      else if (u === 'COMMENT') { c.next(); var ct = c.next(); col.comment = ct && ct.t === 'str' ? unquote(ct.v) : ''; }
      else if (u === 'UNSIGNED') { c.next(); col.unsigned = true; }
      else if (u === 'SIGNED' || u === 'ZEROFILL' || u === 'BINARY' || u === 'ASCII' || u === 'UNICODE' ||
        u === 'INVISIBLE' || u === 'VISIBLE' || u === 'VIRTUAL' || u === 'STORED' || u === 'PERSISTENT') { c.next(); }
      else if (u === 'CHARACTER' && c.isWord('SET', 1)) { c.i += 2; c.acceptOp('='); c.ident(); }
      else if (u === 'CHARSET' || u === 'COLLATE' || u === 'COLUMN_FORMAT' || u === 'STORAGE' || u === 'SRID') { c.next(); c.acceptOp('='); c.ident(); }
      else if (u === 'ON' && c.isWord('UPDATE', 1)) {
        c.i += 2; var ou = c.next(); var s = ou ? ou.v : '';
        if (c.isPunct('(')) { s += '(' + joinToks(c.group()) + ')'; }
        col.onUpdate = s;
      }
      else if (u === 'CONSTRAINT') { c.next(); if (!c.isWord('CHECK')) c.ident(); }
      else if (u === 'CHECK') { c.next(); var cg = c.group(); if (cg) col.checks.push(joinToks(cg)); }
      else if (u === 'REFERENCES') {
        c.next(); var rt = c.qname(); var rc = c.isPunct('(') ? identList(c.group()) : [];
        col.inlineRef = { refTable: rt, refColumns: rc };
        readRefActions(c, col.inlineRef);
      }
      else if (u === 'GENERATED' || u === 'AS') {
        if (u === 'GENERATED') { c.next(); c.acceptWord('ALWAYS'); }
        if (c.acceptWord('AS')) { var gg = c.group(); col.generated = gg ? joinToks(gg) : ''; }
      }
      else c.next();
    }
    return col;
  }

  function readRefActions(c, fk) {
    while (!c.eof()) {
      if (c.isWord('ON') && (c.isWord('DELETE', 1) || c.isWord('UPDATE', 1))) {
        var which = c.peek(1).v.toUpperCase(); c.i += 2;
        var act;
        if (c.acceptWord('SET', 'NULL')) act = 'SET NULL';
        else if (c.acceptWord('SET', 'DEFAULT')) act = 'SET DEFAULT';
        else if (c.acceptWord('NO', 'ACTION')) act = 'NO ACTION';
        else { var w = c.next(); act = w ? w.v.toUpperCase() : ''; }
        if (which === 'DELETE') fk.onDelete = act; else fk.onUpdate = act;
      } else if (c.isWord('MATCH')) { c.i += 2; }
      else break;
    }
  }

  function readIndexCols(c) {
    // skip optional name / USING btree before the column group
    var name = null;
    if (!c.isPunct('(') && !c.isWord('USING')) name = c.ident();
    if (c.acceptWord('USING')) c.next();
    var cols = c.isPunct('(') ? identList(c.group()) : [];
    return { name: name, columns: cols };
  }

  /** Parse a table-level definition (or column definition). */
  function parseDef(toks) {
    var c = new Cur(toks);
    var cname = null;
    if (c.isWord('CONSTRAINT')) {
      c.next();
      if (!c.isWord('PRIMARY') && !c.isWord('UNIQUE') && !c.isWord('FOREIGN') && !c.isWord('CHECK')) cname = c.ident();
    }
    if (c.isWord('PRIMARY')) {
      c.next(); c.acceptWord('KEY');
      var pk = readIndexCols(c);
      return { kind: 'primary', columns: pk.columns, name: cname };
    }
    if (c.isWord('UNIQUE')) {
      c.next(); c.acceptOneOf(['KEY', 'INDEX']);
      var uq = readIndexCols(c);
      return { kind: 'unique', name: cname || uq.name, columns: uq.columns };
    }
    if (c.isWord('FULLTEXT') || c.isWord('SPATIAL')) {
      var kind = c.next().v.toLowerCase(); c.acceptOneOf(['KEY', 'INDEX']);
      var ft = readIndexCols(c);
      return { kind: 'index', type: kind, name: ft.name, columns: ft.columns };
    }
    if (c.isWord('KEY') || c.isWord('INDEX')) {
      c.next();
      var ix = readIndexCols(c);
      return { kind: 'index', name: ix.name, columns: ix.columns };
    }
    if (c.isWord('FOREIGN')) {
      c.next(); c.acceptWord('KEY');
      var idxName = null;
      if (!c.isPunct('(')) idxName = c.ident();
      var cols = c.isPunct('(') ? identList(c.group()) : [];
      var fk = { kind: 'foreign', name: cname || idxName, columns: cols, refTable: null, refColumns: [], onDelete: '', onUpdate: '' };
      if (c.acceptWord('REFERENCES')) {
        fk.refTable = c.qname();
        fk.refColumns = c.isPunct('(') ? identList(c.group()) : [];
        readRefActions(c, fk);
      }
      return fk;
    }
    if (c.isWord('CHECK')) {
      c.next(); var g = c.group();
      return { kind: 'check', name: cname, expr: g ? joinToks(g) : '' };
    }
    if (c.isWord('PERIOD')) return { kind: 'other' };
    return { kind: 'column', column: parseColumn(toks) };
  }

  // -------------------------------------------------------------- schema
  function newTable(name, line) {
    return {
      name: name, line: line, columns: [], primaryKey: [], uniques: [], indexes: [], foreignKeys: [], checks: [],
      options: {}, rows: [], insertColumns: null, insertStatements: 0, isViewStub: false
    };
  }

  function applyDef(tbl, def, res, line) {
    switch (def.kind) {
      case 'column': {
        var col = def.column;
        var existing = findCol(tbl, col.name);
        if (existing >= 0) tbl.columns[existing] = col; else tbl.columns.push(col);
        if (col.primary && tbl.primaryKey.indexOf(col.name) < 0) tbl.primaryKey = [col.name];
        if (col.unique) tbl.uniques.push({ name: col.name, columns: [col.name], inline: true });
        col.checks.forEach(function (x) { tbl.checks.push({ name: null, expr: x, column: col.name }); });
        if (col.inlineRef) {
          res.notes.push({ line: line, table: tbl.name, column: col.name, kind: 'inlineRef' });
          tbl.foreignKeys.push({
            name: null, columns: [col.name], refTable: col.inlineRef.refTable, refColumns: col.inlineRef.refColumns,
            onDelete: col.inlineRef.onDelete || '', onUpdate: col.inlineRef.onUpdate || '', inline: true
          });
        }
        break;
      }
      case 'primary': tbl.primaryKey = def.columns.slice(); break;
      case 'unique': tbl.uniques.push({ name: def.name, columns: def.columns }); break;
      case 'index': tbl.indexes.push({ name: def.name, columns: def.columns, type: def.type || '' }); break;
      case 'foreign':
        tbl.foreignKeys.push({ name: def.name, columns: def.columns, refTable: def.refTable, refColumns: def.refColumns, onDelete: def.onDelete, onUpdate: def.onUpdate });
        break;
      case 'check': tbl.checks.push({ name: def.name, expr: def.expr }); break;
    }
  }

  function findCol(tbl, name) {
    if (!name) return -1;
    var l = name.toLowerCase();
    for (var k = 0; k < tbl.columns.length; k++) if ((tbl.columns[k].name || '').toLowerCase() === l) return k;
    return -1;
  }

  function readTableOptions(c, tbl) {
    while (!c.eof()) {
      var tk = c.peek();
      if (tk.t !== 'word') { c.next(); continue; }
      var u = tk.v.toUpperCase();
      if (u === 'DEFAULT') { c.next(); continue; }
      if (u === 'ENGINE' || u === 'TYPE') { c.next(); c.acceptOp('='); tbl.options.engine = c.ident(); continue; }
      if (u === 'CHARSET' || (u === 'CHARACTER' && c.isWord('SET', 1))) {
        c.i += u === 'CHARSET' ? 1 : 2; c.acceptOp('='); tbl.options.charset = c.ident(); continue;
      }
      if (u === 'COLLATE') { c.next(); c.acceptOp('='); tbl.options.collate = c.ident(); continue; }
      if (u === 'AUTO_INCREMENT') { c.next(); c.acceptOp('='); var n = c.next(); tbl.options.autoIncrement = n ? n.v : ''; continue; }
      if (u === 'COMMENT') { c.next(); c.acceptOp('='); var s = c.next(); tbl.options.comment = s && s.t === 'str' ? unquote(s.v) : ''; continue; }
      if (u === 'AS' || u === 'SELECT' || u === 'LIKE') { tbl.options.derived = u; c.rest(); break; }
      c.next();
    }
  }

  function parse(text) {
    var res = {
      databases: [], tables: [], views: [], routines: [], statements: [], errors: [], notes: [],
      createsDatabase: false, usesDatabase: null
    };
    var byName = {};
    function getTable(name, line, create) {
      var key = (name || '').toLowerCase();
      if (byName[key]) return byName[key];
      if (!create) return null;
      var t = newTable(name, line);
      byName[key] = t; res.tables.push(t);
      return t;
    }
    function dropTable(name) {
      var key = (name || '').toLowerCase();
      var t = byName[key];
      if (!t) return;
      delete byName[key];
      res.tables.splice(res.tables.indexOf(t), 1);
    }

    var stmts = splitStatements(text);
    stmts.forEach(function (st) {
      var c = new Cur(st.toks);
      var rec = { kind: 'other', name: null, line: st.line, endLine: st.endLine, start: st.start, end: st.end, verb: (c.peek() && c.peek().v || '').toUpperCase() };
      res.statements.push(rec);
      try {
        if (c.isWord('CREATE')) {
          c.next();
          c.acceptWord('OR', 'REPLACE');
          // view / routine prefixes
          var pre = true;
          while (pre) {
            pre = false;
            if (c.isWord('ALGORITHM') || c.isWord('SQL') && c.isWord('SECURITY', 1)) {
              if (c.isWord('SQL')) c.i += 2; else { c.next(); c.acceptOp('='); }
              c.next(); pre = true;
            } else if (c.isWord('DEFINER')) {
              c.next(); c.acceptOp('=');
              // user@host in many shapes: `root`@`localhost`, root@localhost, CURRENT_USER
              while (!c.eof() && !c.isWord('VIEW') && !c.isWord('TRIGGER') && !c.isWord('PROCEDURE') &&
                !c.isWord('FUNCTION') && !c.isWord('EVENT') && !c.isWord('SQL') && !c.isWord('ALGORITHM')) c.next();
              pre = true;
            } else if (c.isWord('TEMPORARY') || c.isWord('UNIQUE') || c.isWord('FULLTEXT') || c.isWord('SPATIAL') ||
              c.isWord('AGGREGATE')) { c.next(); pre = true; }
          }
          if (c.isWord('DATABASE') || c.isWord('SCHEMA')) {
            c.next(); c.acceptWord('IF', 'NOT', 'EXISTS');
            var dbn = c.ident();
            res.databases.push(dbn); res.createsDatabase = true;
            rec.kind = 'database'; rec.name = dbn;
          } else if (c.isWord('TABLE')) {
            c.next(); c.acceptWord('IF', 'NOT', 'EXISTS');
            var tname = c.qname();
            rec.kind = 'table'; rec.name = tname;
            var existing = getTable(tname, st.line, false);
            if (existing) dropTable(tname); // re-created
            var tbl = getTable(tname, st.line, true);
            tbl.line = st.line;
            if (c.isPunct('(')) {
              var defs = splitCommas(c.group());
              defs.forEach(function (d) { if (d.length) applyDef(tbl, parseDef(d), res, st.line); });
            }
            readTableOptions(c, tbl);
          } else if (c.isWord('VIEW')) {
            c.next();
            var vname = c.qname();
            rec.kind = 'view'; rec.name = vname;
            var asIdx = -1;
            for (var k = c.i; k < st.toks.length; k++) if (st.toks[k].t === 'word' && st.toks[k].v.toUpperCase() === 'AS') { asIdx = k; break; }
            var body = asIdx >= 0 ? text.slice(st.toks[asIdx + 1] ? st.toks[asIdx + 1].start : st.end, st.end) : '';
            var stub = getTable(vname, st.line, false);
            if (stub) dropTable(vname);
            res.views = res.views.filter(function (v) { return v.name.toLowerCase() !== (vname || '').toLowerCase(); });
            res.views.push({ name: vname, line: st.line, sql: body.trim() });
          } else if (c.isWord('TRIGGER') || c.isWord('PROCEDURE') || c.isWord('FUNCTION') || c.isWord('EVENT')) {
            var kindR = c.next().v.toLowerCase();
            c.acceptWord('IF', 'NOT', 'EXISTS');
            var rname = c.qname();
            rec.kind = 'routine'; rec.name = rname;
            res.routines.push({ kind: kindR, name: rname, line: st.line });
          } else if (c.isWord('INDEX')) {
            c.next(); var iname = c.ident(); c.acceptWord('ON'); var it = c.qname();
            rec.kind = 'alter'; rec.name = it;
            var itbl = getTable(it, st.line, false);
            var icols = c.isPunct('(') ? identList(c.group()) : [];
            if (itbl) {
              var isUnique = st.toks.slice(0, 3).some(function (x) { return x.t === 'word' && x.v.toUpperCase() === 'UNIQUE'; });
              if (isUnique) itbl.uniques.push({ name: iname, columns: icols });
              else itbl.indexes.push({ name: iname, columns: icols });
            }
          } else if (c.isWord('USER') || c.isWord('ROLE')) {
            rec.kind = 'user';
          }
        } else if (c.isWord('ALTER') && (c.isWord('TABLE', 1) || c.isWord('IGNORE', 1) || c.isWord('ONLINE', 1))) {
          c.next(); c.acceptOneOf(['ONLINE', 'IGNORE']); c.acceptWord('TABLE');
          var aname = c.qname();
          rec.kind = 'alter'; rec.name = aname;
          var atbl = getTable(aname, st.line, false);
          if (!atbl) { atbl = getTable(aname, st.line, true); atbl.missingCreate = true; }
          splitCommas(c.rest()).forEach(function (act) { applyAlter(atbl, act, res, st.line, function (newName) { renameTable(atbl, newName); }); });
        } else if (c.isWord('INSERT') || c.isWord('REPLACE')) {
          c.next();
          c.acceptOneOf(['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY']);
          c.acceptWord('IGNORE');
          c.acceptWord('INTO');
          var iname2 = c.qname();
          rec.kind = 'insert'; rec.name = iname2; rec.rows = 0;
          var t2 = getTable(iname2, st.line, false);
          if (!t2) { t2 = getTable(iname2, st.line, true); t2.missingCreate = true; }
          t2.insertStatements++;
          var cols2 = null;
          if (c.isPunct('(') && !(c.peek(1) && c.peek(1).t === 'word' && c.peek(1).v.toUpperCase() === 'SELECT')) cols2 = identList(c.group());
          if (c.acceptOneOf(['VALUES', 'VALUE'])) {
            var count = 0;
            while (c.isPunct('(')) {
              var tuple = splitCommas(c.group()).map(tokValue);
              addRow(t2, cols2, tuple);
              count++;
              if (!c.acceptPunct(',')) break;
            }
            rec.rows = count;
          } else if (c.isWord('SET')) {
            c.next();
            var setCols = [], setVals = [];
            splitCommas(c.rest()).forEach(function (p) {
              var pc = new Cur(p); var nm = pc.ident(); pc.acceptOp('='); setCols.push(nm); setVals.push(tokValue(pc.rest()));
            });
            addRow(t2, setCols, setVals); rec.rows = 1;
          } else {
            rec.rows = null; rec.fromSelect = true;
            res.notes.push({ line: st.line, table: iname2, kind: 'insertSelect' });
          }
        } else if (c.isWord('DROP')) {
          c.next(); c.acceptWord('TEMPORARY');
          if (c.isWord('TABLE') || c.isWord('VIEW')) {
            var isView = c.next().v.toUpperCase() === 'VIEW';
            c.acceptWord('IF', 'EXISTS');
            rec.kind = 'drop';
            splitCommas(c.rest()).forEach(function (p) {
              var pc = new Cur(p); var dn = pc.qname();
              if (!rec.name) rec.name = dn;
              if (isView) res.views = res.views.filter(function (v) { return v.name.toLowerCase() !== (dn || '').toLowerCase(); });
              else dropTable(dn);
            });
          } else if (c.isWord('DATABASE') || c.isWord('SCHEMA')) {
            rec.kind = 'dropdb';
          }
        } else if (c.isWord('USE')) {
          c.next(); res.usesDatabase = c.ident(); rec.kind = 'use'; rec.name = res.usesDatabase;
        } else if (c.isWord('SET') || c.isWord('START') || c.isWord('COMMIT') || c.isWord('LOCK') || c.isWord('UNLOCK') ||
          c.isWord('BEGIN') || c.isWord('ROLLBACK')) {
          rec.kind = 'session';
        } else if (c.isWord('ALTER') && (c.isWord('DATABASE', 1) || c.isWord('SCHEMA', 1))) {
          rec.kind = 'session';
        } else if (c.isWord('SELECT') || c.isWord('UPDATE') || c.isWord('DELETE') || c.isWord('TRUNCATE') || c.isWord('GRANT') || c.isWord('FLUSH')) {
          rec.kind = 'dml';
          if (c.isWord('UPDATE') || c.isWord('DELETE') || c.isWord('TRUNCATE')) res.notes.push({ line: st.line, kind: 'dml', verb: rec.verb });
        } else {
          rec.kind = 'unknown';
          res.errors.push({ line: st.line, message: 'Unrecognised statement: ' + joinToks(st.toks.slice(0, 8)).slice(0, 120) });
        }
      } catch (err) {
        res.errors.push({ line: st.line, message: 'Parser error: ' + (err && err.message || err) });
      }
    });

    function renameTable(tbl, newName) {
      delete byName[tbl.name.toLowerCase()];
      tbl.name = newName;
      byName[newName.toLowerCase()] = tbl;
    }

    finish(res);
    return res;
  }

  function addRow(tbl, cols, values) {
    if (!tbl.columns.length && cols) {
      // insert into an unknown table: synthesise columns
      cols.forEach(function (n) { tbl.columns.push({ name: n, type: '?', baseType: '?', typeArgs: [], nullable: true, checks: [] }); });
    }
    var row = new Array(Math.max(tbl.columns.length, values.length));
    if (cols) {
      for (var k = 0; k < cols.length; k++) {
        var ix = findCol(tbl, cols[k]);
        if (ix < 0) { tbl.columns.push({ name: cols[k], type: '?', baseType: '?', typeArgs: [], nullable: true, checks: [], unknown: true }); ix = tbl.columns.length - 1; }
        row[ix] = values[k];
      }
    } else {
      for (var m = 0; m < values.length; m++) row[m] = values[m];
      if (values.length !== tbl.columns.length) tbl.columnCountMismatch = (tbl.columnCountMismatch || 0) + 1;
    }
    // simulate AUTO_INCREMENT for omitted / NULL ids so FK checks on sample data work
    tbl.columns.forEach(function (col, ci) {
      if (!col.autoIncrement) return;
      if (tbl.aiNext === undefined) tbl.aiNext = 1;
      var v = row[ci];
      if (v === undefined || v === null) {
        row[ci] = tbl.aiNext++;
        (tbl.autoCells || (tbl.autoCells = new Set())).add(tbl.rows.length + ':' + ci);
      } else if (typeof v === 'number' && v >= tbl.aiNext) tbl.aiNext = v + 1;
    });
    tbl.rows.push(row);
  }

  function applyAlter(tbl, act, res, line, rename) {
    var c = new Cur(act);
    if (c.isWord('ADD')) {
      c.next();
      if (c.isWord('COLUMN')) { c.next(); c.acceptWord('IF', 'NOT', 'EXISTS'); }
      if (c.isPunct('(')) {
        splitCommas(c.group()).forEach(function (d) { applyDef(tbl, parseDef(d), res, line); });
        return;
      }
      if (c.isWord('IF')) c.acceptWord('IF', 'NOT', 'EXISTS');
      applyDef(tbl, parseDef(act.slice(c.i)), res, line);
      return;
    }
    if (c.isWord('MODIFY') || c.isWord('CHANGE')) {
      var verb = c.next().v.toUpperCase();
      c.acceptWord('COLUMN'); c.acceptWord('IF', 'EXISTS');
      var oldName = null;
      if (verb === 'CHANGE') oldName = c.ident();
      var col = parseColumn(act.slice(c.i));
      var ix = findCol(tbl, oldName || col.name);
      if (ix >= 0) {
        var prev = tbl.columns[ix];
        tbl.columns[ix] = col;
        if (oldName && oldName !== col.name) {
          tbl.primaryKey = tbl.primaryKey.map(function (n) { return n.toLowerCase() === oldName.toLowerCase() ? col.name : n; });
        }
        void prev;
      } else tbl.columns.push(col);
      if (col.primary) tbl.primaryKey = [col.name];
      if (col.unique) tbl.uniques.push({ name: col.name, columns: [col.name], inline: true });
      return;
    }
    if (c.isWord('DROP')) {
      c.next();
      if (c.acceptWord('PRIMARY', 'KEY')) { tbl.primaryKey = []; return; }
      if (c.acceptWord('FOREIGN', 'KEY')) {
        var fkn = c.ident();
        tbl.foreignKeys = tbl.foreignKeys.filter(function (f) { return (f.name || '').toLowerCase() !== (fkn || '').toLowerCase(); });
        return;
      }
      if (c.acceptOneOf(['INDEX', 'KEY'])) {
        var ixn = (c.ident() || '').toLowerCase();
        tbl.indexes = tbl.indexes.filter(function (x) { return (x.name || '').toLowerCase() !== ixn; });
        tbl.uniques = tbl.uniques.filter(function (x) { return (x.name || '').toLowerCase() !== ixn; });
        return;
      }
      if (c.acceptOneOf(['CONSTRAINT', 'CHECK'])) {
        var cn = (c.ident() || '').toLowerCase();
        tbl.checks = tbl.checks.filter(function (x) { return (x.name || '').toLowerCase() !== cn; });
        tbl.foreignKeys = tbl.foreignKeys.filter(function (x) { return (x.name || '').toLowerCase() !== cn; });
        tbl.uniques = tbl.uniques.filter(function (x) { return (x.name || '').toLowerCase() !== cn; });
        return;
      }
      c.acceptWord('COLUMN');
      var dn = c.ident(); var di = findCol(tbl, dn);
      if (di >= 0) tbl.columns.splice(di, 1);
      return;
    }
    if (c.isWord('RENAME')) {
      c.next();
      if (c.isWord('COLUMN')) {
        c.next(); var from = c.ident(); c.acceptWord('TO'); var to = c.ident();
        var ri = findCol(tbl, from); if (ri >= 0) tbl.columns[ri].name = to;
        return;
      }
      if (c.isWord('INDEX') || c.isWord('KEY')) return;
      c.acceptOneOf(['TO', 'AS']);
      var nn = c.qname(); if (nn) rename(nn);
      return;
    }
    if (c.isWord('AUTO_INCREMENT') || c.isWord('ENGINE') || c.isWord('DEFAULT') || c.isWord('CHARACTER') ||
      c.isWord('CHARSET') || c.isWord('COLLATE') || c.isWord('COMMENT')) {
      readTableOptions(c, tbl);
    }
  }

  // ------------------------------------------------------------- finish
  function normType(col) {
    if (!col) return '';
    var b = (col.baseType || '').toLowerCase();
    if (b === 'integer') b = 'int';
    if (b === 'bool' || b === 'boolean') b = 'tinyint';
    var args = (col.typeArgs || []).join(',');
    var intLike = /int$/.test(b);
    return b + (intLike ? '' : (args ? '(' + args + ')' : '')) + (col.unsigned ? ' unsigned' : '');
  }

  function finish(res) {
    var byName = {};
    res.tables.forEach(function (t) { byName[t.name.toLowerCase()] = t; });
    res.tables.forEach(function (t) {
      var pk = t.primaryKey.map(function (n) { return n.toLowerCase(); });
      t.columns.forEach(function (col) {
        var l = (col.name || '').toLowerCase();
        col.isPK = pk.indexOf(l) >= 0;
        if (col.isPK) col.nullable = false;
        col.fks = t.foreignKeys.filter(function (f) { return f.columns.some(function (x) { return x.toLowerCase() === l; }); })
          .map(function (f) {
            var pos = f.columns.map(function (x) { return x.toLowerCase(); }).indexOf(l);
            return { refTable: f.refTable, refColumn: f.refColumns[pos] || f.refColumns[0] || null, name: f.name };
          });
        col.isUnique = col.unique || t.uniques.some(function (u) { return u.columns.length === 1 && u.columns[0].toLowerCase() === l; });
        col.inCompositeUnique = t.uniques.some(function (u) { return u.columns.length > 1 && u.columns.some(function (x) { return x.toLowerCase() === l; }); });
      });
      t.foreignKeys.forEach(function (f) {
        var rt = byName[(f.refTable || '').toLowerCase()];
        f.resolved = !!rt;
        f.refTableName = rt ? rt.name : f.refTable;
      });
    });
    res.byName = byName;
  }

  // ------------------------------------------------------------ analysis
  var ENTITY_PATTERNS = [
    { key: 'users', label: 'Users', de: 'Benutzer', re: /^(users?|benutzer|nutzer|customers?|kunden?|accounts?|members?|clients?)$/, loose: /user|benutzer|kunde|customer|client/, not: /type|role|status|log|attempt|reset|token|notif|ticket|favo|bookmark/ },
    { key: 'stations', label: 'Charging stations', de: 'Ladestationen', re: /^(charging_?)?stations?$|^powerstations?$|^ladestation(en)?$|^chargers?$/, loose: /station|charger|lade/, not: /status|maint|review/ },
    { key: 'ports', label: 'Ports', de: 'Ports', re: /^(charging_?)?ports?$|^steckdosen?$|^sockets?$|^outlets?$/, loose: /port|socket|outlet|steck/, not: /activ|order|status|reserv|report|support|transport|issue/ },
    { key: 'locations', label: 'Locations', de: 'Standorte', re: /^locations?$|^standorte?$|^sites?$|^places?$|^venues?$/, loose: /location|standort|site|place|venue|address/, not: /type|favo|bookmark|opening/ },
    { key: 'activations', label: 'Port activations', de: 'Port-Aktivierungen', re: /^(port_?)?activations?$|^(charging_?)?sessions?$|^charging_?process(es)?$|^portorders?$|^aktivierung(en)?$|^ladevorg(a|ä)nge?$/, loose: /activ|aktiv|session|process|portorder|ladevorgang|usage|charging(?!station)/, not: /status|log|reset/ }
  ];

  function normName(n) {
    return (n || '').toLowerCase().replace(/^tbl_?/, '').replace(/^t_/, '').replace(/[\s_-]+/g, '');
  }

  function detectEntities(names) {
    return ENTITY_PATTERNS.map(function (p) {
      var exact = names.filter(function (n) { return p.re.test(normName(n)); });
      var loose = exact.length ? [] : names.filter(function (n) { var x = normName(n); return p.loose.test(x) && !p.not.test(x); });
      return { key: p.key, label: p.label, de: p.de, matches: exact.length ? exact : loose, exact: exact.length > 0 };
    });
  }

  function analyze(res) {
    var hints = [];
    function add(level, text, table, extra) { hints.push(Object.assign({ level: level, text: text, table: table || null }, extra || {})); }
    var stats = { tables: res.tables.length, columns: 0, fks: 0, rows: 0, views: res.views.length, routines: res.routines.length, checks: 0, uniques: 0 };
    res.tables.forEach(function (t) {
      stats.columns += t.columns.length; stats.fks += t.foreignKeys.length; stats.rows += t.rows.length;
      stats.checks += t.checks.length; stats.uniques += t.uniques.length;
    });

    if (!res.tables.length) add('error', 'No CREATE TABLE statements found.');
    if (!res.createsDatabase) add('info', 'No CREATE DATABASE statement: a database must be selected before importing.');
    if (stats.rows === 0 && res.tables.length) add('error', 'No sample data: the dump contains no INSERT rows.');

    var empty = res.tables.filter(function (t) { return !t.rows.length; }).map(function (t) { return t.name; });
    if (stats.rows > 0 && empty.length) add('info', 'Tables without sample data: ' + empty.join(', '));

    res.tables.forEach(function (t) {
      if (t.missingCreate) add('warn', 'Table `' + t.name + '` is used but never created.', t.name);
      if (!t.primaryKey.length) add('warn', 'No primary key.', t.name);
      var eng = (t.options.engine || '').toLowerCase();
      if (eng && eng !== 'innodb') add('warn', 'Engine ' + t.options.engine + ': foreign keys are not enforced.', t.name);
      if (t.columnCountMismatch) add('warn', t.columnCountMismatch + ' INSERT row(s) have a different number of values than the table has columns.', t.name);

      t.columns.forEach(function (col) {
        var n = (col.name || '');
        if (/^(pk)?fk_/i.test(n) && !col.fks.length) add('warn', 'Column `' + n + '` looks like a foreign key but has no FOREIGN KEY constraint.', t.name);
        if (col.autoIncrement && !col.isPK && !col.isUnique) add('warn', 'AUTO_INCREMENT on `' + n + '`, which is not a key.', t.name);
      });

      t.foreignKeys.forEach(function (f) {
        var label = '`' + f.columns.join('`, `') + '` → `' + (f.refTable || '?') + '`';
        if (f.inline) add('warn', 'Inline REFERENCES on ' + label + ' is ignored by MySQL (no real foreign key is created).', t.name);
        var rt = res.byName[(f.refTable || '').toLowerCase()];
        if (!rt) { add('error', 'Foreign key ' + label + ' references a table that does not exist.', t.name); return; }
        f.columns.forEach(function (cn, k) {
          var src = t.columns[findCol(t, cn)];
          var dstName = f.refColumns[k];
          var dst = rt.columns[findCol(rt, dstName)];
          if (!src) { add('error', 'Foreign key column `' + cn + '` does not exist.', t.name); return; }
          if (!dst) { add('error', 'Foreign key target `' + rt.name + '.' + dstName + '` does not exist.', t.name); return; }
          if (!dst.isPK && !dst.isUnique && !dst.inCompositeUnique) add('warn', 'Foreign key `' + cn + '` references `' + rt.name + '.' + dstName + '`, which is neither primary key nor unique.', t.name);
          if (normType(src) !== normType(dst)) add('warn', 'Type mismatch: `' + cn + '` is ' + (src.type || '?') + ' but `' + rt.name + '.' + dstName + '` is ' + (dst.type || '?') + '.', t.name);
        });
        // orphan check on sample data (single-column FKs)
        if (f.columns.length === 1 && t.rows.length && rt.rows.length) {
          var si = findCol(t, f.columns[0]), di = findCol(rt, f.refColumns[0]);
          if (si >= 0 && di >= 0) {
            var have = new Set(rt.rows.map(function (r) { return valueKey(r[di]); }));
            var orphans = [];
            t.rows.forEach(function (r, ri) {
              var v = r[si];
              if (v === null || v === undefined) return;
              if (!have.has(valueKey(v))) orphans.push({ row: ri, value: v });
            });
            if (orphans.length) {
              add('error', orphans.length + ' row(s) have `' + f.columns[0] + '` values with no matching `' + rt.name + '.' + f.refColumns[0] + '` (e.g. ' +
                orphans.slice(0, 5).map(function (o) { return valueToString(o.value); }).join(', ') + ').', t.name, { orphanRows: orphans.map(function (o) { return o.row; }), column: f.columns[0] });
            }
          }
        }
      });

      // data checks
      if (t.rows.length) {
        if (t.primaryKey.length) {
          var idx = t.primaryKey.map(function (n) { return findCol(t, n); });
          if (idx.every(function (x) { return x >= 0; })) {
            var seen = new Set(), dups = 0;
            t.rows.forEach(function (r) {
              var k = idx.map(function (x) { return valueKey(r[x]); }).join('\u0001');
              if (idx.some(function (x) { return r[x] === undefined; })) return; // auto value
              if (seen.has(k)) dups++; else seen.add(k);
            });
            if (dups) add('error', dups + ' duplicate primary key value(s) in sample data.', t.name);
          }
        }
        t.columns.forEach(function (col, ci) {
          if (col.nullable || col.autoIncrement) return;
          var nulls = t.rows.filter(function (r) { return r[ci] === null; }).length;
          if (nulls) add('error', nulls + ' row(s) insert NULL into NOT NULL column `' + col.name + '`.', t.name);
        });
        t.uniques.forEach(function (u) {
          var idx2 = u.columns.map(function (n) { return findCol(t, n); });
          if (idx2.some(function (x) { return x < 0; })) return;
          var seen2 = new Set(), d2 = 0;
          t.rows.forEach(function (r) {
            if (idx2.some(function (x) { return r[x] === null || r[x] === undefined; })) return;
            var k2 = idx2.map(function (x) { return valueKey(r[x]); }).join('\u0001');
            if (seen2.has(k2)) d2++; else seen2.add(k2);
          });
          if (d2) add('error', d2 + ' duplicate value(s) for UNIQUE (' + u.columns.join(', ') + ').', t.name);
        });
      }
    });

    res.notes.forEach(function (n) {
      if (n.kind === 'insertSelect') add('info', 'INSERT … SELECT at line ' + n.line + ' (rows not counted).', n.table);
      if (n.kind === 'dml') add('info', n.verb + ' statement at line ' + n.line + '.');
    });
    res.errors.forEach(function (e) { add('warn', 'Line ' + e.line + ': ' + e.message); });

    // naming hints (based on the pk_/fk_ convention used in the model solution)
    var naming = [];
    res.tables.forEach(function (t) {
      t.primaryKey.forEach(function (p) { if (!/^pk(fk)?_/i.test(p)) naming.push('`' + t.name + '.' + p + '` (PK without pk_ prefix)'); });
      t.foreignKeys.forEach(function (f) { f.columns.forEach(function (cn) { if (!/^(pk)?fk_/i.test(cn)) naming.push('`' + t.name + '.' + cn + '` (FK without fk_ prefix)'); }); });
    });
    if (naming.length) add('naming', 'Naming: ' + naming.join(', '));

    return { hints: hints, stats: stats, entities: detectEntities(res.tables.map(function (t) { return t.name; })) };
  }

  function valueKey(v) {
    if (v === null || v === undefined) return '\u0000null';
    if (typeof v === 'object') return 'e:' + v.expr;
    var s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s)) return 'n:' + Number(s);
    return 's:' + s.toLowerCase().replace(/\s+$/, ''); // MySQL default collations are case-insensitive, pad-space
  }

  var api = {
    lex: lex, unquote: unquote, splitStatements: splitStatements, parse: parse, analyze: analyze,
    valueToString: valueToString, detectEntities: detectEntities, normName: normName, normType: normType
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SqlParse = api;
})(typeof window !== 'undefined' ? window : this);
