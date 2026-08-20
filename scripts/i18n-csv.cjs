function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  // CRLF is normalised for the WHOLE file, not just at row ends. Git checks
  // this file out with the platform's endings, and a carriage return that lands
  // inside a QUOTED cell stays in the text — so a multi-line string parsed here
  // stopped matching the same string re-read from source, and the gate reported
  // inventory rows as missing on a checkout where the very same commit passed.
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

module.exports = { parseCsv };
