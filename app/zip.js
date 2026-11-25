/*
 * Minimal zip reader for the browser (no dependencies).
 * Supports "stored" and "deflate" entries (what Moodle and Windows produce),
 * using the built-in DecompressionStream. Zip64 is not supported.
 */
(function (root) {
  'use strict';

  var CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
    'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

  function decodeName(bytes, utf8) {
    if (utf8) return new TextDecoder('utf-8').decode(bytes);
    // not flagged as UTF-8: try UTF-8 anyway (many tools do this), else CP437
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* fall through */ }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i] < 128 ? String.fromCharCode(bytes[i]) : CP437[bytes[i] - 128];
    return s;
  }

  function dosDate(date, time) {
    var y = ((date >> 9) & 0x7f) + 1980, mo = (date >> 5) & 0x0f, d = date & 0x1f;
    var h = (time >> 11) & 0x1f, mi = (time >> 5) & 0x3f;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return y + '-' + p(mo || 1) + '-' + p(d || 1) + 'T' + p(h) + ':' + p(mi);
  }

  /** Read the central directory. Returns [{name, dir, size, method, modified, blob()}]. */
  function read(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var dv = new DataView(buf), u8 = new Uint8Array(buf);
      // find End Of Central Directory (signature 0x06054b50) within the last 64 KB
      var eocd = -1;
      for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('This is not a valid zip file.');
      var count = dv.getUint16(eocd + 10, true);
      var cdOffset = dv.getUint32(eocd + 16, true);
      if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('Zip64 archives (over 4 GB) are not supported.');
      var entries = [], p = cdOffset;
      for (var n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip file (central directory).');
        var flags = dv.getUint16(p + 8, true);
        var method = dv.getUint16(p + 10, true);
        var time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
        var csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
        var nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
        var local = dv.getUint32(p + 42, true);
        var name = decodeName(u8.subarray(p + 46, p + 46 + nlen), !!(flags & 0x800));
        entries.push(makeEntry(buf, dv, name, method, csize, usize, local, dosDate(date, time), !!(flags & 1)));
        p += 46 + nlen + elen + clen;
      }
      return entries;
    });
  }

  function makeEntry(buf, dv, name, method, csize, usize, local, modified, encrypted) {
    return {
      name: name, dir: /\/$/.test(name), size: usize, method: method, modified: modified, encrypted: encrypted,
      blob: function (type) {
        if (encrypted) return Promise.reject(new Error('Encrypted zip entries are not supported: ' + name));
        if (dv.getUint32(local, true) !== 0x04034b50) return Promise.reject(new Error('Damaged zip entry: ' + name));
        var start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        var data = new Blob([new Uint8Array(buf, start, csize)]);
        if (method === 0) return Promise.resolve(new Blob([data], { type: type || '' }));
        if (method !== 8) return Promise.reject(new Error('Unsupported compression in ' + name));
        if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser cannot unzip files. Please use a current Chrome, Edge or Firefox.'));
        var stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).blob().then(function (b) { return new Blob([b], { type: type || '' }); });
      }
    };
  }

  root.Zip = { read: read };
})(typeof window !== 'undefined' ? window : globalThis);
