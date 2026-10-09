import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PixelOrderBody = {
  site: string;
  visitorId: string;
  events: { type: string; orderId: string; value: string; currency: string }[];
};

type Mapper = (checkout: unknown, visitorId: string | null | undefined) => PixelOrderBody | null;

export function loadOrderEventFromCheckout(root = join(import.meta.dir, "../..")): Mapper {
  const src = readFileSync(join(root, "integrations/shopify/custom-pixel.js"), "utf8");
  return new Function(`${src}\nreturn orderEventFromCheckout;`)() as Mapper;
}

export function recordedCheckout(root = join(import.meta.dir, "../..")) {
  return JSON.parse(readFileSync(join(root, "tests/fixtures/shopify-checkout-completed.json"), "utf8")) as {
    data: { checkout: { email?: string; order: { id: string }; totalPrice: { amount: number; currencyCode: string } } };
  };
}
