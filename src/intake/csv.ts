/**
 * CSV primitives shared by the node-side intake pipeline and the browser-side sheet importer.
 * Dependency-free on purpose (no `node:` imports) so the Studio's web bundle can use the exact
 * same parser the engine ingests with — a spreadsheet must not mean two different things
 * depending on which side of the wire looked at it.
 */

/** Detect comma, semicolon, or tab on the first delimited record, ignoring quoted contents. */
function detectDelimiter(text: string): string {
	const counts = new Map([
		[",", 0],
		[";", 0],
		["\t", 0],
	]);
	let quoted = false;
	let fieldStart = true;
	for (let i = 0; i <= text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') i++;
				else quoted = false;
			}
			continue;
		}
		if (ch === '"' && fieldStart) quoted = true;
		else if (ch === "\n" || ch === undefined) {
			const best = [...counts].sort((a, b) => b[1] - a[1])[0];
			if (best && best[1] > 0) return best[0];
			fieldStart = true;
		} else if (counts.has(ch)) {
			counts.set(ch, (counts.get(ch) ?? 0) + 1);
			fieldStart = true;
		} else if (ch !== " ") fieldStart = false;
	}
	return ",";
}

/** Record-aware delimited text parser; accepts Excel sep declarations and rejects truncated quotes. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let hasField = false;
	let s = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	const declaration = s.match(/^sep=([,;\t])\n/i);
	if (declaration) s = s.slice(declaration[0].length);
	const delimiter = declaration?.[1] ?? detectDelimiter(s);
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
		} else if (ch === '"' && field.trim() === "" && !hasField) {
			inQuotes = true;
			hasField = true;
			field = "";
		} else if (ch === delimiter) {
			row.push(field);
			field = "";
			hasField = false;
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			hasField = false;
		} else {
			field += ch;
		}
	}
	if (inQuotes) throw new Error("Unterminated quoted CSV field");
	if (field !== "" || row.length > 0 || hasField) {
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
