// Pure text helpers. No I/O.

// Makes text easy to match against: lower case, punctuation turned into
// spaces, repeated spaces collapsed. "Refund  NOT received!!" becomes
// "refund not received".
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ") // anything that is not a letter or digit
    .trim();
}

// Finds a booking reference in free text, so a requester who writes
// "problem with TBOH 1000042" does not also have to fill in a TBOH field.
// Accepts "TBOH1000042", "tboh-1000042", "TBOH 1000042" and "TBOH: 1000042".
// The part after TBOH must be 6 to 12 letters or digits and contain a digit,
// so a sentence like "the TBOH number is missing" does not match "number".
const TBOH_PATTERN = /\bTBOH[\s:#-]{0,3}([A-Z0-9]{6,12})\b/gi;

export function extractTboh(text: string): string | null {
  for (const match of text.matchAll(TBOH_PATTERN)) {
    const reference = match[1]!.toUpperCase();
    if (/\d/.test(reference)) {
      // Keep the separator if the writer used a dash, because stored
      // references look like either TBOH1000042 or TBOH-9F3A2C1B.
      const hasDash = match[0].includes("-");
      return hasDash ? `TBOH-${reference}` : `TBOH${reference}`;
    }
  }
  return null;
}
