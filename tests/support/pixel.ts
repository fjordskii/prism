import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type PixelOrderBody = {
  site: string;
  visitorId: string;
  events: { type: string; orderId: string; value: string; currency: string }[];
};

type Mapper = (checkout: unknown, visitorId: string | null | undefined) => PixelOrderBody | null;

export function loadOrderEventFromCheckout(dir = root): Mapper {
  const src = readFileSync(join(dir, "integrations/shopify/custom-pixel.js"), "utf8");
  return new Function(`${src}\nreturn orderEventFromCheckout;`)() as Mapper;
}

export function recordedCheckout(dir = root) {
  return JSON.parse(readFileSync(join(dir, "tests/fixtures/shopify-checkout-completed.json"), "utf8")) as {
    data: { checkout: { email?: string; order: { id: string }; totalPrice: { amount: number; currencyCode: string } } };
  };
}
