/* xterm.js writes its theme and cell sizes into <style> elements it creates. The dashboard's CSP
   (style-src 'self') refuses inline <style>, so this shim, loaded before xterm.js, hands it an inert
   element instead whose text goes into a constructable stylesheet (document.adoptedStyleSheets), which
   the CSP allows: the page never needs 'unsafe-inline'. Nothing else on the page creates <style>. */
(() => {
  'use strict';
  if (!('adoptedStyleSheets' in Document.prototype) || typeof CSSStyleSheet !== 'function') return;
  const make = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, opts) {
    if (String(tag).toLowerCase() !== 'style') return make.call(this, tag, opts);
    const doc = this;
    const el = make.call(this, 'mv-style', opts);
    el.hidden = true;
    const sheet = new CSSStyleSheet();
    let text = '';
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    const set = (v) => { text = String(v ?? ''); try { sheet.replaceSync(text); } catch { /* bad css: ignore like a browser would */ } };
    Object.defineProperties(el, {
      textContent: { get: () => text, set, configurable: true },
      innerText: { get: () => text, set, configurable: true },
      innerHTML: { get: () => text, set, configurable: true },
      sheet: { get: () => sheet, configurable: true },
      type: { value: 'text/css', writable: true, configurable: true },
      media: { value: '', writable: true, configurable: true },
      remove: { value: () => { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet); Element.prototype.remove.call(el); }, configurable: true },
    });
    return el;
  };
})();
