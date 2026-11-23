/**
 * Static test accounts for the public Sauce Demo site.
 *
 * These are the sample site's own published demo credentials, not secrets.
 * Anything environment-specific or genuinely sensitive belongs in an env
 * variable, never here.
 */

/** Structural shape that any credential pair satisfies. */
export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/**
 * `as const` freezes the values AND narrows them to literal types, so
 * `users.standard.username` has the type `'standard_user'` rather than
 * `string`.
 *
 * `satisfies` then checks every entry against `Credentials` *without*
 * widening those literals back to `string` -- which is exactly what a plain
 * type annotation (`const users: Record<string, Credentials> = ...`) would
 * have done. Verified: misspelling `username` as `usernam` here fails with
 * TS2561 at compile time instead of surfacing as `undefined` inside a test.
 */
export const users = {
  standard: { username: 'standard_user', password: 'secret_sauce' },
  invalid: { username: 'invalid_user', password: 'wrong_password' },
} as const satisfies Record<string, Credentials>;

/** `'standard' | 'invalid'` -- derived from the data, so it cannot drift. */
export type UserKey = keyof typeof users;

/**
 * The union of the concrete user objects above. Derived rather than
 * hand-written: adding a user to `users` extends this type automatically,
 * and there is no second place to forget to update.
 */
export type User = (typeof users)[UserKey];
