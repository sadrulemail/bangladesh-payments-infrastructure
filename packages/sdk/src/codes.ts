/**
 * Short codes and references as they travel on chain. Institution ids, merchant ids, corridor ids
 * and business references are ASCII strings packed into bytes32, so they stay readable in events.
 */
import { type Hex, hexToString, keccak256, stringToHex, toHex } from "viem";

const PRINTABLE = /^[\x20-\x7e]+$/;
const MAX_CODE_LENGTH = 31;

const isPrintable = (text: string) => PRINTABLE.exec(text) !== null;

/** Packs a short ASCII code, such as "SURMA" or "AE-BD", into bytes32. */
export function toCode(text: string): Hex {
  if (!isPrintable(text) || text.length > MAX_CODE_LENGTH) {
    throw new RangeError(`"${text}" is not a printable ASCII code of at most ${MAX_CODE_LENGTH} characters`);
  }
  return stringToHex(text, { size: 32 });
}

/** Reads a bytes32 code back. Values that are not printable text are returned as hex. */
export function fromCode(value: Hex): string {
  if (BigInt(value) === 0n) return "";
  const text = hexToString(value, { size: 32 });
  return isPrintable(text) ? text : value;
}

/**
 * Packs a business reference into bytes32. A reference that fits is stored as text; a longer one is
 * replaced by its hash, which still gives the contracts a unique key.
 */
export function toReference(text: string): Hex {
  if (text === "") return toHex(0, { size: 32 });
  return isPrintable(text) && text.length <= MAX_CODE_LENGTH ? toCode(text) : keccak256(stringToHex(text));
}

/** Packs fixed-width ASCII such as a country ("BD"), a currency ("AED") or a purpose code ("FAMI"). */
export function toAscii(text: string, size: 2 | 3 | 4): Hex {
  if (!isPrintable(text) || text.length !== size) {
    throw new RangeError(`"${text}" is not ${size} printable ASCII characters`);
  }
  return stringToHex(text);
}

/** Reads fixed-width ASCII back. */
export function fromAscii(value: Hex): string {
  return hexToString(value).replace(/\0+$/, "");
}
