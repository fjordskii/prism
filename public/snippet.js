/* Prism snippet — one line install:
   <script defer src="https://YOUR_HOST/snippet.js" data-site="yoursite"></script>
   Identity in a first-party cookie, decisions from /api/decide, DOM ops applied
   post-paint, impressions + conversions beaconed back. */
(function () {
  "use strict";
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var site = script.getAttribute("data-site") || location.hostname;

  // ---- identity: first-party cookie, 400 days ----
  function getCookie(n) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(n, v) {
    document.cookie = n + "=" + encodeURIComponent(v) + ";max-age=34560000;path=/;samesite=lax";
  }
  var vid = getCookie("prism_vid");
  if (!vid) {
    vid = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    setCookie("prism_vid", vid);
  }

  // ---- local variant cache (survives reloads, cuts decision latency) ----
  var cacheKey = "prism_cache_" + site;
  function readCache() {
    try { return JSON.parse(localStorage.getItem(cacheKey) || "null"); } catch (e) { return null; }
  }
  function writeCache(d) {
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), decisions: d })); } catch (e) {}
  }

  // ---- DOM ops ----
  function applyOps(el, ops) {
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      try {
        if (o.op === "html") el.innerHTML = o.html;
        else if (o.op === "text") el.textContent = o.text;
        else if (o.op === "insertBefore") el.insertAdjacentHTML("beforebegin", o.html);
        else if (o.op === "insertAfter") el.insertAdjacentHTML("afterend", o.html);
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
  function flush(sync) {
    if (!pending.length) return;
    var payload = JSON.stringify({ site: site, visitorId: vid, events: pending.splice(0) });
    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon(origin + "/api/events", new Blob([payload], { type: "application/json" }));
    } else {
      fetch(origin + "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: true }).catch(function () {});
    }
  }
  addEventListener("pagehide", function () { flush(true); });
  setInterval(flush, 5000);

  // ---- conversions: any element marked data-prism-convert, else clicks on personalized regions ----
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-prism-convert]");
    if (t) {
      track(t.getAttribute("data-prism-variant") ? +t.getAttribute("data-prism-variant") : currentVariantFor(t), t.getAttribute("data-prism-convert") || guessSelector(t), "conversion");
      flush(false);
    }
  }, true);

  var applied = []; // {selector, variantId, el}
  function currentVariantFor(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el.contains(el)) return applied[i].variantId;
    return null;
  }
  function guessSelector(el) {
    for (var i = 0; i < applied.length; i++) if (applied[i].el.contains(el)) return applied[i].selector;
    return el.id ? "#" + el.id : el.tagName.toLowerCase();
  }

  function applyDecisions(decisions) {
    decisions.forEach(function (d) {
      var el = document.querySelector(d.selector);
      if (!el) return;
      applyOps(el, d.ops);
      el.setAttribute("data-prism-variant", d.variantId);
      applied.push({ selector: d.selector, variantId: d.variantId, el: el });
      track(d.variantId, d.selector, "impression");
    });
    flush(false);
  }

  function decide() {
    // Fast path: cached decisions from a prior pageview (< 5 min old) apply immediately.
    var cached = readCache();
    if (cached && Date.now() - cached.ts < 300000) applyDecisions(cached.decisions);

    fetch(origin + "/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId: vid, site: site }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        writeCache(res.decisions);
        if (!cached) applyDecisions(res.decisions);
      })
      .catch(function () {});
  }

  // Run after first paint — never block rendering.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    requestAnimationFrame(decide);
  } else {
    document.addEventListener("DOMContentLoaded", function () { requestAnimationFrame(decide); });
  }

  // Public API: prism.identify({orders: 2, affinity: 'woody'}) — host site enriches the profile.
  window.prism = {
    identify: function (traits) {
      return fetch(origin + "/api/identify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visitorId: vid, site: site, traits: traits }),
      }).then(function () { try { localStorage.removeItem(cacheKey); } catch (e) {} });
    },
    convert: function (selector) {
      track(currentVariantFor(document.querySelector(selector) || document.body), selector, "conversion");
      flush(false);
    },
    visitorId: vid,
  };
})();
