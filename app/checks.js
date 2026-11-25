/*
 * Checks a submission (Modelizer model and/or SQL dump) against
 *  1. the model solution (missing entities/attributes/links, multiplicities,
 *     keys, uniqueness …) – additions beyond the solution are allowed and not reported;
 *  2. the "Naming Conventions for Database Modeling" (CNES, curriculum.lu).
 *
 * Issue: { sev, area, where, view, classId, attrId, edgeId, table, line, text }
 *   sev   : 'deviation' (differs from the solution) | 'convention' | 'error' | 'minor'
 *   area  : 'solution' | 'naming' | 'other'
 *   where : 'MCD' | 'MLD' | 'EMLD' | 'SQL'
 */
(function (root) {
  'use strict';
  var SqlParse = root.SqlParse || require('./sqlparse.js');
  var Diagram = root.Diagram || require('./diagram.js');

  var UCC = /^[A-Z][A-Za-z0-9]*$/;
  var LCC = /^[a-z][A-Za-z0-9]*$/;
  var VIEW_OF = { MCD: 'conceptual', MLD: 'logical', EMLD: 'physical' };

  function ascii(s) { return /^[\x21-\x7e]*$/.test(s); }
  function lcFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  function looksPlural(n) {
    var l = n.toLowerCase();
    return /[^su]s$/.test(l) && !/(ics|news|series|species|gas|bus|alias|canvas)$/.test(l);
  }
  function q(s) { return '`' + s + '`'; }

  // --------------------------------------------------------- multiplicity
  function parseMult(s) {
    s = String(s || '').trim().toLowerCase();
    if (!s) return null;
    var v = function (x) { x = x.trim(); return (x === '*' || x === 'n' || x === 'm' || x === 'N') ? Infinity : (/^\d+$/.test(x) ? +x : NaN); };
    var p = s.split(/\.\.|\.\s*\./);
    if (p.length === 1) { var a = v(p[0]); return a === Infinity ? { min: 0, max: Infinity } : { min: a, max: a }; }
    return { min: v(p[0]), max: v(p[1]) };
  }
  function multStr(m) { return !m ? '—' : m.min === m.max ? String(m.min) : m.min + '..' + (m.max === Infinity ? '*' : m.max); }
  function sameMult(a, b) { return !!a && !!b && a.min === b.min && a.max === b.max; }

  // ------------------------------------------------------- type helpers
  function category(t) {
    t = String(t || '').toLowerCase().replace(/\(.*$/, '').trim();
    if (/^(var)?char|text|enum|set|json|blob|binary/.test(t)) return 'text';
    if (/int|dec|numeric|float|double|real|bool|bit|serial/.test(t)) return 'number';
    if (/date|time|year/.test(t)) return 'datetime';
    return t || '?';
  }
  function length(t, params) {
    if (params && params.maxLength) return +params.maxLength || null;
    var m = /^(?:var)?char\s*\((\d+)\)/i.exec(String(t || ''));
    return m ? +m[1] : null;
  }

  // ------------------------------------------------- attribute synonyms
  var SYN = {
    username: ['username', 'login', 'nickname', 'pseudo', 'benutzername'],
    email: ['email', 'mail'],
    phonenumber: ['phone', 'mobile', 'telephone', 'tel', 'gsm', 'telefon', 'handy'],
    password: ['password', 'passwort', 'pwd', 'hash'],
    credit: ['credit', 'balance', 'powercell', 'guthaben', 'points', 'cells'],
    number: ['number', 'nr', 'num', 'no', 'nummer'],
    name: ['name', 'title', 'bezeichnung', 'label'],
    description: ['description', 'desc', 'beschreibung', 'info'],
    ipaddress: ['ipaddress', 'ipadress', 'ip', 'ipv4', 'address'],
    photo: ['photo', 'image', 'picture', 'img', 'foto', 'bild', 'pic'],
    timestamp: ['timestamp', 'start', 'begin', 'datetime', 'date', 'time', 'when'],
    duration: ['duration', 'minutes', 'dauer', 'length']
  };
  function bareName(n) { return String(n || '').replace(/^(pkfk|pk|fk)_/i, '').toLowerCase(); }
  // camelCase / snake_case words of a name, lowercased
  function words(n) {
    return String(n || '').replace(/^(pkfk|pk|fk)_/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-]+/).filter(Boolean).map(function (w) { return w.toLowerCase(); });
  }
  function findAttr(list, refName, getNames, opts) {
    var key = refName.toLowerCase();
    var names = function (a) { return getNames(a).filter(Boolean); };
    var cands = list.filter(function (a) { return !names(a).some(function (n) { return /^(pkfk|fk)_/i.test(n); }); });
    var exact = cands.filter(function (a) { return names(a).some(function (n) { return bareName(n) === key; }); })[0];
    if (exact) return exact;
    // surrogate keys (pk_<table>, AI) never stand for a business attribute
    cands = cands.filter(function (a) { return !a.autoIncrement && !names(a).some(function (n) { return /^pk_/i.test(n) && (opts && opts.table ? bareName(n) === stripTbl(opts.table).toLowerCase() : false); }); });
    var syn = SYN[key] || [key];
    for (var i = 0; i < syn.length; i++) {
      var hit = cands.filter(function (a) {
        return names(a).some(function (n) {
          var b = bareName(n), ws = words(n);
          return ws.some(function (w) { return w.indexOf(syn[i]) === 0; }) || (syn[i].length >= 5 && b.indexOf(syn[i]) >= 0);
        });
      })[0];
      if (hit) return hit;
    }
    return null;
  }
  function stripTbl(n) { return String(n || '').replace(/^tbl_?/i, ''); }

  // ------------------------------------------------------- model access
  function vis(o, v) { return Diagram.vis(o, v); }
  function cName(c, v) { return Diagram.className(c, v); }
  function aName(a, v) { return Diagram.attrName(a, v); }

  function modelInfo(m) {
    var info = { m: m, byId: m.byId, assocClassOf: {}, edgeOfAssocClass: {}, assocById: {} };
    m.associations.forEach(function (a) { info.assocById[a.id] = a; });
    m.associatives.forEach(function (x) {
      var eid = String(x.target || '').replace(/^assoc-edge-/, '');
      info.assocClassOf[eid] = x.source; info.edgeOfAssocClass[x.source] = eid;
    });
    var cls = m.classes.filter(function (c) { return vis(c, 'conceptual') || vis(c, 'logical'); });
    var names = cls.map(function (c) { return c.label; });
    var ents = SqlParse.detectEntities(names);
    info.core = {};
    ents.forEach(function (e) {
      if (!e.matches.length) return;
      var c = cls.filter(function (x) { return x.label === e.matches[0]; })[0];
      if (c) info.core[e.key] = c;
    });
    return info;
  }
  function assocsBetween(info, a, b) {
    return info.m.associations.filter(function (x) { return (x.source === a.id && x.target === b.id) || (x.source === b.id && x.target === a.id); });
  }
  function multAt(assoc, cls) { return parseMult(assoc.source === cls.id ? assoc.multA : assoc.multB); }
  function pkAttrs(c, v) { return c.attributes.filter(function (a) { return vis(a, v) && /^pk/i.test(aName(a, v)); }); }

  // ----------------------------------------------- reference (solution)
  function buildReference(sol) {
    if (!sol || sol.kind !== 'modelizer') return null;
    var info = modelInfo(sol);
    var keyOf = {};
    Object.keys(info.core).forEach(function (k) { keyOf[info.core[k].id] = k; });
    var ref = { info: info, entities: {}, links: [], fks: [] };
    Object.keys(info.core).forEach(function (k) {
      var c = info.core[k];
      ref.entities[k] = {
        label: c.label,
        attrs: c.attributes.filter(function (a) { return vis(a, 'conceptual'); }).map(function (a) {
          var pk = /^pk/i.test(a.logicalName || a.name);
          var single = pkAttrs(c, 'logical').length === 1;
          return { name: a.name, type: Diagram.typeStr(a), unique: a.unique || (pk && single), nullable: pk ? false : a.nullable, pk: pk };
        })
      };
    });
    sol.associations.forEach(function (a) {
      var ka = keyOf[a.source], kb = keyOf[a.target];
      if (!ka || !kb) return;
      var via = info.assocClassOf[a.id] ? keyOf[info.assocClassOf[a.id]] : null;
      ref.links.push({ a: ka, b: kb, name: a.name, multA: parseMult(a.multA), multB: parseMult(a.multB), via: via });
    });
    sol.relationships.forEach(function (r) {
      var ka = keyOf[r.source], kb = keyOf[r.target];
      if (ka && kb) ref.fks.push({ from: ka, to: kb });
    });
    return ref;
  }

  // ================================================================ run
  function analyze(opts) {
    var model = opts.model && opts.model.kind === 'modelizer' ? opts.model : null;
    var parsed = opts.parsed || null;
    var text = opts.sqlText || '';
    var ref = opts.reference || buildReference(opts.solution);
    var issues = [];
    function add(o) { issues.push(o); }
    T = {};

    var mi = model ? modelInfo(model) : null;
    if (model) {
      checkModelNaming(model, mi, add);
      checkModelStructure(model, mi, add);
      if (ref) compareModel(model, mi, ref, add);
    }
    if (parsed) {
      var loc = locator(text, parsed);
      checkSqlNaming(parsed, loc, add);
      if (ref) compareSql(parsed, loc, ref, add, !model);
    }
    return { issues: issues, checked: T, rules: RULES, core: mi ? Object.keys(mi.core).reduce(function (o, k) { o[k] = mi.core[k].label; return o; }, {}) : null };
  }

  // ------------------------------------------------ convention rules
  // Each check counts how many items it looked at (tick) and tags its findings
  // with the rule, so the Review can show every rule once: checked / violated.
  var RULES = [
    { id: 'mcd.class', where: 'MCD', title: 'Class names: singular nouns in UpperCamelCase (no prefix, no spaces or special characters)' },
    { id: 'mcd.singular', where: 'MCD', title: 'Class names are singular', minor: true },
    { id: 'mcd.attr', where: 'MCD', title: 'Attribute names in lowerCamelCase' },
    { id: 'mcd.noKeys', where: 'MCD', title: 'No primary or foreign keys in the MCD' },
    { id: 'mcd.unique', where: 'MCD', title: 'Class names unique in the model, attribute names unique within a class' },
    { id: 'mcd.assoc', where: 'MCD', title: 'Associations named with a verb in lowerCamelCase (e.g. isLocated)' },
    { id: 'mcd.assocUnique', where: 'MCD', title: 'Association names are unique' },
    { id: 'mcd.assocClass', where: 'MCD', title: 'An association class repeats the association name' },
    { id: 'mld.pk', where: 'MLD', title: 'Every table has a primary key (pk_…)' },
    { id: 'mld.surrogate', where: 'MLD', title: 'Surrogate keys are named pk_<class in lowerCamelCase>' },
    { id: 'mld.keyCase', where: 'MLD', title: 'Lowercase prefixes (pk_, fk_, pkfk_), names after the prefix in lowerCamelCase' },
    { id: 'mld.fkPrefix', where: 'MLD', title: 'Foreign keys use the fk_ (or pkfk_) prefix' },
    { id: 'mld.fkName', where: 'MLD', title: 'Foreign keys are named fk_<referenced class>_<verb> (pkfk_<class> in association tables)' },
    { id: 'mld.fkVerb', where: 'MLD', title: 'Foreign key names contain the association verb', minor: true },
    { id: 'mld.arrow', where: 'MLD', title: 'Arrows go from the foreign key to the primary key' },
    { id: 'sql.table', where: 'SQL', title: 'Table names = class names in UpperCamelCase (no tbl prefix)' },
    { id: 'sql.colPrefix', where: 'SQL', title: 'Key columns use pk_ / fk_ / pkfk_, other columns do not' },
    { id: 'sql.colCase', where: 'SQL', title: 'Column names in lowerCamelCase' },
    { id: 'sql.surrogate', where: 'SQL', title: 'Surrogate keys are named pk_<table in lowerCamelCase>' },
    { id: 'sql.fkName', where: 'SQL', title: 'Foreign key columns are named fk_<referenced table>_<verb>' },
    { id: 'sql.fkVerb', where: 'SQL', title: 'Foreign key column names contain the association verb', minor: true },
    { id: 'sql.fkc', where: 'SQL', title: 'Foreign key constraints are named fkc_<Source>_<verb>_<Target>' },
    { id: 'sql.idx', where: 'SQL', title: 'Indexes are named idx_<type>_<field> (e.g. idx_unique_email)' },
    { id: 'sql.objects', where: 'SQL', title: 'Views, procedures, functions and triggers use vw_ / sp_ / fn_ / tr_' }
  ];
  var T = {};
  function tick(rule) { T[rule] = (T[rule] || 0) + 1; }
  function R(rule, o) { return Object.assign({}, o, { rule: rule }); }

  // ---------------------------------------------------- model: naming
  function checkModelNaming(m, info, add) {
    // MCD
    var seenClass = {};
    m.classes.forEach(function (c) {
      if (!vis(c, 'conceptual')) return;
      var n = c.label;
      var assocEdge = info.edgeOfAssocClass[c.id];
      var base = { sev: 'convention', area: 'naming', where: 'MCD', view: 'conceptual', classId: c.id };
      if (assocEdge) {
        tick('mcd.assocClass');
        var an = (info.assocById[assocEdge] || {}).name || '';
        if (n !== an) add(R('mcd.assocClass', Object.assign({ text: 'Association class ' + q(n) + ' must repeat the association name ' + q(an) + '.' }, base)));
      } else {
        tick('mcd.class'); tick('mcd.singular');
        if (!ascii(n)) add(R('mcd.class', Object.assign({ text: 'Class name ' + q(n) + ' contains spaces or special characters.' }, base)));
        else if (/^tbl/i.test(n)) add(R('mcd.class', Object.assign({ text: 'Class ' + q(n) + ' has a "tbl" prefix; class names are plain UpperCamelCase nouns.' }, base)));
        else if (!UCC.test(n)) add(R('mcd.class', Object.assign({ text: 'Class name ' + q(n) + ' is not UpperCamelCase.' }, base)));
        if (looksPlural(n)) add(R('mcd.singular', Object.assign({ text: 'Class name ' + q(n) + ' looks plural; use a singular noun.' }, base, { sev: 'minor' })));
      }
      var k = n.toLowerCase();
      tick('mcd.unique');
      if (seenClass[k]) add(R('mcd.unique', Object.assign({ text: 'Class name ' + q(n) + ' is used twice.' }, base)));
      seenClass[k] = 1;
      var seenAttr = {};
      c.attributes.forEach(function (a) {
        if (!vis(a, 'conceptual')) return;
        var an2 = a.name;
        var b = Object.assign({}, base, { attrId: a.id });
        tick('mcd.noKeys');
        if (/^(pk|fk|pkfk)_/i.test(an2)) add(R('mcd.noKeys', Object.assign({}, b, { text: 'Key ' + q(an2) + ' in ' + q(n) + ': the MCD must not contain primary/foreign keys.' })));
        else {
          tick('mcd.attr');
          if (!ascii(an2)) add(R('mcd.attr', Object.assign({}, b, { text: 'Attribute ' + q(n + '.' + an2) + ' contains spaces or special characters.' })));
          else if (!LCC.test(an2)) add(R('mcd.attr', Object.assign({}, b, { text: 'Attribute ' + q(n + '.' + an2) + ' is not lowerCamelCase.' })));
        }
        if (seenAttr[an2.toLowerCase()]) add(R('mcd.unique', Object.assign({}, b, { text: 'Attribute ' + q(an2) + ' appears twice in ' + q(n) + '.' })));
        seenAttr[an2.toLowerCase()] = 1;
      });
    });
    var seenAssoc = {};
    m.associations.forEach(function (a) {
      var s = m.byId[a.source], t = m.byId[a.target];
      if (!s || !t || !vis(s, 'conceptual') || !vis(t, 'conceptual')) return;
      var lbl = s.label + ' – ' + t.label;
      var base = { sev: 'convention', area: 'naming', where: 'MCD', view: 'conceptual', edgeId: a.id };
      tick('mcd.assoc');
      if (!a.name) add(R('mcd.assoc', Object.assign({ text: 'Association ' + lbl + ' has no name (use a verb, e.g. isLocated).' }, base)));
      else {
        tick('mcd.assocUnique');
        if (!ascii(a.name)) add(R('mcd.assoc', Object.assign({ text: 'Association name ' + q(a.name) + ' contains spaces or special characters.' }, base)));
        else if (!LCC.test(a.name)) add(R('mcd.assoc', Object.assign({ text: 'Association name ' + q(a.name) + ' (' + lbl + ') is not lowerCamelCase.' }, base)));
        if (seenAssoc[a.name]) add(R('mcd.assocUnique', Object.assign({ text: 'Association name ' + q(a.name) + ' is used more than once; names must be unique.' }, base)));
        seenAssoc[a.name] = 1;
      }
      if (!parseMult(a.multA) || !parseMult(a.multB)) add(Object.assign({}, base, { sev: 'error', area: 'other', text: 'Association ' + (a.name ? q(a.name) : lbl) + ' is missing a multiplicity.' }));
      else if (isNaN(parseMult(a.multA).min) || isNaN(parseMult(a.multB).min) || isNaN(parseMult(a.multA).max) || isNaN(parseMult(a.multB).max)) add(Object.assign({}, base, { sev: 'error', area: 'other', text: 'Association ' + (a.name ? q(a.name) : lbl) + ' has an invalid multiplicity (' + a.multA + ' / ' + a.multB + ').' }));
    });

    // MLD / EMLD
    var relBySrcAttr = {};
    m.relationships.forEach(function (r) {
      var hs = handleAttr(r.sourceHandle);
      if (hs) relBySrcAttr[hs] = r;
    });
    m.classes.forEach(function (c) {
      if (!vis(c, 'logical')) return;
      var n = cName(c, 'logical');
      var base = { sev: 'convention', area: 'naming', where: 'MLD', view: 'logical', classId: c.id };
      var pks = pkAttrs(c, 'logical');
      tick('mld.pk');
      if (!pks.length) add(R('mld.pk', Object.assign({}, base, { sev: 'error', area: 'other', text: 'Table ' + q(n) + ' has no primary key (pk_…).' })));
      if (pks.length === 1 && pks[0].autoIncrement && ascii(n)) {
        tick('mld.surrogate');
        var want = 'pk_' + lcFirst(stripTbl(n));
        var have = aName(pks[0], 'logical');
        var okName = UCC.test(n) ? have === want : have.toLowerCase() === want.toLowerCase();
        if (!okName && /^pk_/.test(have)) add(R('mld.surrogate', Object.assign({}, base, { attrId: pks[0].id, text: 'Surrogate key ' + q(have) + ' should be named ' + q(want) + '.' })));
      }
      c.attributes.forEach(function (a) {
        if (!vis(a, 'logical')) return;
        var an = aName(a, 'logical');
        var b = Object.assign({}, base, { attrId: a.id });
        var mm = /^(pkfk|pk|fk)_(.*)$/i.exec(an);
        var rest = mm ? mm[2] : an;
        var parts = rest.split('_');
        if (mm) {
          tick('mld.keyCase');
          if (mm[1] !== mm[1].toLowerCase()) add(R('mld.keyCase', Object.assign({}, b, { text: 'Prefix of ' + q(an) + ' must be lowercase (' + mm[1].toLowerCase() + '_).' })));
          else if (!ascii(an)) add(R('mld.keyCase', Object.assign({}, b, { text: q(n + '.' + an) + ' contains spaces or special characters.' })));
          else if (parts.some(function (p) { return p && !LCC.test(p); })) add(R('mld.keyCase', Object.assign({}, b, { text: q(n + '.' + an) + ': the parts after the prefix must be lowerCamelCase.' })));
        }
        // fk naming: fk_<referencedClass>_<verb>
        var rel = relBySrcAttr[a.id];
        if (rel && mm && /^(fk|pkfk)$/i.test(mm[1])) {
          var tgt = m.byId[rel.target];
          if (tgt) {
            var tn = lcFirst(stripTbl(cName(tgt, 'logical')));
            var tpk = handleAttr(rel.targetHandle);
            var tpkName = tpk ? bareName(aName(attrById(tgt, tpk) || { name: '' }, 'logical')) : '';
            var first = (parts[0] || '').toLowerCase();
            tick('mld.fkName');
            if (first !== tn.toLowerCase() && first !== tpkName) add(R('mld.fkName', Object.assign({}, b, { text: q(an) + ' references ' + q(cName(tgt, 'logical')) + '; the name should be ' + mm[1].toLowerCase() + '_' + tn + (mm[1].toLowerCase() === 'fk' ? '_<verb>' : '') + '.' })));
            else if (mm[1].toLowerCase() === 'fk') {
              tick('mld.fkVerb');
              if (parts.length < 2) add(R('mld.fkVerb', Object.assign({}, b, { sev: 'minor', text: q(an) + ' has no association verb (convention: fk_' + tn + '_<verb>).' })));
            }
          }
        }
      });
    });
  }

  function handleAttr(h) {
    var m = /^(?:left|right|top|bottom)-(.+)-(?:source|target)$/.exec(h || '');
    return m ? m[1] : null;
  }
  function attrById(c, id) { return c.attributes.filter(function (a) { return a.id === id; })[0] || null; }

  // ------------------------------------------------- model: structure
  function checkModelStructure(m, info, add) {
    var relSrc = {};
    m.relationships.forEach(function (r) {
      var s = m.byId[r.source], t = m.byId[r.target];
      if (!s || !t) return;
      var sa = attrById(s, handleAttr(r.sourceHandle)), ta = attrById(t, handleAttr(r.targetHandle));
      var base = { area: 'other', where: 'MLD', view: 'logical', edgeId: r.id, classId: s.id };
      if (sa) relSrc[sa.id] = r;
      var san = sa ? aName(sa, 'logical') : '', tan = ta ? aName(ta, 'logical') : '';
      tick('mld.arrow');
      tick('mld.fkPrefix');
      if (sa && ta && /^pk_/i.test(san) && /^(fk|pkfk)_/i.test(tan)) add(Object.assign({}, base, { sev: 'error', text: 'Arrow ' + q(cName(s, 'logical') + '.' + san) + ' → ' + q(cName(t, 'logical') + '.' + tan) + ' points the wrong way: it must go from the foreign key to the primary key.', rule: 'mld.arrow' }));
      else if (ta && !/^(pk|pkfk)_/i.test(tan)) add(Object.assign({}, base, { sev: 'error', text: 'Arrow from ' + q(cName(s, 'logical') + '.' + san) + ' points to ' + q(cName(t, 'logical') + '.' + tan) + ', which is not a primary key.', rule: 'mld.arrow' }));
      else if (sa && !/^(fk|pkfk)_/i.test(san)) add(Object.assign({}, base, { sev: 'convention', area: 'naming', attrId: sa.id, text: q(cName(s, 'logical') + '.' + san) + ' is used as a foreign key but has no fk_ prefix.', rule: 'mld.fkPrefix' }));
      // EMLD: type of FK = type of PK
      if (sa && ta && Diagram.typeStr(sa) && Diagram.typeStr(ta) && normT(Diagram.typeStr(sa)) !== normT(Diagram.typeStr(ta))) {
        add({ sev: 'error', area: 'other', where: 'EMLD', view: 'physical', classId: s.id, attrId: sa.id, edgeId: r.id, text: 'Type mismatch: ' + q(cName(s, 'physical') + '.' + aName(sa, 'physical')) + ' is ' + Diagram.typeStr(sa) + ' but ' + q(cName(t, 'physical') + '.' + aName(ta, 'physical')) + ' is ' + Diagram.typeStr(ta) + '.' });
      }
    });
    m.classes.forEach(function (c) {
      if (!vis(c, 'logical')) return;
      var untyped = c.attributes.filter(function (a) { return vis(a, 'physical') && !a.type; });
      if (untyped.length > 2) add({ sev: 'error', area: 'other', where: 'EMLD', view: 'physical', classId: c.id, text: q(cName(c, 'physical')) + ': ' + untyped.length + ' of ' + c.attributes.filter(function (a) { return vis(a, 'physical'); }).length + ' attributes have no data type.' });
      c.attributes.forEach(function (a) {
        var an = aName(a, 'logical');
        if (vis(a, 'logical') && /^(fk|pkfk)_/i.test(an) && !relSrc[a.id]) add({ sev: 'error', area: 'other', where: 'MLD', view: 'logical', classId: c.id, attrId: a.id, text: 'Foreign key ' + q(cName(c, 'logical') + '.' + an) + ' has no arrow to the primary key it references.' });
        if (vis(a, 'physical') && !a.type && untyped.length <= 2) add({ sev: 'error', area: 'other', where: 'EMLD', view: 'physical', classId: c.id, attrId: a.id, text: q(cName(c, 'physical') + '.' + aName(a, 'physical')) + ' has no data type.' });
        if (vis(a, 'physical') && a.autoIncrement && !/^pk_/i.test(aName(a, 'physical'))) add({ sev: 'error', area: 'other', where: 'EMLD', view: 'physical', classId: c.id, attrId: a.id, text: 'AI on ' + q(cName(c, 'physical') + '.' + aName(a, 'physical')) + ', which is not a surrogate primary key.' });
      });
    });
  }
  function normT(t) { return String(t).toLowerCase().replace(/\s+/g, '').replace(/^integer/, 'int').replace(/^(tiny|small|medium|big)?int\(\d+\)/, '$1int'); }

  // -------------------------------------------- model: vs. the solution
  function compareModel(m, info, ref, add) {
    var sol = ref.info;
    Object.keys(ref.entities).forEach(function (k) {
      var re = ref.entities[k];
      var c = info.core[k];
      if (!c) { add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', text: 'No class for ' + q(re.label) + ' (solution) – ' + entityHint(k) + '.' }); return; }
      var attrs = c.attributes.filter(function (a) { return vis(a, 'conceptual') || vis(a, 'logical'); });
      re.attrs.forEach(function (ra) {
        var hit = findAttr(attrs, ra.name, function (a) { return [a.name, a.logicalName]; }, { table: c.label });
        if (!hit) add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', classId: c.id, text: q(c.label) + ' has no attribute for ' + q(ra.name) + ' (solution: ' + re.label + '.' + ra.name + ').' });
        else if (vis(hit, 'physical')) {
          var b = { area: 'solution', where: 'EMLD', view: 'physical', classId: c.id, attrId: hit.id };
          var nm = q(cName(c, 'physical') + '.' + aName(hit, 'physical'));
          var isPk = /^pk/i.test(aName(hit, 'physical'));
          if (ra.unique && !hit.unique && !isPk) add(Object.assign({}, b, { sev: 'deviation', text: nm + ' should be UQ (unique) like ' + re.label + '.' + ra.name + ' in the solution.' }));
          if (!ra.nullable && hit.nullable && !isPk) add(Object.assign({}, b, { sev: 'minor', text: nm + ' is nullable; the solution has it NN.' }));
          typeCompare(Diagram.typeStr(hit), hit.typeParams, ra, nm, b, add);
        }
      });
    });
    // links / multiplicities
    ref.links.forEach(function (L) {
      var A = info.core[L.a], B = info.core[L.b];
      if (!A || !B) return;
      var refName = ref.entities[L.a].label + ' – ' + ref.entities[L.b].label;
      if (L.via) {
        var C = info.core[L.via];
        var direct = assocsBetween(info, A, B)[0];
        if (direct && (!C || info.assocClassOf[direct.id] === C.id)) {
          cmpMult(direct, A, L.multA, B, L.multB, refName, add);
          return;
        }
        if (C) {
          [[A, L.multA], [B, L.multB]].forEach(function (pair) {
            var X = pair[0];
            var as = assocsBetween(info, C, X)[0];
            if (!as) { add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', classId: C.id, text: q(C.label) + ' is not linked to ' + q(X.label) + ' (solution: ' + refName + ').' }); return; }
            var atX = multAt(as, X), atC = multAt(as, C);
            var wantC = { min: pair[1] ? pair[1].min : 0, max: Infinity };
            if (sameMult(atC, { min: 1, max: 1 }) && sameMult(atX, wantC)) {
              add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', edgeId: as.id, text: 'Multiplicities on ' + q(as.name || (C.label + '–' + X.label)) + ' are written on the wrong ends (' + X.label + ' ' + multStr(atX) + ', ' + C.label + ' ' + multStr(atC) + '); each ' + C.label + ' belongs to exactly 1 ' + X.label + '.' });
              return;
            }
            if (!sameMult(atX, { min: 1, max: 1 })) add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', edgeId: as.id, text: 'Multiplicity at ' + q(X.label) + ' on ' + q(as.name || (C.label + '–' + X.label)) + ' is ' + multStr(atX) + '; each ' + C.label + ' belongs to exactly 1 ' + X.label + '.' });
            if (!sameMult(atC, wantC)) add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', edgeId: as.id, text: 'Multiplicity at ' + q(C.label) + ' on ' + q(as.name || (C.label + '–' + X.label)) + ' is ' + multStr(atC) + '; the solution allows ' + multStr(wantC) + ' (' + refName + ' is ' + multStr(L.multA) + ' : ' + multStr(L.multB) + ').' });
          });
          return;
        }
        add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', classId: A.id, text: 'No association between ' + q(A.label) + ' and ' + q(B.label) + ' (solution: ' + L.name + ', with association class).' });
        return;
      }
      var as2 = assocsBetween(info, A, B)[0];
      if (!as2) { add({ sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', classId: A.id, text: 'No association between ' + q(A.label) + ' and ' + q(B.label) + ' (solution: ' + L.name + ').' }); return; }
      cmpMult(as2, A, L.multA, B, L.multB, refName, add);
    });
    // LDM: foreign keys like in the solution
    ref.fks.forEach(function (F) {
      var A = info.core[F.from], B = info.core[F.to];
      if (!A || !B) return;
      var ok = m.relationships.some(function (r) { return r.source === A.id && r.target === B.id; });
      var rev = m.relationships.some(function (r) { return r.source === B.id && r.target === A.id; });
      if (!ok) add({ sev: rev ? 'error' : 'deviation', area: 'solution', where: 'MLD', view: 'logical', classId: A.id, text: rev ? 'The foreign key between ' + q(A.label) + ' and ' + q(B.label) + ' is on the wrong side: ' + A.label + ' must reference ' + B.label + '.' : q(cName(A, 'logical')) + ' has no foreign key (arrow) to ' + q(cName(B, 'logical')) + '.' });
    });
  }

  function cmpMult(assoc, A, mA, B, mB, refName, add) {
    var sa = multAt(assoc, A), sb = multAt(assoc, B);
    var b = { sev: 'deviation', area: 'solution', where: 'MCD', view: 'conceptual', edgeId: assoc.id };
    if ((!sameMult(sa, mA) || !sameMult(sb, mB)) && sameMult(sa, mB) && sameMult(sb, mA)) {
      add(Object.assign({}, b, { text: 'Multiplicities on ' + q(assoc.name || refName) + ' are written on the wrong ends: ' + A.label + ' ' + multStr(sa) + ' / ' + B.label + ' ' + multStr(sb) + ', solution: ' + A.label + ' ' + multStr(mA) + ' / ' + B.label + ' ' + multStr(mB) + '.' }));
      return;
    }
    if (!sameMult(sa, mA)) add(Object.assign({}, b, { text: 'Multiplicity at ' + q(A.label) + ' on ' + q(assoc.name || refName) + ' is ' + multStr(sa) + ', solution: ' + multStr(mA) + '.' }));
    if (!sameMult(sb, mB)) add(Object.assign({}, b, { text: 'Multiplicity at ' + q(B.label) + ' on ' + q(assoc.name || refName) + ' is ' + multStr(sb) + ', solution: ' + multStr(mB) + '.' }));
  }

  function typeCompare(type, params, ra, nm, base, add) {
    if (!type || !ra.type) return;
    var c1 = category(type), c2 = category(ra.type);
    if (c1 !== c2 && c1 !== '?' && c2 !== '?') { add(Object.assign({}, base, { sev: 'deviation', text: nm + ' is ' + type + '; the solution uses ' + ra.type + '.' })); return; }
    var l1 = length(type, params), l2 = length(ra.type);
    if (l1 && l2 && l1 < l2) add(Object.assign({}, base, { sev: 'minor', text: nm + ' is ' + type + ', shorter than in the solution (' + ra.type + ').' }));
  }

  function entityHint(k) {
    return { users: 'users must be stored', stations: 'charging stations must be stored', ports: 'ports must be stored', locations: 'locations must be stored', activations: 'port activations must be stored' }[k] || 'required';
  }

  // ======================================================== SQL checks
  function locator(text, parsed) {
    var starts = [0];
    for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    function lineAt(off) {
      var lo = 0, hi = starts.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo + 1;
    }
    return function (table, needle) {
      var t = (table || '').toLowerCase();
      var stmts = parsed.statements.filter(function (s) { return (s.name || '').toLowerCase() === t && (s.kind === 'table' || s.kind === 'alter' || s.kind === 'view'); });
      if (needle) {
        for (var k = 0; k < stmts.length; k++) {
          var seg = text.slice(stmts[k].start, stmts[k].end);
          var idx = seg.indexOf('`' + needle + '`');
          if (idx < 0) { var re = new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'); var mm = re.exec(seg); idx = mm ? mm.index : -1; }
          if (idx >= 0) return lineAt(stmts[k].start + idx);
        }
      }
      return stmts.length ? stmts[0].line : null;
    };
  }

  function checkSqlNaming(p, loc, add) {
    var lowerAll = p.tables.length > 1 && p.tables.every(function (t) { return t.name === t.name.toLowerCase(); });
    p.tables.forEach(function (t) {
      var n = t.name;
      var b = { sev: 'convention', area: 'naming', where: 'SQL', table: n, line: loc(n), rule: 'sql.table' };
      tick('sql.table');
      // association table (composite PK made only of foreign keys): it repeats the
      // association name, which is lowerCamelCase by convention
      var fkColSet = {};
      t.foreignKeys.forEach(function (f) { f.columns.forEach(function (c) { fkColSet[c.toLowerCase()] = 1; }); });
      var assocTable = t.primaryKey.length > 1 && t.primaryKey.every(function (c) { return fkColSet[c.toLowerCase()]; });
      if (!ascii(n)) add(Object.assign({}, b, { text: 'Table name ' + q(n) + ' contains spaces or special characters.' }));
      else if (/^tbl/i.test(n)) add(Object.assign({}, b, { text: 'Table ' + q(n) + ' has a "tbl" prefix; tables keep the UpperCamelCase class name.' }));
      else if (assocTable && LCC.test(n)) { /* association table named after the association: fine */ }
      else if (!UCC.test(n)) {
        if (n === n.toLowerCase() && lowerAll) add(Object.assign({}, b, { sev: 'minor', text: 'Table ' + q(n) + ' is all lowercase (MySQL/MariaDB on Windows lowercases table names by default); should be UpperCamelCase.' }));
        else add(Object.assign({}, b, { text: 'Table name ' + q(n) + ' is not UpperCamelCase.' }));
      }
      var fkCols = {};
      t.foreignKeys.forEach(function (f) { f.columns.forEach(function (c) { fkCols[c.toLowerCase()] = f; }); });
      var pkCols = {}; t.primaryKey.forEach(function (c) { pkCols[c.toLowerCase()] = 1; });
      t.columns.forEach(function (c) {
        var cn = c.name || '', l = cn.toLowerCase();
        var cb = Object.assign({}, b, { line: loc(n, cn), rule: 'sql.colPrefix' });
        var isPk = !!pkCols[l], isFk = !!fkCols[l];
        tick('sql.colPrefix'); tick('sql.colCase');
        var want = isPk && isFk ? 'pkfk_' : isPk ? 'pk_' : isFk ? 'fk_' : '';
        var mm = /^(pkfk|pk|fk)_(.*)$/i.exec(cn);
        if (!ascii(cn)) { add(Object.assign({}, cb, { rule: 'sql.colCase', text: q(n + '.' + cn) + ' contains spaces or special characters.' })); return; }
        if (want && (!mm || mm[1].toLowerCase() + '_' !== want)) add(Object.assign({}, cb, { text: q(n + '.' + cn) + ' is a ' + (want === 'pkfk_' ? 'primary and foreign key' : want === 'pk_' ? 'primary key' : 'foreign key') + ' and should start with ' + want + '.' }));
        else if (!want && mm) add(Object.assign({}, cb, { text: q(n + '.' + cn) + ' starts with ' + mm[1] + '_ but is not ' + (mm[1].toLowerCase() === 'pk' ? 'the primary key' : 'a foreign key') + '.' }));
        var rest = mm ? mm[2] : cn;
        if (rest.split('_').some(function (x) { return x && !LCC.test(x); })) add(Object.assign({}, cb, { rule: 'sql.colCase', text: q(n + '.' + cn) + (mm ? ': the parts after the prefix must be lowerCamelCase.' : ' is not lowerCamelCase.') }));
        if (isPk && t.primaryKey.length === 1 && c.autoIncrement && mm && mm[1].toLowerCase() === 'pk') {
          // surrogate key: pk_<table in lowerCamelCase>; when the server lowercased the
          // table name we can only compare case-insensitively
          var bareT = stripTbl(n), wantRest = lcFirst(bareT);
          var okKey = UCC.test(bareT) ? rest === wantRest : rest.toLowerCase() === bareT.toLowerCase() && LCC.test(rest);
          tick('sql.surrogate');
          if (!okKey) add(Object.assign({}, cb, { rule: 'sql.surrogate', text: 'Surrogate key ' + q(cn) + ' should be pk_' + (UCC.test(bareT) ? wantRest : '<table in lowerCamelCase>') + '.' }));
        }
        if (isFk && !isPk && mm) {
          var f = fkCols[l];
          var target = (f.refTableName || f.refTable || '').replace(/^tbl_?/i, '');
          var first = (rest.split('_')[0] || '').toLowerCase();
          var refPk = bareName((f.refColumns || [])[0] || '');
          tick('sql.fkName');
          if (first !== target.toLowerCase() && first !== refPk) add(Object.assign({}, cb, { rule: 'sql.fkName', text: q(n + '.' + cn) + ' references ' + q(f.refTableName || f.refTable) + '; the name should be fk_' + lcFirst(target) + '_<verb>.' }));
          else if (tick('sql.fkVerb') || rest.split('_').length < 2) add(Object.assign({}, cb, { rule: 'sql.fkVerb', sev: 'minor', text: q(n + '.' + cn) + ' has no association verb (convention: fk_' + lcFirst(target) + '_<verb>).' }));
        }
      });
      // FK constraints: fkc_<Source>_<verb>_<Target>
      t.foreignKeys.forEach(function (f) {
        if (f.inline) return;
        var tgt = f.refTableName || f.refTable || '';
        var nm = f.name || '';
        var cb = Object.assign({}, b, { line: loc(n, nm || f.columns[0]), rule: 'sql.fkc' });
        tick('sql.fkc');
        if (!nm) add(Object.assign({}, cb, { text: 'Foreign key on ' + q(n + '.' + f.columns.join(',')) + ' has no constraint name; use fkc_' + n + '_<verb>_' + tgt + '.' }));
        else if (!/^fkc_/.test(nm)) add(Object.assign({}, cb, { text: 'Constraint ' + q(nm) + ' should be named fkc_' + n + '_<verb>_' + tgt + '.' }));
        else if (nm.toLowerCase().indexOf(tgt.toLowerCase()) < 0) add(Object.assign({}, cb, { text: 'Constraint ' + q(nm) + ' should end with the target table (' + tgt + ').' }));
        else if (nm.toLowerCase().indexOf('fkc_' + n.toLowerCase() + '_') !== 0 && !/^pkfk_/i.test(f.columns[0])) add(Object.assign({}, cb, { text: 'Constraint ' + q(nm) + ' should start with the source table: fkc_' + n + '_<verb>_' + tgt + '.' }));
      });
      // unique indexes: idx_unique_<field>
      t.uniques.forEach(function (u) {
        var nm = u.inline ? '' : (u.name || '');
        var cb = Object.assign({}, b, { line: loc(n, nm || u.columns[0]), rule: 'sql.idx' });
        tick('sql.idx');
        if (!/^idx_unique_/.test(nm)) add(Object.assign({}, cb, { text: 'Unique index ' + (nm ? q(nm) + ' ' : '') + 'on (' + u.columns.join(', ') + ') should be named idx_unique_' + lcFirst(u.columns.length === 1 ? u.columns[0] : u.columns.map(function (x) { return x.replace(/^(pkfk|pk|fk)_/, ''); }).join('_')) + '.' }));
      });
      t.indexes.forEach(function (ix) {
        var nm = ix.name || '';
        if (!nm) return;
        var auto = t.foreignKeys.some(function (f) { return f.name === nm || (f.columns.length === 1 && f.columns[0] === nm); });
        if (auto) return;
        tick('sql.idx');
        if (!/^idx_/.test(nm)) add(Object.assign({}, b, { line: loc(n, nm), rule: 'sql.idx', text: 'Index ' + q(nm) + ' should be named idx_<type>_<field>.' }));
      });
    });
    p.views.forEach(function (v) {
      tick('sql.objects');
      if (!/^vw_[a-z][A-Za-z0-9]*$/.test(v.name)) add({ rule: 'sql.objects', sev: 'convention', area: 'naming', where: 'SQL', table: v.name, line: v.line, text: 'View ' + q(v.name) + ' should be vw_ + lowerCamelCase (e.g. vw_portStatus).' });
    });
    p.routines.forEach(function (r) {
      var pre = { procedure: 'sp_', function: 'fn_', trigger: 'tr_' }[r.kind];
      if (pre) tick('sql.objects');
      if (pre && r.name.indexOf(pre) !== 0) add({ rule: 'sql.objects', sev: 'convention', area: 'naming', where: 'SQL', line: r.line, text: r.kind + ' ' + q(r.name) + ' should start with ' + pre + '.' });
    });
  }

  function compareSql(p, loc, ref, add, noModel) {
    var ents = SqlParse.detectEntities(p.tables.map(function (t) { return t.name; }));
    var core = {};
    ents.forEach(function (e) { if (e.matches.length) core[e.key] = p.byName[e.matches[0].toLowerCase()]; });
    Object.keys(ref.entities).forEach(function (k) {
      var re = ref.entities[k];
      var t = core[k];
      if (!t) { add({ sev: 'deviation', area: 'solution', where: 'SQL', text: 'No table for ' + q(re.label) + ' (solution) – ' + entityHint(k) + '.' }); return; }
      re.attrs.forEach(function (ra) {
        var col = findAttr(t.columns, ra.name, function (c) { return [c.name]; }, { table: t.name });
        if (!col) { if (noModel) add({ sev: 'deviation', area: 'solution', where: 'SQL', table: t.name, line: loc(t.name), text: q(t.name) + ' has no column for ' + q(ra.name) + ' (solution: ' + re.label + '.' + ra.name + ').' }); return; }
        var b = { area: 'solution', where: 'SQL', table: t.name, line: loc(t.name, col.name) };
        var nm = q(t.name + '.' + col.name);
        if (ra.unique && !col.isUnique && !col.isPK) add(Object.assign({}, b, { sev: 'deviation', text: nm + ' has no UNIQUE constraint (solution: ' + re.label + '.' + ra.name + ' is unique).' }));
        if (!ra.nullable && col.nullable && !col.isPK) add(Object.assign({}, b, { sev: 'minor', text: nm + ' allows NULL; the solution has it NOT NULL.' }));
        typeCompare(col.type, null, ra, nm, b, add);
      });
    });
    ref.fks.forEach(function (F) {
      var A = core[F.from], B = core[F.to];
      if (!A || !B) return;
      var ok = A.foreignKeys.some(function (f) { return (f.refTable || '').toLowerCase() === B.name.toLowerCase(); });
      if (!ok) {
        var rev = B.foreignKeys.some(function (f) { return (f.refTable || '').toLowerCase() === A.name.toLowerCase(); });
        add({ sev: rev ? 'error' : 'deviation', area: 'solution', where: 'SQL', table: A.name, line: loc(A.name), text: rev ? 'Foreign key on the wrong side: ' + q(B.name) + ' references ' + q(A.name) + ', but ' + A.name + ' must reference ' + B.name + '.' : q(A.name) + ' has no FOREIGN KEY to ' + q(B.name) + ' (solution: ' + ref.entities[F.from].label + ' → ' + ref.entities[F.to].label + ').' });
      }
    });
  }

  var api = { analyze: analyze, buildReference: buildReference, parseMult: parseMult, multStr: multStr, VIEW_OF: VIEW_OF };
  root.Checks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
