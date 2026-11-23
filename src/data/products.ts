/**
 * Product slugs as they appear in the `data-test` attributes of the Sauce
 * Demo inventory page, e.g. `data-test="add-to-cart-sauce-labs-backpack"`.
 *
 * This list was read off the live page rather than transcribed by hand --
 * note the last entry, which no one would guess correctly.
 */
export const PRODUCT_SLUGS = [
  'sauce-labs-backpack',
  'sauce-labs-bike-light',
  'sauce-labs-bolt-t-shirt',
  'sauce-labs-fleece-jacket',
  'sauce-labs-onesie',
  'test.allthethings()-t-shirt-(red)',
] as const;

/**
 * `(typeof TUPLE)[number]` is the array-to-union idiom: indexing a readonly
 * tuple type by `number` yields the union of its element types, here
 * `'sauce-labs-backpack' | 'sauce-labs-bike-light' | ...`.
 *
 * This is the answer to "does `addToCart(product: string)` lose type safety?"
 * -- it does, and this recovers it. A typo like `'sauce-labs-backpak'` is a
 * compile error, and editors autocomplete the real slugs. The maintenance
 * cost is one line per new product, paid only when the catalogue changes.
 */
export type ProductSlug = (typeof PRODUCT_SLUGS)[number];
