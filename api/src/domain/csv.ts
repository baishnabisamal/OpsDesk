// Turning values into CSV text. Pure, no I/O.
//
// RFC 4180 rules: a cell that contains a comma, a double quote or a line
// break is wrapped in double quotes, and any double quote inside it is
// doubled ("" stands for ").
//
// One extra rule for safety: CSV INJECTION. Spreadsheet programs treat a cell
// that starts with = + - @ (or a tab / carriage return) as a formula. A ticket
// subject like =HYPERLINK("http://evil",...) would become a live formula when
// a lead opens the export. Such cells get a leading apostrophe, which makes
// the spreadsheet show the text as text.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

// One line, ending in CRLF as RFC 4180 says.
export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}
