/* Prism order pixel for Shopify custom pixels.
   Settings > Customer events > Add custom pixel > paste this file.
   Set the three PRISM_ values, then Save and Connect.
   The storefront snippet must already set the prism_vid cookie.
   Docs: https://shopify.dev/docs/api/web-pixels-api/standard-events/checkout_completed */
var PRISM_HOST = "https://YOUR_HOST";
var PRISM_SITE = "yourstore";
var PRISM_COOKIE = "prism_vid";
var PRISM_WRITE_KEY = "";

function decimalString(amount) {
  if (typeof amount === "string") return amount.trim();
  if (typeof amount !== "number" || !isFinite(amount)) return "";
  return amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function orderEventFromCheckout(checkout, visitorId) {
  if (!checkout || !visitorId) return null;
  var order = checkout.order;
  var price = checkout.totalPrice;
  var currency = price && (price.currencyCode || checkout.currencyCode);
  var value = price ? decimalString(price.amount) : "";
  if (!order || order.id == null || order.id === "" || !value || !currency) return null;
  return {
    site: PRISM_SITE,
    visitorId: String(visitorId),
    events: [{
      type: "order",
      orderId: String(order.id),
      value: value,
      currency: String(currency)
    }]
  };
}

if (typeof analytics !== "undefined" && typeof browser !== "undefined") {
  analytics.subscribe("checkout_completed", function (event) {
    browser.cookie.get(PRISM_COOKIE).then(function (visitorId) {
      var checkout = event && event.data && event.data.checkout;
      var body = orderEventFromCheckout(checkout, visitorId);
      if (!body) return;
      var headers = { "content-type": "application/json" };
      if (PRISM_WRITE_KEY) headers["x-prism-key"] = PRISM_WRITE_KEY;
      fetch(PRISM_HOST.replace(/\/$/, "") + "/api/events", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body),
        keepalive: true
      });
    });
  });
}
