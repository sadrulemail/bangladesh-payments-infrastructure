/** JSON with `bigint` values written as decimal strings, the way amounts travel on the wire. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
