/* Prism snippet — one line install:
   <script defer src="https://YOUR_HOST/snippet.js" data-site="yoursite"></script>
   Identity in a first-party cookie, decisions from /api/decide, DOM ops applied
   post-paint, impressions + conversions beaconed back. SPA-aware: re-decides on
   client-side navigation and re-applies variants if the framework re-renders. */
(function () {
  "use strict";
  var script = document.currentScript;
  var origin = script.getAttribute("data-host") || new URL(script.src).origin;
  var site = script.getAttribute("data-site") || location.hostname;
  var writeKey = script.getAttribute("data-key") || null; // optional anti-poisoning key
  var COOKIE = script.getAttribute("data-cookie") || "prism_vid"; // white-label override

  // ---- identity: first-party cookie, 400 days ----
  function getCookie(n) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v) {
    document.cookie = n + "=" + encodeURIComponent(v) + ";max-age=34560000;path=/;samesite=lax";
  }
  var vid = getCookie(COOKIE);
  if (!vid) {
    vid = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    setCookie(COOKIE, vid);
  }

  // ---- local variant cache (survives reloads, cuts decision latency) ----
  var cacheKey = (script.getAttribute("data-cookie") || "prism") + "_cache_" + site;
  function readCache() {
    try { return JSON.parse(localStorage.getItem(cacheKey) || "null"); } catch (e) { return null; }
  }
  function writeCache(d) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), decisions: d })); } catch (e) {}
  }

  // ---- DOM ops ----
  // Insert ops tag their output so re-application (after a framework re-render)
  // can remove the old copy instead of duplicating it.
  function clearOwned(el) {
    [el.previousElementSibling, el.nextElementSibling].forEach(function (sib) {
      if (sib && sib.getAttribute && sib.getAttribute("data-prism-owned") === "1") sib.remove();
    });
    el.querySelectorAll("[data-prism-owned]").forEach(function (n) { n.remove(); });
  }
  function applyOps(el, ops) {
    clearOwned(el);
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      try {
        if (o.op === "html") el.innerHTML = o.html;
        else if (o.op === "text") el.textContent = o.text;
        else if (o.op === "insertBefore" || o.op === "insertAfter") {
          var pos = o.op === "insertBefore" ? "beforebegin" : "afterend";
          var doc = document.createElement("template");
          doc.innerHTML = o.html.trim();
          for (var n = 0; n < doc.content.children.length; n++) {
            doc.content.children[n].setAttribute("data-prism-owned", "1");
          }
          el.insertAdjacentHTML(pos, doc.innerHTML);
        }
        else if (o.op === "remove") el.remove();
        else if (o.op === "setAttr") el.setAttribute(o.name, o.value);
        else if (o.op === "reorder") {
          var parent = el.parentNode;
          o.order.forEach(function (sel) {
            var child = el.querySelector(sel) || parent.querySelector(sel);
            if (child) el.appendChild(child);
          });
        }
      } catch (e) { /* a bad op must never break the host page */ }
    }
  }

  // ---- events ----
  var pending = [];
  function track(variantId, selector, type) {
    pending.push({ variantId: variantId, selector: selector, type: type });
  }
  function headers(extra) {
    var h = { "content-type": "application/json" };
    if (writeKey) h["x-prism-key"] = writeKey;
    for (var k in extra) h[k] = extra[k];
    return h;
  }
  function flush(sync) {
    if (!pending.length) return;
    var payload = JSON.stringify({ site: site, visitorId: vid, events: pending.splice(0) });
    // sendBeacon can't send x-prism-key, so a write key forces a keepalive fetch.
    if (sync && navigator.sendBeacon && !writeKey) {
      navigator.sendBeacon(origin + "/api/events", new Blob([payload], { type: "application/json" }));
    } else {
      fetch(origin + "/api/events", { method: "POST", headers: headers(), body: payload, keepalive: true }).catch(function () {});
    }
  }
  addEventListener("pagehide", function () { flush(true); });
  setInterval(flush, 5000);

  // ---- conversions: any element marked data-prism-convert ----
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-prism-convert]");
    if (t) {
      // credit the variant on the named element (the CTA may sit outside it)
      var sel = t.getAttribute("data-prism-convert") || guessSelector(t);
      var target = null;
      try { target = document.querySelector(sel); } catch (err) {}
      track(t.getAttribute("data-prism-variant") ? +t.getAttribute("data-prism-variant") : currentVariantFor(target || t), sel, "conversion");
      flush(false);
    }
  }, true);

  var applied = []; // {selector, variantId, el, ops}
  function currentVariantFor(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el && applied[i].el.contains(el)) return applied[i].variantId;
    return null;
  }
  function guessSelector(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el && applied[i].el.contains(el)) return applied[i].selector;
    return el.id ? "#" + el.id : el.tagName.toLowerCase();
  }

  window.__prismApplied = applied; // debug/introspection handle

  function applyDecisions(decisions) {
    decisions.forEach(function (d) {
      if (d.control) { track(null, d.selector, "impression"); return; } // holdout: measure, don't touch
      var el = document.querySelector(d.selector);
      if (!el) return;
      if (el.getAttribute("data-prism-variant") === String(d.variantId)) return; // already applied
      applyOps(el, d.ops);
      el.setAttribute("data-prism-variant", d.variantId);
      applied.push({ selector: d.selector, variantId: d.variantId, el: el, ops: d.ops, fingerprint: el.innerHTML });
      track(d.variantId, d.selector, "impression");
    });
    flush(false);
  }

  // Hydration / framework re-render guard: if a personalized element's content was
  // replaced (React re-rendered it), re-apply the variant ops. We fingerprint the
  // element's innerHTML after applying; any later change means the framework owns
  // the DOM again and the variant is gone.
  if (window.MutationObserver) {
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled || !applied.length) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        for (var i = 0; i < applied.length; i++) {
          var a = applied[i];
          var el = document.querySelector(a.selector);
          if (el && el.innerHTML !== a.fingerprint) {
            applyOps(el, a.ops);
            el.setAttribute("data-prism-variant", a.variantId);
            a.el = el;
            a.fingerprint = el.innerHTML;
          }
        }
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // fresh: skip the cache and apply the server's answer. A truthy timestamp from
  // requestAnimationFrame must not count, so callers pass true explicitly.
  function decide(fresh) {
    var cached = fresh ? null : readCache();
    if (cached && Date.now() - cached.ts < 300000) applyDecisions(cached.decisions);
    else cached = null;

    return fetch(origin + "/api/decide", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ visitorId: vid, site: site }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        writeCache(res.decisions);
        if (!cached) applyDecisions(res.decisions);
      })
      .catch(function () {}); // fail open: visitors see the default page
  }

  function decideAfterPaint() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      requestAnimationFrame(function () { decide(); });
    } else {
      document.addEventListener("DOMContentLoaded", function () { requestAnimationFrame(function () { decide(); }); });
    }
  }
  decideAfterPaint();

  // SPA support: re-decide on client-side navigation (pushState / replaceState / popstate).
  var lastUrl = location.href;
  function onNav() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    applied = [];
    // Cache survives navigation so repeat views stay instant; identify() still
    // invalidates it explicitly when traits change.
    decide();
  }
  ["pushState", "replaceState"].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      onNav();
      return r;
    };
  });
  addEventListener("popstate", onNav);

  // Public API: prism.identify({orders: 2, affinity: 'woody'}) — host site enriches the profile.
  // Re-decide only after the server has the traits; resolves once the new decision is applied.
  window.prism = {
    identify: function (traits) {
      try { localStorage.removeItem(cacheKey); } catch (e) {}
      return fetch(origin + "/api/identify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ visitorId: vid, site: site, traits: traits }),
      }).then(function (r) {
        return decide(true).then(function () { return r; });
      });
    },
    convert: function (selector) {
      track(currentVariantFor(document.querySelector(selector) || document.body), selector, "conversion");
      flush(false);
    },
    redecide: function () { return decide(true); },
    visitorId: vid,
  };
})();
