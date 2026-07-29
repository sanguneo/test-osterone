/**
 * CSV primitives shared by the node-side intake pipeline and the browser-side sheet importer.
 * Dependency-free on purpose (no `node:` imports) so the Studio's web bundle can use the exact
 * same parser the engine ingests with — a spreadsheet must not mean two different things
 * depending on which side of the wire looked at it.
 */

/** RFC4180-ish CSV parser: handles quotes, embedded commas, and embedded newlines. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inQuotes) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

/** Quote a single cell only when it needs it (comma, quote, or newline inside). */
export function csvCell(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize a grid back to CSV text, quoting whatever needs quoting. */
export function toCsv(rows: readonly (readonly string[])[]): string {
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}
