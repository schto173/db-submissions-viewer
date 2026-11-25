/*
 * Modelizer (modelizer.lu) model loader + SVG renderer.
 * Supports the v1 (.mdlz) and v2 (.json) export formats. Renders the three
 * views: conceptual (MCD), logical (MLD) and physical (EMLD), with pan & zoom.
 * Also recognises draw.io style JSON ("pages"/"cells") and shows it as an outline.
 */
(function (root) {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var VIEWS = ['conceptual', 'logical', 'physical'];
  var FONT = '12px "Segoe UI", system-ui, -apple-system, sans-serif';
  var FONT_B = '600 13px "Segoe UI", system-ui, -apple-system, sans-serif';
  var FONT_S = '11px "Segoe UI", system-ui, -apple-system, sans-serif';

  // ----------------------------------------------------------------- load
  function load(json) {
    if (!json || typeof json !== 'object') return { kind: 'unknown' };
    if (Array.isArray(json.nodes)) return loadModelizer(json);
    if (Array.isArray(json.pages)) return loadDrawio(json);
    return { kind: 'unknown' };
  }

  function vis(obj, view) {
    return !(obj && obj.visibility && obj.visibility[view] === false);
  }

  function loadModelizer(json) {
    var m = { kind: 'modelizer', name: json.modelName || '', version: json.version, classes: [], notes: [], associations: [], associatives: [], relationships: [], byId: {} };
    json.nodes.forEach(function (n) {
      var d = n.data || {};
      var pos = {};
      VIEWS.forEach(function (v) {
        var p = d.viewPositions && d.viewPositions[v];
        pos[v] = p && isFinite(p.x) ? { x: +p.x, y: +p.y } : { x: +(n.position && n.position.x) || 0, y: +(n.position && n.position.y) || 0 };
      });
      if (n.type === 'note') {
        m.notes.push({ id: n.id, label: d.label || '', text: d.text || '', pos: pos, visibility: d.visibility || {} });
        return;
      }
      var c = {
        id: n.id, label: d.label || '(unnamed)', logicalName: d.logicalName || '', color: d.color || '#90a4ae',
        pos: pos, visibility: d.visibility || {},
        attributes: (d.attributes || []).map(function (a) {
          return {
            id: a.id, name: a.name || '', logicalName: a.logicalName || '', type: a.type || '', typeParams: a.typeParams || {},
            defaultValue: a.defaultValue == null ? '' : String(a.defaultValue), nullable: !!a.nullable, unique: !!a.unique,
            autoIncrement: !!a.autoIncrement, visibility: a.visibility || {}
          };
        })
      };
      m.classes.push(c); m.byId[c.id] = c;
    });
    (json.edges || []).forEach(function (e) {
      var d = e.data || {};
      var base = { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || '', targetHandle: e.targetHandle || '', lineStyle: d.lineStyle || 'orthogonal', controlPoints: d.controlPoints || [] };
      if (e.type === 'association') {
        m.associations.push(Object.assign(base, {
          name: d.name || '', multA: d.multiplicityA || '', multB: d.multiplicityB || '', roleA: d.roleA || '', roleB: d.roleB || '',
          comment: d.comment || '', parallelIndex: d.parallelIndex || 0, parallelCount: d.parallelCount || 1
        }));
      } else if (e.type === 'associativeAssociation') {
        m.associatives.push(Object.assign(base, { name: d.name || '' }));
      } else if (e.type === 'relationship') {
        m.relationships.push(base);
      }
    });
    return m;
  }

  function loadDrawio(json) {
    return {
      kind: 'drawio', version: json.version,
      pages: (json.pages || []).map(function (p) {
        var cells = p.cells || [];
        var byId = {};
        cells.forEach(function (c) { byId[c.id] = c; });
        var layers = cells.filter(function (c) { return c.type === 'layer'; }).map(function (c) { return c.id; });
        var tops = cells.filter(function (c) { return c.type === 'node' && layers.indexOf(c.parent) >= 0; });
        var labelOf = function (id) { var c = byId[id]; return c ? stripHtml(c.label || '') : '?'; };
        var ownerOf = function (id) { var c = byId[id]; if (!c) return null; return layers.indexOf(c.parent) >= 0 ? c : byId[c.parent] || c; };
        return {
          name: p.name || '',
          entities: tops.map(function (t) {
            return { label: stripHtml(t.label || ''), children: cells.filter(function (c) { return c.parent === t.id && c.type === 'node'; }).map(function (c) { return stripHtml(c.label || ''); }).filter(Boolean) };
          }),
          edges: cells.filter(function (c) { return c.type === 'edge'; }).map(function (e) {
            var s = ownerOf(e.source), t = ownerOf(e.target);
            return { label: stripHtml(e.label || ''), source: e.source ? labelOf(e.source) : '?', target: e.target ? labelOf(e.target) : '?', sourceOwner: s ? stripHtml(s.label || '') : '?', targetOwner: t ? stripHtml(t.label || '') : '?' };
          })
        };
      })
    };
  }

  function stripHtml(s) {
    return String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  }

  // ------------------------------------------------------- attr helpers
  function attrName(a, view) {
    return view === 'conceptual' ? a.name : (a.logicalName || a.name);
  }
  function className(c, view) {
    return view === 'conceptual' ? c.label : (c.logicalName || c.label);
  }
  function typeStr(a) {
    var t = a.type || '', p = a.typeParams || {};
    if (t === 'varchar(n)' || t === 'char(n)') return t.replace('(n)', '(' + (p.maxLength || 'n') + ')');
    if (t === 'decimal(p,s)') return 'decimal(' + (p.precision || 'p') + ',' + (p.scale || 's') + ')';
    if (t === 'enum(e)') return 'enum(' + (p.enumValues || 'e') + ')';
    return t;
  }
  function isPkName(n) { return /^pk/i.test(n || ''); }
  function isFkName(n) { return /^(pk)?fk/i.test(n || ''); }
  // Exactly the flags set in the model (like Modelizer's own EMLD export).
  function consStr(a) {
    var out = [];
    if (!a.nullable) out.push('NN');
    if (a.unique) out.push('UQ');
    if (a.autoIncrement) out.push('AI');
    return out.join(', ');
  }

  /** Tables/columns as they appear in the physical view (used for SQL comparison). */
  function toSchema(m) {
    if (!m || m.kind !== 'modelizer') return null;
    return m.classes.filter(function (c) { return vis(c, 'physical'); }).map(function (c) {
      return {
        name: className(c, 'physical'), conceptualName: c.label,
        columns: c.attributes.filter(function (a) { return vis(a, 'physical'); }).map(function (a) {
          return { name: attrName(a, 'physical'), type: typeStr(a), nullable: a.nullable, unique: a.unique, autoIncrement: a.autoIncrement, defaultValue: a.defaultValue };
        })
      };
    });
  }

  // --------------------------------------------------------- measuring
  var ctx = null;
  function measure(text, font) {
    if (!ctx) { var cv = document.createElement('canvas'); ctx = cv.getContext('2d'); }
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function el(name, attrs, parent) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    var t = el('text', Object.assign({ x: x, y: y }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }

  var HEAD = 30, ROW = 18, PADX = 10, PADB = 8;

  function layoutClass(c, view) {
    var title = className(c, view);
    var attrs = c.attributes.filter(function (a) { return vis(a, view); }).map(function (a) {
      var n = attrName(a, view);
      return {
        a: a, name: n + (view === 'physical' && a.defaultValue !== '' ? '*' : ''),
        type: view === 'physical' ? typeStr(a) : '', cons: view === 'physical' ? consStr(a) : '',
        pk: isPkName(n), fk: isFkName(n)
      };
    });
    var nameW = 0, typeW = 0, consW = 0;
    attrs.forEach(function (r) {
      nameW = Math.max(nameW, measure(r.name, FONT));
      if (view === 'physical') { typeW = Math.max(typeW, measure(r.type, FONT_S)); consW = Math.max(consW, measure(r.cons, FONT_S)); }
    });
    var inner = view === 'physical' ? nameW + (typeW ? 18 + typeW : 0) + (consW ? 18 + consW : 0) : nameW;
    var w = Math.ceil(Math.max(130, measure(title, FONT_B) + 2 * PADX + 4, inner + 2 * PADX));
    var h = HEAD + Math.max(attrs.length, 0) * ROW + (attrs.length ? PADB : 4);
    return { title: title, rows: attrs, w: w, h: h, nameW: nameW, typeW: typeW, consW: consW };
  }

  // ------------------------------------------------------------ routing
  var DIRS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

  function parseHandle(h) {
    // "right-source" | "left-<attrId>-target" | "association-target"
    h = h || '';
    var m = /^(left|right|top|bottom)(?:-(.*))?-(source|target)$/.exec(h);
    if (!m) return { side: null, attr: null };
    return { side: m[1], attr: m[2] || null };
  }

  function anchor(box, side, attrId, offset) {
    side = side || 'right';
    if (attrId && box.rowIndex[attrId] !== undefined && (side === 'left' || side === 'right')) {
      var ry = box.y + HEAD + box.rowIndex[attrId] * ROW + ROW / 2 + 1;
      return { x: side === 'left' ? box.x : box.x + box.w, y: ry, side: side };
    }
    offset = offset || 0;
    switch (side) {
      case 'left': return { x: box.x, y: box.y + box.h / 2 + offset, side: side };
      case 'top': return { x: box.x + box.w / 2 + offset, y: box.y, side: side };
      case 'bottom': return { x: box.x + box.w / 2 + offset, y: box.y + box.h, side: side };
      default: return { x: box.x + box.w, y: box.y + box.h / 2 + offset, side: 'right' };
    }
  }

  function route(p1, p2, style, cps) {
    var G = 18;
    if (cps && cps.length) return [p1].concat(cps.map(function (c) { return { x: +c.x, y: +c.y }; })).concat([p2]);
    if (style === 'straight') return [p1, p2];
    var d1 = DIRS[p1.side] || [1, 0], d2 = DIRS[p2.side] || [-1, 0];
    var q1 = { x: p1.x + d1[0] * G, y: p1.y + d1[1] * G }, q2 = { x: p2.x + d2[0] * G, y: p2.y + d2[1] * G };
    var h1 = d1[0] !== 0, h2 = d2[0] !== 0;
    var pts = [p1, q1];
    if (h1 && h2) {
      var x;
      if (d1[0] === d2[0]) x = d1[0] > 0 ? Math.max(q1.x, q2.x) : Math.min(q1.x, q2.x);
      else x = (q1.x + q2.x) / 2;
      pts.push({ x: x, y: q1.y }, { x: x, y: q2.y });
    } else if (!h1 && !h2) {
      var y;
      if (d1[1] === d2[1]) y = d1[1] > 0 ? Math.max(q1.y, q2.y) : Math.min(q1.y, q2.y);
      else y = (q1.y + q2.y) / 2;
      pts.push({ x: q1.x, y: y }, { x: q2.x, y: y });
    } else if (h1) {
      pts.push({ x: q2.x, y: q1.y });
    } else {
      pts.push({ x: q1.x, y: q2.y });
    }
    pts.push(q2, p2);
    // drop zero-length / collinear points
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var a = out[out.length - 1], b = pts[i];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) continue;
      if (out.length >= 2) {
        var z = out[out.length - 2];
        if ((Math.abs(z.x - a.x) < 0.5 && Math.abs(a.x - b.x) < 0.5) || (Math.abs(z.y - a.y) < 0.5 && Math.abs(a.y - b.y) < 0.5)) { out[out.length - 1] = b; continue; }
      }
      out.push(b);
    }
    return out;
  }

  function pathD(pts) {
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
  }

  function midpoint(pts) {
    var total = 0, segs = [];
    for (var i = 1; i < pts.length; i++) { var l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segs.push(l); total += l; }
    var half = total / 2;
    for (var j = 0; j < segs.length; j++) {
      if (half <= segs[j] || j === segs.length - 1) {
        var t = segs[j] ? half / segs[j] : 0;
        return { x: pts[j].x + (pts[j + 1].x - pts[j].x) * t, y: pts[j].y + (pts[j + 1].y - pts[j].y) * t, horizontal: Math.abs(pts[j + 1].y - pts[j].y) < 0.5 };
      }
      half -= segs[j];
    }
    return pts[0];
  }

  function endLabelPos(p, line) {
    // place near an endpoint, beside the first segment
    switch (p.side) {
      case 'left': return { x: p.x - 6, y: p.y - 5 - line * 12, anchor: 'end' };
      case 'top': return { x: p.x + 6, y: p.y - 6 - line * 12, anchor: 'start' };
      case 'bottom': return { x: p.x + 6, y: p.y + 14 + line * 12, anchor: 'start' };
      default: return { x: p.x + 6, y: p.y - 5 - line * 12, anchor: 'start' };
    }
  }

  // ------------------------------------------------------------- render
  function render(container, model, opts) {
    opts = opts || {};
    var view = opts.view || 'conceptual';
    container.innerHTML = '';
    container.classList.add('dg-wrap');
    var svg = el('svg', { class: 'dg-svg', width: '100%', height: '100%' }, container);
    var defs = el('defs', null, svg);
    var mk = el('marker', { id: 'dg-arrow-' + uid(), viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0 L10 5 L0 10 z', class: 'dg-arrowhead' }, mk);
    var arrowId = mk.getAttribute('id');
    var pat = el('pattern', { id: 'dg-grid-' + uid(), width: 20, height: 20, patternUnits: 'userSpaceOnUse' }, defs);
    el('circle', { cx: 1, cy: 1, r: 0.9, class: 'dg-dot' }, pat);
    var gridId = pat.getAttribute('id');
    var bg = el('rect', { x: -50000, y: -50000, width: 100000, height: 100000, fill: 'url(#' + gridId + ')', class: 'dg-bg' }, svg);
    var world = el('g', { class: 'dg-world' }, svg);
    var gEdges = el('g', { class: 'dg-edges' }, world);
    var gNodes = el('g', { class: 'dg-nodes' }, world);
    var gLabels = el('g', { class: 'dg-labels' }, world);

    var state = { tx: 0, ty: 0, k: 1 };
    function apply() { world.setAttribute('transform', 'translate(' + state.tx + ',' + state.ty + ') scale(' + state.k + ')'); bg.setAttribute('transform', world.getAttribute('transform')); if (opts.onTransform) opts.onTransform(state); }

    var boxes = {};
    var bounds = null;

    function draw() {
      gEdges.innerHTML = ''; gNodes.innerHTML = ''; gLabels.innerHTML = '';
      boxes = {};
      bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
      function grow(x, y, w, h) { bounds.x1 = Math.min(bounds.x1, x); bounds.y1 = Math.min(bounds.y1, y); bounds.x2 = Math.max(bounds.x2, x + w); bounds.y2 = Math.max(bounds.y2, y + h); }

      model.classes.forEach(function (c) {
        if (!vis(c, view)) return;
        var L = layoutClass(c, view);
        var p = c.pos[view];
        var box = { x: p.x, y: p.y, w: L.w, h: L.h, rowIndex: {}, cls: c, L: L };
        L.rows.forEach(function (r, i) { box.rowIndex[r.a.id] = i; });
        boxes[c.id] = box;
        grow(box.x, box.y, box.w, box.h);
        var g = el('g', { class: 'dg-class', 'data-id': c.id, transform: 'translate(' + box.x + ',' + box.y + ')' }, gNodes);
        box.g = g;
        el('rect', { x: 0, y: 0, width: L.w, height: L.h, rx: 5, class: 'dg-box' }, g);
        el('path', { d: 'M0 6 v-1 a5 5 0 0 1 5 -5 h' + (L.w - 10) + ' a5 5 0 0 1 5 5 v1 z', fill: c.color, class: 'dg-cap' }, g);
        text(g, PADX, 21, L.title, { class: 'dg-title' });
        if (L.rows.length) el('line', { x1: 0, x2: L.w, y1: HEAD - 2, y2: HEAD - 2, class: 'dg-sep' }, g);
        L.rows.forEach(function (r, i) {
          var y = HEAD + i * ROW + 13;
          var rowG = el('g', { class: 'dg-row' + (r.pk ? ' is-pk' : '') + (r.fk ? ' is-fk' : ''), 'data-attr': r.a.id }, g);
          el('rect', { x: 1, y: HEAD + i * ROW, width: L.w - 2, height: ROW, class: 'dg-rowbg' }, rowG);
          var tt = el('title', null, rowG);
          tt.textContent = attrTooltip(r.a, view);
          text(rowG, PADX, y, r.name, { class: 'dg-attr' });
          if (view === 'physical') {
            var x2 = PADX + L.nameW + 18;
            if (L.typeW) text(rowG, x2, y, r.type, { class: 'dg-type' });
            if (L.consW) text(rowG, x2 + (L.typeW ? L.typeW + 18 : 0), y, r.cons, { class: 'dg-cons' });
          }
        });
        var ct = el('title', null, g);
        ct.textContent = className(c, view) + (c.label !== className(c, view) ? ' (' + c.label + ')' : '');
      });

      model.notes.forEach(function (n) {
        if (!vis(n, view)) return;
        var p = n.pos[view];
        var lines = wrap((n.text || ''), 240, FONT_S);
        var w = Math.max(140, Math.min(260, Math.max.apply(null, [measure(n.label, FONT_B) + 20].concat(lines.map(function (l) { return measure(l, FONT_S) + 20; })))));
        var h = 28 + lines.length * 14 + 8;
        grow(p.x, p.y, w, h);
        var g = el('g', { class: 'dg-note', transform: 'translate(' + p.x + ',' + p.y + ')' }, gNodes);
        el('rect', { x: 0, y: 0, width: w, height: h, rx: 3, class: 'dg-notebox' }, g);
        text(g, 10, 18, n.label, { class: 'dg-notetitle' });
        lines.forEach(function (l, i) { text(g, 10, 36 + i * 14, l, { class: 'dg-notetext' }); });
      });

      var paths = {};
      if (view === 'conceptual') {
        // several associations on the same side of a class: spread their ends along
        // that side (ordered by where the other class is) so labels do not pile up
        var ends = {};
        model.associations.forEach(function (a) {
          var s0 = boxes[a.source], t0 = boxes[a.target];
          if (!s0 || !t0 || s0 === t0) return;
          [[a, 'src', s0, t0, parseHandle(a.sourceHandle).side || guessSide(s0, t0)], [a, 'tgt', t0, s0, parseHandle(a.targetHandle).side || guessSide(t0, s0)]].forEach(function (x) {
            var key = x[2].cls.id + '|' + x[4];
            (ends[key] = ends[key] || []).push({ a: x[0], end: x[1], other: x[3], side: x[4] });
          });
        });
        var endOff = {};
        Object.keys(ends).forEach(function (k) {
          var list = ends[k];
          var horiz = list[0].side === 'top' || list[0].side === 'bottom';
          list.sort(function (p, q) { return horiz ? (p.other.x + p.other.w / 2) - (q.other.x + q.other.w / 2) : (p.other.y + p.other.h / 2) - (q.other.y + q.other.h / 2); });
          list.forEach(function (e, i) { endOff[e.a.id + e.end] = (i - (list.length - 1) / 2) * 22; });
        });
        model.associations.forEach(function (a) {
          var s = boxes[a.source], t = boxes[a.target];
          if (!s || !t) return;
          var hs = parseHandle(a.sourceHandle), ht = parseHandle(a.targetHandle);
          var p1 = anchor(s, hs.side || guessSide(s, t), null, endOff[a.id + 'src'] || 0), p2 = anchor(t, ht.side || guessSide(t, s), null, endOff[a.id + 'tgt'] || 0);
          var pts = s === t ? selfLoop(s) : route(p1, p2, a.lineStyle, a.controlPoints);
          if (s === t) { p1 = pts[0]; p2 = pts[pts.length - 1]; }
          paths[a.id] = pts;
          var g = el('g', { class: 'dg-edge dg-assoc', 'data-s': a.source, 'data-t': a.target, 'data-eid': a.id }, gEdges);
          el('path', { d: pathD(pts), class: 'dg-hit' }, g);
          el('path', { d: pathD(pts), class: 'dg-line' }, g);
          if (a.comment) { var ttl = el('title', null, g); ttl.textContent = a.comment; }
          var lg = el('g', { class: 'dg-elabels', 'data-s': a.source, 'data-t': a.target, 'data-eid': a.id }, gLabels);
          var mid = midpoint(pts);
          if (a.name) text(lg, mid.x, mid.y + (mid.horizontal ? -6 : 4), a.name, { class: 'dg-aname', 'text-anchor': mid.horizontal ? 'middle' : 'start', dx: mid.horizontal ? 0 : 6 });
          var la = endLabelPos(p1, 0), lb = endLabelPos(p2, 0);
          if (a.multA) text(lg, la.x, la.y, a.multA, { class: 'dg-mult', 'text-anchor': la.anchor });
          if (a.multB) text(lg, lb.x, lb.y, a.multB, { class: 'dg-mult', 'text-anchor': lb.anchor });
          if (a.roleA && a.roleA !== a.name) { var ra = endLabelPos(p1, 1); text(lg, ra.x, ra.y, a.roleA, { class: 'dg-role', 'text-anchor': ra.anchor }); }
          if (a.roleB && a.roleB !== a.name) { var rb = endLabelPos(p2, 1); text(lg, rb.x, rb.y, a.roleB, { class: 'dg-role', 'text-anchor': rb.anchor }); }
        });
        model.associatives.forEach(function (a) {
          var s = boxes[a.source];
          var targetEdge = (a.target || '').replace(/^assoc-edge-/, '');
          var pts = paths[targetEdge];
          if (!s || !pts) return;
          var mid = midpoint(pts);
          var hs = parseHandle(a.sourceHandle);
          var p1 = anchor(s, hs.side || 'top');
          var g = el('g', { class: 'dg-edge dg-associative', 'data-s': a.source }, gEdges);
          el('path', { d: 'M' + p1.x + ' ' + p1.y + ' L' + mid.x + ' ' + mid.y, class: 'dg-line dg-dashed' }, g);
        });
      } else {
        model.relationships.forEach(function (r) {
          var s = boxes[r.source], t = boxes[r.target];
          if (!s || !t) return;
          var hs = parseHandle(r.sourceHandle), ht = parseHandle(r.targetHandle);
          var p1 = anchor(s, hs.side || guessSide(s, t), hs.attr), p2 = anchor(t, ht.side || guessSide(t, s), ht.attr);
          var pts = route(p1, p2, r.lineStyle, r.controlPoints);
          var g = el('g', { class: 'dg-edge dg-rel', 'data-s': r.source, 'data-t': r.target, 'data-sa': hs.attr || '', 'data-ta': ht.attr || '', 'data-eid': r.id }, gEdges);
          el('path', { d: pathD(pts), class: 'dg-hit' }, g);
          el('path', { d: pathD(pts), class: 'dg-line', 'marker-end': 'url(#' + arrowId + ')' }, g);
        });
      }
      if (!isFinite(bounds.x1)) bounds = { x1: 0, y1: 0, x2: 400, y2: 300 };
      markIssues();
    }

    // ---- issue highlighting (opts.issues from Checks.analyze)
    var SEV_RANK = { error: 3, deviation: 2, convention: 1, minor: 0 };
    function markIssues() {
      var list = (opts.issues || []).filter(function (i) { return i.view === view; });
      var perClass = {};
      function worse(a, b) { return !a || SEV_RANK[b] > SEV_RANK[a] ? b : a; }
      list.forEach(function (i) {
        var msg = '⚠ ' + i.text.replace(/`/g, '');
        if (i.attrId) {
          var row = gNodes.querySelector('.dg-row[data-attr="' + cssEsc(i.attrId) + '"]');
          if (row) { row.classList.add('iss', 'iss-' + i.sev); appendTitle(row, msg); }
        }
        if (i.edgeId) {
          Array.prototype.forEach.call(world.querySelectorAll('[data-eid="' + cssEsc(i.edgeId) + '"]'), function (e) {
            e.classList.add('iss', 'iss-' + i.sev); if (e.classList.contains('dg-edge')) appendTitle(e, msg);
          });
        }
        var cid = i.classId;
        if (!cid && i.edgeId) { var eg = world.querySelector('.dg-edge[data-eid="' + cssEsc(i.edgeId) + '"]'); cid = eg && eg.getAttribute('data-s'); }
        if (cid && boxes[cid]) {
          var pc = perClass[cid] || (perClass[cid] = { n: 0, sev: null, msgs: [] });
          pc.n++; pc.sev = worse(pc.sev, i.sev); pc.msgs.push(msg);
        }
      });
      Object.keys(perClass).forEach(function (cid) {
        var b = boxes[cid], pc = perClass[cid];
        b.g.classList.add('iss', 'iss-' + pc.sev);
        var badge = el('g', { class: 'dg-badge iss-' + pc.sev, transform: 'translate(' + (b.w - 2) + ',-6)' }, b.g);
        el('circle', { r: 9 }, badge);
        text(badge, 0, 4, String(pc.n), { 'text-anchor': 'middle' });
        appendTitle(badge, pc.msgs.join(String.fromCharCode(10)));
      });
    }
    function appendTitle(node, msg) {
      var t = node.querySelector(':scope > title');
      if (!t) { t = el('title', null); node.insertBefore(t, node.firstChild); }
      t.textContent = (t.textContent ? t.textContent + String.fromCharCode(10) : '') + msg;
    }
    function focusOn(ref) {
      var b = ref.classId && boxes[ref.classId], target = null;
      if (b) target = { x: b.x + b.w / 2, y: b.y + b.h / 2, node: b.g };
      else if (ref.edgeId) {
        var eg = world.querySelector('.dg-edge[data-eid="' + cssEsc(ref.edgeId) + '"] .dg-line');
        if (eg && eg.getBBox) { var bb = eg.getBBox(); target = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, node: eg.parentNode }; }
      }
      if (!target) return;
      var r = container.getBoundingClientRect();
      state.userMoved = true;
      if (state.k < 0.9) state.k = 0.9;
      state.tx = r.width / 2 - target.x * state.k;
      state.ty = r.height / 2 - target.y * state.k;
      apply();
      target.node.classList.remove('flash'); void target.node.getBoundingClientRect(); target.node.classList.add('flash');
    }

    function guessSide(a, b) {
      var dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
      return dy > 0 ? 'bottom' : 'top';
    }
    function selfLoop(b) {
      var x = b.x + b.w, y = b.y + 12;
      return [{ x: x, y: y, side: 'right' }, { x: x + 30, y: y }, { x: x + 30, y: y - 30 }, { x: b.x + b.w - 20, y: y - 30 }, { x: b.x + b.w - 20, y: b.y, side: 'top' }];
    }

    function fit() {
      var r = container.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var pad = 30, bw = bounds.x2 - bounds.x1 + 2 * pad, bh = bounds.y2 - bounds.y1 + 2 * pad;
      state.k = Math.min(1.6, Math.min(r.width / bw, r.height / bh));
      state.tx = (r.width - (bounds.x2 - bounds.x1) * state.k) / 2 - bounds.x1 * state.k;
      state.ty = (r.height - (bounds.y2 - bounds.y1) * state.k) / 2 - bounds.y1 * state.k;
      apply();
    }

    function zoomAt(f, cx, cy) {
      var k2 = Math.max(0.15, Math.min(4, state.k * f));
      f = k2 / state.k;
      state.tx = cx - (cx - state.tx) * f;
      state.ty = cy - (cy - state.ty) * f;
      state.k = k2;
      apply();
    }

    // pan & zoom
    var drag = null;
    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      state.tx = drag.tx + e.clientX - drag.x; state.ty = drag.ty + e.clientY - drag.y; apply();
    });
    function endDrag() { drag = null; svg.classList.remove('dragging'); }
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // hover highlighting
    gNodes.addEventListener('pointerover', function (e) {
      var g = e.target.closest && e.target.closest('.dg-class');
      highlight(g ? g.getAttribute('data-id') : null, e.target.closest && e.target.closest('.dg-row'));
    });
    gNodes.addEventListener('pointerleave', function () { highlight(null); });
    function highlight(id, row) {
      svg.classList.toggle('has-hover', !!id);
      var attr = row ? row.getAttribute('data-attr') : null;
      var all = world.querySelectorAll('.dg-edge, .dg-elabels');
      function attrMatch(e) {
        return (e.getAttribute('data-s') === id && e.getAttribute('data-sa') === attr) ||
          (e.getAttribute('data-t') === id && e.getAttribute('data-ta') === attr);
      }
      // hovering a key attribute narrows the highlight to the arrows of that attribute
      var narrow = !!attr && Array.prototype.some.call(all, function (e) { return e.classList.contains('dg-rel') && attrMatch(e); });
      Array.prototype.forEach.call(all, function (e) {
        var on = id && (e.getAttribute('data-s') === id || e.getAttribute('data-t') === id);
        if (on && narrow) on = e.classList.contains('dg-rel') && attrMatch(e);
        e.classList.toggle('hl', !!on);
      });
      Array.prototype.forEach.call(gNodes.querySelectorAll('.dg-class'), function (g) {
        var cid = g.getAttribute('data-id');
        var linked = id && (cid === id || world.querySelector('.dg-edge.hl[data-s="' + cssEsc(cid) + '"], .dg-edge.hl[data-t="' + cssEsc(cid) + '"]'));
        g.classList.toggle('hl', !!linked);
      });
    }

    draw();
    requestAnimationFrame(fit);
    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () { if (!state.userMoved) fit(); }) : null;
    if (ro) ro.observe(container);
    svg.addEventListener('pointerdown', function () { state.userMoved = true; });
    svg.addEventListener('wheel', function () { state.userMoved = true; }, { passive: true });

    return {
      fit: function () { state.userMoved = false; fit(); },
      zoom: function (f) { var r = container.getBoundingClientRect(); state.userMoved = true; zoomAt(f, r.width / 2, r.height / 2); },
      setView: function (v) { view = v; draw(); state.userMoved = false; fit(); },
      setIssues: function (list) { opts.issues = list; draw(); },
      focus: function (ref) { focusOn(ref); },
      getView: function () { return view; },
      destroy: function () { if (ro) ro.disconnect(); container.innerHTML = ''; },
      svg: svg
    };
  }

  function attrTooltip(a, view) {
    var parts = [attrName(a, view) + ' : ' + (typeStr(a) || '—')];
    if (a.logicalName && a.logicalName !== a.name) parts.push('conceptual name: ' + a.name);
    parts.push(a.nullable ? 'nullable' : 'NOT NULL');
    if (a.unique) parts.push('UNIQUE');
    if (a.autoIncrement) parts.push('AUTO_INCREMENT');
    if (a.defaultValue !== '') parts.push('DEFAULT ' + a.defaultValue);
    return parts.join('\n');
  }

  function wrap(s, maxW, font) {
    var out = [];
    String(s).split(/\n/).forEach(function (para) {
      var words = para.split(/\s+/), line = '';
      words.forEach(function (w) {
        var t = line ? line + ' ' + w : w;
        if (measure(t, font) > maxW && line) { out.push(line); line = w; } else line = t;
      });
      out.push(line);
    });
    return out.slice(0, 30);
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  var uidN = 0;
  function uid() { return (++uidN).toString(36); }

  var api = { load: load, render: render, toSchema: toSchema, typeStr: typeStr, VIEWS: VIEWS, vis: vis, className: className, attrName: attrName };
  root.Diagram = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
