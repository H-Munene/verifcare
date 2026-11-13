// Phone numbers are typed the way people in Kenya write them (0712345678) and sent as E.164
// (+254712345678), which Cognito requires. Same rules as the family app's kenyan_phone.dart.

/** E.164 for a Kenyan mobile number written as 07..., 01..., 254... or +254..., else null. */
export function toE164(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-()]/g, '');
  const national = /^(?:\+?254|0)?([17]\d{8})$/.exec(cleaned)?.[1];
  return national ? `+254${national}` : null;
}

/** A stored +254... number as the 07... form people type; anything else unchanged. */
export function toLocalPhone(e164: string): string {
  return /^\+254[17]\d{8}$/.test(e164) ? `0${e164.slice(4)}` : e164;
}

export const PHONE_HINT = 'A Kenyan mobile number, e.g. 0712345678';
