/* Prism snippet. Install:
   <script defer src="https://YOUR_HOST/snippet.js" data-site="yoursite" data-selectors="#hero"></script>
   Plus a few inline lines in <head> (see the landing page) that hide those
   selectors before first paint. The hide ends when the decision is applied, or
   when data-timeout (default 800ms) fires. A late or failed response does not
   swap the page after that: the visitor keeps the default. Identity in a
   first-party cookie, impressions + conversions beaconed back. SPA-aware. */
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

  // Selectors the merchant listed. The inline head script hides these before
  // paint; we hide them here too when that script is absent. Unsafe CSS is dropped.
  function safeSelectors() {
    var out = [], parts = (script.getAttribute("data-selectors") || "").split(",");
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i].replace(/^\s+|\s+$/g, "");
      if (!s || s.length > 200 || /[{}<>\\]/.test(s)) continue;
      out.push(s);
    }
    return out;
  }
  function veiling() { return safeSelectors().length > 0; }
  function timeoutMs() {
    var n = +script.getAttribute("data-timeout");
    return n > 0 ? n : 800;
  }
  var cycle = 0;
  function liftVeil() {
    clearTimeout(window.__prismVeilTimer);
    window.__prismVeilTimer = null;
    var st = document.getElementById("prism-veil");
    if (st) st.remove();
  }
  function showVeil() {
    var sels = safeSelectors();
    if (!sels.length) return;
    var st = document.getElementById("prism-veil");
    if (!st) {
      st = document.createElement("style");
      st.id = "prism-veil";
      (document.head || document.documentElement).appendChild(st);
    }
    var css = "";
    for (var i = 0; i < sels.length; i++) css += sels[i] + "{visibility:hidden !important}";
    st.textContent = css;
  }
  function arm(my, ms) {
    clearTimeout(window.__prismVeilTimer);
    window.__prismVeilTimer = setTimeout(function () {
      if (my !== cycle) return;
      window.__prismVeilTimedOut = true;
      var st = document.getElementById("prism-veil");
      if (st) st.remove();
    }, ms);
  }
  function beginWait() {
    cycle += 1;
    window.__prismVeilTimedOut = false;
    showVeil();
    var ms = timeoutMs();
    window.__prismVeilUntil = Date.now() + ms;
    arm(cycle, ms);
    return cycle;
  }
  // The head script already started the clock. Keep its deadline.
  function adoptWait() {
    cycle += 1;
    var my = cycle;
    var until = window.__prismVeilUntil;
    var left = typeof until === "number" ? until - Date.now() : timeoutMs();
    if (!(left > 0)) {
      window.__prismVeilTimedOut = true;
      liftVeil();
      return my;
    }
    arm(my, left);
    return my;
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
  function track(variantId, selector, type, audienceKey) {
    var ev = { variantId: variantId, selector: selector, type: type };
    if (audienceKey) ev.audienceKey = audienceKey;
    pending.push(ev);
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
      var credited = target || t;
      track(t.getAttribute("data-prism-variant") ? +t.getAttribute("data-prism-variant") : currentVariantFor(credited), sel, "conversion", audienceFor(credited) || controls[sel] || null);
      flush(false);
    }
  }, true);

  var applied = []; // {selector, variantId, audienceKey, el, ops}
  var controls = {}; // selector -> audienceKey, for holdout conversions
  function currentVariantFor(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el && applied[i].el.contains(el)) return applied[i].variantId;
    return null;
  }
  function audienceFor(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el && applied[i].el.contains(el)) return applied[i].audienceKey || null;
    return null;
  }
  function guessSelector(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el && applied[i].el.contains(el)) return applied[i].selector;
    return el.id ? "#" + el.id : el.tagName.toLowerCase();
  }

  window.__prismApplied = applied; // debug/introspection handle

  function applyDecisions(decisions) {
    decisions.forEach(function (d) {
      if (d.control) { controls[d.selector] = d.audienceKey || null; track(null, d.selector, "impression", d.audienceKey); return; } // holdout: measure, don't touch
      var el = document.querySelector(d.selector);
      if (!el) return;
      if (el.getAttribute("data-prism-variant") === String(d.variantId)) return; // already applied
      applyOps(el, d.ops);
      el.setAttribute("data-prism-variant", d.variantId);
      applied.push({ selector: d.selector, variantId: d.variantId, audienceKey: d.audienceKey || null, el: el, ops: d.ops, fingerprint: el.innerHTML });
      track(d.variantId, d.selector, "impression", d.audienceKey);
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

  // The visitor already saw the default. Record holdout impressions only.
  // A treatment impression would claim we showed a variant we never painted.
  function noteUnshown(decisions) {
    if (!decisions) return;
    for (var i = 0; i < decisions.length; i++) {
      var d = decisions[i];
      if (!d || !d.control) continue;
      controls[d.selector] = d.audienceKey || null;
      track(null, d.selector, "impression", d.audienceKey);
    }
    flush(false);
  }

  // fresh: skip the cache and apply the server's answer. A truthy timestamp from
  // requestAnimationFrame must not count, so callers pass true explicitly.
  // With data-selectors, listed sections stay hidden until this applies, or until
  // the timeout reveals the default. After that reveal, this pageview does not swap.
  function decide(fresh) {
    var warm = null;
    if (!fresh) {
      var cached = readCache();
      if (cached && Date.now() - cached.ts < 300000) warm = cached;
    }

    var my = cycle;
    var skipPaint = false;
    if (veiling()) {
      if (window.__prismVeilTimedOut && !fresh) skipPaint = true;
      else if (!warm) {
        if (!fresh && document.getElementById("prism-veil")) {
          my = adoptWait();
          if (window.__prismVeilTimedOut) skipPaint = true;
        } else my = beginWait();
      }
    }

    if (warm && !skipPaint && !window.__prismVeilTimedOut) {
      applyDecisions(warm.decisions);
      liftVeil();
    }

    return fetch(origin + "/api/decide", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ visitorId: vid, site: site }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var decisions = res && Array.isArray(res.decisions) ? res.decisions : [];
        // A newer decide() owns this pageview. Drop the stale body, cache included.
        if (veiling() && my !== cycle) return;
        writeCache(decisions);
        if (skipPaint || window.__prismVeilTimedOut) {
          noteUnshown(decisions);
          return;
        }
        if (warm) return;
        applyDecisions(decisions);
        liftVeil();
      })
      .catch(function () {
        if (my !== cycle) return;
        if (!warm) liftVeil(); // fail open: a dead API shows the default page
      });
  }

  function decideAfterPaint() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      requestAnimationFrame(function () { decide(); });
    } else {
      document.addEventListener("DOMContentLoaded", function () { requestAnimationFrame(function () { decide(); }); });
    }
  }
  if (veiling()) decide(false);
  else decideAfterPaint();

  // SPA support: re-decide on client-side navigation (pushState / replaceState / popstate).
  var lastUrl = location.href;
  function onNav() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    applied = [];
    controls = {};
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
      var el = document.querySelector(selector) || document.body;
      track(currentVariantFor(el), selector, "conversion", audienceFor(el) || controls[selector] || null);
      flush(false);
    },
    redecide: function () { return decide(true); },
    visitorId: vid,
  };
})();
