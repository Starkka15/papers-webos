/* Old Word documents (.doc, Word 97 to 2003): reads the binary file and builds
 * the page as HTML.
 *
 * The parts follow LibreOffice's reader for this format (sw/source/filter/ww8):
 *   container    the file is a "compound file", a small file system of streams
 *   pieces       <- WW8PLCFx_PCD     where the text is, and whether 1 or 2 bytes a character
 *   formatting   <- WW8PLCFx_Fc_FKP  512-byte pages listing character and paragraph
 *                                    formatting by position in the file
 *   properties   <- the "sprm" codes: each is a number saying what it sets, then a value
 *   styles       <- WW8Style         the style sheet, with "based on" inheritance
 *   lists        <- WW8ListManager   list definitions, for bullets and numbers
 *
 * Formatting ends up in the same shape Docx.js uses, so both draw with the same code.
 *
 * Not handled yet: pictures and drawings, headers and footers, footnotes, table
 * borders and shading as set in the file (tables get plain thin lines), sections
 * and page sizes, Word 6/95 files, password-protected files.
 */
PP.Doc = {
	// ---- bytes ---------------------------------------------------------------------

	u8: function(s, at) {
		return s.charCodeAt(at) & 0xFF;
	},

	u16: function(s, at) {
		return (s.charCodeAt(at) & 0xFF) | ((s.charCodeAt(at + 1) & 0xFF) << 8);
	},

	s16: function(s, at) {
		var v = this.u16(s, at);
		return v >= 0x8000 ? v - 0x10000 : v;
	},

	u32: function(s, at) {
		return ((s.charCodeAt(at) & 0xFF) | ((s.charCodeAt(at + 1) & 0xFF) << 8) |
			((s.charCodeAt(at + 2) & 0xFF) << 16)) + (s.charCodeAt(at + 3) & 0xFF) * 16777216;
	},

	// Windows-1252 differs from Unicode only in 0x80 to 0x9F.
	cp1252: [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152,
		0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161,
		0x203A, 0x0153, 0x9D, 0x017E, 0x0178],

	// ---- the container (compound file) ----------------------------------------------

	// Returns a function name -> the stream's bytes (or null), or null if this is not a compound file.
	container: function(data) {
		var self = this;
		if (data.length < 1536 || this.u32(data, 0) !== 0xE011CFD0 || this.u32(data, 4) !== 0xE11AB1A1) {
			return null;
		}
		var sectorSize = 1 << this.u16(data, 0x1E);
		var miniSize = 1 << this.u16(data, 0x20);
		var cutoff = this.u32(data, 0x38);
		var END = 0xFFFFFFFE;

		function sectorAt(n) {
			return (n + 1) * sectorSize;
		}

		// The allocation table: for each sector, the sector that follows it.
		var fatSectors = [];
		var i;
		for (i = 0; i < 109; i++) {
			var n = this.u32(data, 0x4C + i * 4);
			if (n < END - 1) {
				fatSectors.push(n);
			}
		}
		var difat = this.u32(data, 0x44);
		var guard = 0;
		while (difat < END - 1 && guard++ < 1000) {
			var base = sectorAt(difat);
			for (i = 0; i < sectorSize / 4 - 1; i++) {
				var m = this.u32(data, base + i * 4);
				if (m < END - 1) {
					fatSectors.push(m);
				}
			}
			difat = this.u32(data, base + sectorSize - 4);
		}
		var fat = [];
		for (i = 0; i < fatSectors.length; i++) {
			var at = sectorAt(fatSectors[i]);
			for (var j = 0; j < sectorSize / 4; j++) {
				fat.push(this.u32(data, at + j * 4));
			}
		}

		function chain(start, size) {
			var parts = [];
			var n = start;
			var steps = 0;
			var limit = Math.ceil(data.length / sectorSize) + 1;
			while (n < END - 1 && steps++ < limit) {
				parts.push(data.substr(sectorAt(n), sectorSize));
				n = fat[n];
				if (n === undefined) {
					break;
				}
			}
			var out = parts.join("");
			return size === undefined ? out : out.substring(0, size);
		}

		var dir = chain(this.u32(data, 0x30));
		var entries = {};
		var root = null;
		for (i = 0; i + 128 <= dir.length; i += 128) {
			var type = this.u8(dir, i + 0x42);
			var chars = Math.max(0, this.u16(dir, i + 0x40) / 2 - 1);
			var name = "";
			for (var k = 0; k < chars && k < 31; k++) {
				name += String.fromCharCode(this.u16(dir, i + k * 2));
			}
			var entry = {start: this.u32(dir, i + 0x74), size: this.u32(dir, i + 0x78)};
			if (type === 5) {
				root = entry;
			} else if (type === 2) {
				entries[name] = entry;
			}
		}

		// Small streams live inside one stream of their own, in 64-byte sectors.
		var mini = null;
		var miniFat = null;
		function miniChain(start, size) {
			if (mini === null) {
				mini = root ? chain(root.start, root.size) : "";
				var raw = chain(self.u32(data, 0x3C));
				miniFat = [];
				for (var q = 0; q + 4 <= raw.length; q += 4) {
					miniFat.push(self.u32(raw, q));
				}
			}
			var parts = [];
			var n = start;
			var steps = 0;
			while (n < END - 1 && steps++ < miniFat.length + 1) {
				parts.push(mini.substr(n * miniSize, miniSize));
				n = miniFat[n];
				if (n === undefined) {
					break;
				}
			}
			return parts.join("").substring(0, size);
		}

		return function(name) {
			var e = entries[name];
			if (!e) {
				return null;
			}
			return e.size < cutoff ? miniChain(e.start, e.size) : chain(e.start, e.size);
		};
	},

	// ---- opening -----------------------------------------------------------------------

	// callback(model) or callback(null, message)
	open: function(path, callback) {
		var self = this;
		PP.readBinary(path, function(data) {
			if (data === null) {
				callback(null, "The file could not be read.");
				return;
			}
			var model = null;
			var message = "";
			try {
				model = self.parse(data);
			} catch (e) {
				PP.log("doc: " + e + (e.stack ? " " + e.stack : ""));
				message = "Something in this document could not be read.";
			}
			if (model && model.error) {
				message = model.error;
				model = null;
			}
			callback(model, message);
		});
	},

	parse: function(data) {
		var stream = this.container(data);
		if (!stream) {
			// Some ".doc" files are really something else with the wrong name.
			if (/^\s*\{\\rtf/.test(data.substring(0, 20))) {
				return {error: "This is a Rich Text file with a .doc name. Papers cannot show those yet."};
			}
			if (data.substring(0, 2) === "PK") {
				return {error: "This is a newer Word document with a .doc name. Rename it to .docx to open it."};
			}
			return {error: "This does not look like a Word document."};
		}
		var wd = stream("WordDocument");
		if (!wd || this.u16(wd, 0) !== 0xA5EC) {
			return {error: "This does not look like a Word document."};
		}
		if (this.u16(wd, 2) < 193) {
			return {error: "This document was written by Word 95 or older. Papers cannot show those yet."};
		}
		var flags = this.u16(wd, 0x0A);
		if (flags & 0x0100) {
			return {error: "This document is protected with a password."};
		}
		var table = stream(flags & 0x0200 ? "1Table" : "0Table");
		if (!table) {
			return {error: "This document is damaged."};
		}
		var model = {wd: wd, table: table, textLength: this.u32(wd, 0x4C)};
		var self = this;
		// The file's index: pairs of (where, how long) in the table stream, 8 bytes each from 0x9A.
		function where(index) {
			return {at: self.u32(wd, 0x9A + index * 8), length: self.u32(wd, 0x9E + index * 8)};
		}
		model.styles = this.readStyles(table, where(1));
		model.chpRuns = this.readPages(wd, table, where(12), false);
		model.papRuns = this.readPages(wd, table, where(13), true);
		model.fonts = this.readFonts(table, where(15));
		model.pieces = this.readPieces(table, where(33));
		model.lists = this.readLists(table, where(73), where(74));
		if (!model.pieces.length) {
			return {error: "This document has no text that Papers could find."};
		}
		return model;
	},

	// ---- where the text is (the piece table) ------------------------------------------------

	readPieces: function(table, clx) {
		var pieces = [];
		var p = clx.at;
		var end = clx.at + clx.length;
		while (p < end) {
			var kind = this.u8(table, p);
			if (kind === 1) {
				p += 3 + this.u16(table, p + 1);
				continue;
			}
			if (kind !== 2) {
				break;
			}
			var size = this.u32(table, p + 1);
			var plc = p + 5;
			var count = Math.floor((size - 4) / 12);
			for (var i = 0; i < count; i++) {
				var fc = this.u32(table, plc + (count + 1) * 4 + i * 8 + 2);
				var compressed = fc >= 0x40000000;
				fc = fc % 0x40000000;
				pieces.push({
					start: this.u32(table, plc + i * 4),
					end: this.u32(table, plc + (i + 1) * 4),
					fc: compressed ? fc / 2 : fc,
					wide: !compressed
				});
			}
			break;
		}
		return pieces;
	},

	// ---- formatting by file position (the FKP pages) -------------------------------------------

	// Returns runs sorted by position: {from, to, at, length, istd}. "at" and "length"
	// locate the run's property codes in the WordDocument stream.
	readPages: function(wd, table, plc, paragraphs) {
		var runs = [];
		var count = Math.floor((plc.length - 4) / 8);
		for (var i = 0; i < count; i++) {
			var page = this.u32(table, plc.at + (count + 1) * 4 + i * 4) * 512;
			if (page + 512 > wd.length) {
				continue;
			}
			var n = this.u8(wd, page + 511);
			for (var k = 0; k < n; k++) {
				var run = {from: this.u32(wd, page + k * 4), to: this.u32(wd, page + (k + 1) * 4), at: 0, length: 0, istd: 0};
				var slot = page + (n + 1) * 4 + k * (paragraphs ? 13 : 1);
				var offset = this.u8(wd, slot) * 2;
				if (offset) {
					var at = page + offset;
					if (paragraphs) {
						var cb = this.u8(wd, at);
						var size;
						if (cb === 0) {
							size = this.u8(wd, at + 1) * 2;
							at += 2;
						} else {
							size = cb * 2 - 1;
							at += 1;
						}
						run.istd = this.u16(wd, at);
						run.at = at + 2;
						run.length = Math.max(0, size - 2);
					} else {
						run.at = at + 1;
						run.length = this.u8(wd, at);
					}
				}
				runs.push(run);
			}
		}
		runs.sort(function(a, b) { return a.from - b.from; });
		return runs;
	},

	// The run containing a file position; hint is where the last search ended.
	runAt: function(runs, fc, hint) {
		var i = hint || 0;
		if (i < runs.length && runs[i].from <= fc && fc < runs[i].to) {
			return i;
		}
		if (i + 1 < runs.length && runs[i + 1].from <= fc && fc < runs[i + 1].to) {
			return i + 1;
		}
		var lo = 0;
		var hi = runs.length - 1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (fc < runs[mid].from) {
				hi = mid - 1;
			} else if (fc >= runs[mid].to) {
				lo = mid + 1;
			} else {
				return mid;
			}
		}
		return -1;
	},

	// ---- property codes (sprms) ---------------------------------------------------------------

	colors: [undefined, "#000000", "#0000ff", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#ffff00", "#ffffff",
		"#000080", "#008080", "#008000", "#800080", "#800000", "#808000", "#808080", "#c0c0c0"],

	// How many bytes of value follow a code.
	valueSize: function(s, code, at) {
		switch (code >> 13) {
		case 0: case 1: return 1;
		case 2: case 4: case 5: return 2;
		case 3: return 4;
		case 7: return 3;
		default:
			if (code === 0xD608) {  // table definition: a two-byte length
				return this.u16(s, at) + 1;
			}
			if (code === 0xC615 && this.u8(s, at) === 255) {  // tab changes, long form
				var del = this.u8(s, at + 1);
				var add = this.u8(s, at + 2 + del * 4);
				return 3 + del * 4 + add * 3;
			}
			return 1 + this.u8(s, at);
		}
	},

	// On/off character properties: 0 off, 1 on, 0x80 as the style has it, 0x81 the opposite.
	flag: function(value, current) {
		if (value === 0x80) {
			return current;
		}
		if (value === 0x81) {
			return !current;
		}
		return value !== 0;
	},

	// Apply a list of codes from stream s to paragraph properties pap and character properties chp.
	apply: function(model, s, at, length, pap, chp) {
		var end = at + length;
		while (at + 2 <= end) {
			var code = this.u16(s, at);
			var v = at + 2;
			var size = this.valueSize(s, code, v);
			if (v + size > end + 1) {
				break;
			}
			switch (code) {
			// characters
			case 0x0835: chp.bold = this.flag(this.u8(s, v), chp.bold); break;
			case 0x0836: chp.italic = this.flag(this.u8(s, v), chp.italic); break;
			case 0x0837: chp.strike = this.flag(this.u8(s, v), chp.strike); break;
			case 0x083A: chp.smallCaps = this.flag(this.u8(s, v), chp.smallCaps); break;
			case 0x083B: chp.caps = this.flag(this.u8(s, v), chp.caps); break;
			case 0x083C: chp.hidden = this.flag(this.u8(s, v), chp.hidden); break;
			case 0x0855: chp.special = this.u8(s, v) !== 0; break;
			case 0x2A3E: chp.underline = this.u8(s, v) !== 0; break;
			case 0x4A43: chp.size = this.u16(s, v) / 2; break;
			case 0x2A42: chp.color = this.colors[this.u8(s, v)]; break;
			case 0x6870:
				chp.color = this.u8(s, v + 3) === 0xFF ? undefined : this.rgb(s, v);
				break;
			case 0x2A0C: chp.background = this.colors[this.u8(s, v)]; break;
			case 0x2A48:
				chp.vertical = this.u8(s, v) === 1 ? "superscript" : (this.u8(s, v) === 2 ? "subscript" : undefined);
				break;
			case 0x4A4F: chp.font = model.fonts[this.u16(s, v)]; break;
			case 0x4A30:
				// A character style: its formatting comes in at this point.
				var style = this.style(model, this.u16(s, v));
				for (var k in style.chp) {
					if (style.chp[k] !== undefined) {
						chp[k] = style.chp[k];
					}
				}
				break;
			// paragraphs
			case 0x2461: case 0x2403:
				pap.align = ["left", "center", "right", "justify", "justify"][this.u8(s, v)] || "left";
				break;
			case 0x845E: case 0x840F: pap.left = this.s16(s, v) / 20; break;
			case 0x8460: case 0x8411: pap.first = this.s16(s, v) / 20; break;
			case 0x845D: case 0x840E: pap.right = this.s16(s, v) / 20; break;
			case 0xA413: pap.before = this.u16(s, v) / 20; break;
			case 0xA414: pap.after = this.u16(s, v) / 20; break;
			case 0x6412:
				// A number of lines (in 240ths) or an exact or minimum height (in twips).
				var line = this.s16(s, v);
				pap.line = this.s16(s, v + 2) ? line / 240 : Math.abs(line) / 20 + "pt";
				break;
			case 0x2407: pap.pageBreak = this.u8(s, v) !== 0; break;
			case 0x2416: pap.inTable = this.u8(s, v) !== 0; break;
			case 0x2417: pap.rowEnd = this.u8(s, v) !== 0; break;
			case 0x260A: pap.level = this.u8(s, v); break;
			case 0x460B: pap.list = this.u16(s, v); break;
			case 0xD608:
				// Where each cell of the row starts and ends, in twips.
				var cells = this.u8(s, v + 2);
				pap.edges = [];
				for (var c = 0; c <= cells; c++) {
					pap.edges.push(this.s16(s, v + 3 + c * 2));
				}
				break;
			}
			at = v + size;
		}
	},

	rgb: function(s, at) {
		function hex(n) {
			return (n < 16 ? "0" : "") + n.toString(16);
		}
		return "#" + hex(this.u8(s, at)) + hex(this.u8(s, at + 1)) + hex(this.u8(s, at + 2));
	},

	// ---- the style sheet ---------------------------------------------------------------------

	readStyles: function(table, stsh) {
		var styles = [];
		if (!stsh.length) {
			return styles;
		}
		var headerSize = this.u16(table, stsh.at);
		var count = this.u16(table, stsh.at + 2);
		var baseSize = this.u16(table, stsh.at + 4);
		var p = stsh.at + 2 + headerSize;
		for (var i = 0; i < count && p + 2 <= table.length; i++) {
			var size = this.u16(table, p);
			p += 2;
			if (!size) {
				styles.push(null);
				continue;
			}
			var word1 = this.u16(table, p + 2);
			var kind = word1 & 0xF;
			var base = word1 >> 4;
			var parts = this.u16(table, p + 4) & 0xF;
			var q = p + baseSize;
			q += 2 + this.u16(table, q) * 2 + 2;  // the name: length, characters, a zero
			var style = {base: base === 0xFFF ? -1 : base, kind: kind, papAt: 0, papLength: 0, chpAt: 0, chpLength: 0};
			for (var n = 0; n < parts && q + 2 <= p + size; n++) {
				if ((q - p) & 1) {
					q++;
				}
				var length = this.u16(table, q);
				q += 2;
				if (kind === 1 && n === 0) {
					style.papAt = q + 2;  // after the style's own number
					style.papLength = Math.max(0, length - 2);
				} else if ((kind === 1 && n === 1) || (kind === 2 && n === 0)) {
					style.chpAt = q;
					style.chpLength = length;
				}
				q += length;
			}
			styles.push(style);
			p += size;
		}
		return styles;
	},

	// A style with everything it inherits: {pap, chp}. The answer is kept; copy before changing it.
	style: function(model, istd) {
		var style = model.styles[istd];
		if (!style) {
			return {pap: {}, chp: {}};
		}
		if (style.resolved) {
			return style.resolved;
		}
		var chain = [];
		var seen = {};
		var at = istd;
		while (at >= 0 && model.styles[at] && !seen[at]) {
			seen[at] = true;
			chain.unshift(model.styles[at]);
			at = model.styles[at].base;
		}
		var out = {pap: {}, chp: {}};
		style.resolved = out;  // set first: a character style may be named from inside
		for (var i = 0; i < chain.length; i++) {
			this.apply(model, model.table, chain[i].papAt, chain[i].papLength, out.pap, out.chp);
			this.apply(model, model.table, chain[i].chpAt, chain[i].chpLength, out.pap, out.chp);
		}
		return out;
	},

	readFonts: function(table, where) {
		var fonts = [];
		if (!where.length) {
			return fonts;
		}
		var count = this.u16(table, where.at);
		var p = where.at + 4;
		for (var i = 0; i < count && p < where.at + where.length; i++) {
			var size = this.u8(table, p);
			var name = "";
			for (var q = p + 40; q + 1 < p + 1 + size; q += 2) {
				var ch = this.u16(table, q);
				if (!ch) {
					break;
				}
				name += String.fromCharCode(ch);
			}
			fonts.push(name);
			p += size + 1;
		}
		return fonts;
	},

	// ---- lists ---------------------------------------------------------------------------------

	// Returns the lists by the number paragraphs use: [null, {levels: [{start, format, text, at, length}], counts: []}, ...]
	readLists: function(table, definitions, uses) {
		var byId = {};
		var out = [null];
		if (!definitions.length || !uses.length) {
			return out;
		}
		var count = this.u16(table, definitions.at);
		var p = definitions.at + 2;
		var lists = [];
		var i;
		for (i = 0; i < count; i++) {
			lists.push({id: this.u32(table, p), simple: (this.u8(table, p + 26) & 1) !== 0, levels: []});
			p += 28;
		}
		// The levels of every list follow, in the same order.
		for (i = 0; i < lists.length; i++) {
			var levels = lists[i].simple ? 1 : 9;
			for (var n = 0; n < levels && p + 28 <= table.length; n++) {
				var chpSize = this.u8(table, p + 24);
				var papSize = this.u8(table, p + 25);
				var level = {start: this.u32(table, p), format: this.u8(table, p + 4), at: p + 28, length: papSize, text: []};
				p += 28 + papSize + chpSize;
				var chars = this.u16(table, p);
				p += 2;
				for (var c = 0; c < chars; c++) {
					level.text.push(this.u16(table, p + c * 2));
				}
				p += chars * 2;
				lists[i].levels.push(level);
			}
			byId[lists[i].id] = lists[i];
		}
		var used = this.u32(table, uses.at);
		for (i = 0; i < used; i++) {
			var list = byId[this.u32(table, uses.at + 4 + i * 16)];
			out.push(list ? {levels: list.levels, counts: []} : null);
		}
		return out;
	},

	// The label of the next paragraph in a list, counting as it goes; null if there is none.
	nextLabel: function(list, depth) {
		var level = list.levels[depth] || list.levels[0];
		if (!level) {
			return null;
		}
		var counts = list.counts;
		counts[depth] = counts[depth] === undefined ? level.start : counts[depth] + 1;
		counts.length = depth + 1;
		if (level.format === 23) {
			// A bullet, often a private character of the Symbol or Wingdings font.
			var ch = level.text[0];
			if (!ch || ch >= 0xF000 || ch === 0xB7) {
				return depth % 3 === 1 ? "◦" : (depth % 3 === 2 ? "▪" : "•");
			}
			return String.fromCharCode(ch);
		}
		if (level.format === 255) {
			return "";
		}
		var formats = {0: "decimal", 1: "upperRoman", 2: "lowerRoman", 3: "upperLetter", 4: "lowerLetter", 22: "decimalZero"};
		var label = "";
		for (var i = 0; i < level.text.length; i++) {
			var code = level.text[i];
			if (code < 9) {
				// A stand-in for the number of that level.
				var other = list.levels[code] || level;
				var value = counts[code] === undefined ? other.start : counts[code];
				label += PP.Docx.formatNumber(value, formats[other.format] || "decimal");
			} else {
				label += String.fromCharCode(code);
			}
		}
		return label;
	},

	// ---- building the page ----------------------------------------------------------------------

	render: function(model, container) {
		var sheet = document.createElement("div");
		sheet.className = "pp-sheet";
		sheet.style.width = "612pt";
		var wd = model.wd;
		var count = 0;

		var into = sheet;       // where finished paragraphs go: the sheet, or the cell being filled
		var table = null;       // the table being built
		var row = null;         // its cells so far in this row: [td]
		var cell = null;
		var runs = [];          // the paragraph being collected: {text, chp, breakBefore, pageGap}
		var current = null;
		var fieldDepth = 0;     // inside a field's instructions, which are not shown
		var hideUntil = [];
		var chpHint = 0;
		var papHint = 0;
		var self = this;

		function closeTable() {
			if (table) {
				sheet.appendChild(table);
				count++;
			}
			table = null;
			row = null;
			cell = null;
			into = sheet;
		}

		function endParagraph(fc, isCellMark) {
			var index = self.runAt(model.papRuns, fc, papHint);
			var papRun = index >= 0 ? model.papRuns[index] : null;
			papHint = index >= 0 ? index : papHint;
			var style = self.style(model, papRun ? papRun.istd : 0);
			var pap = {};
			var baseChp = {};
			var k;
			for (k in style.pap) { pap[k] = style.pap[k]; }
			for (k in style.chp) { baseChp[k] = style.chp[k]; }
			// A list gives its level's indents; the paragraph's own settings follow and win.
			var list = null;
			var probe = {};
			if (papRun) {
				self.apply(model, wd, papRun.at, papRun.length, probe, {});
			}
			var listNumber = probe.list !== undefined ? probe.list : pap.list;
			var depth = probe.level !== undefined ? probe.level : (pap.level || 0);
			if (listNumber > 0 && model.lists[listNumber]) {
				list = model.lists[listNumber];
				var level = list.levels[depth] || list.levels[0];
				if (level) {
					self.apply(model, model.table, level.at, level.length, pap, {});
				}
			}
			if (papRun) {
				self.apply(model, wd, papRun.at, papRun.length, pap, baseChp);
			}

			if (pap.inTable && isCellMark && pap.rowEnd) {
				// The mark that ends a row: the cells collected so far become the row.
				if (!table) {
					table = document.createElement("table");
					table.className = "pp-table pp-table-plain";
				}
				var tr = document.createElement("tr");
				for (var c = 0; row && c < row.length; c++) {
					if (pap.edges && pap.edges[c + 1] !== undefined) {
						row[c].style.width = (pap.edges[c + 1] - pap.edges[c]) / 20 + "pt";
					}
					tr.appendChild(row[c]);
				}
				table.appendChild(tr);
				row = null;
				cell = null;
				into = sheet;
				runs = [];
				current = null;
				return;
			}
			if (pap.inTable) {
				if (!cell) {
					cell = document.createElement("td");
					row = row || [];
					row.push(cell);
				}
				into = cell;
			} else if (table) {
				closeTable();
			}

			var el = document.createElement("div");
			el.className = "pp-p";
			PP.Docx.applyPara(el, pap);
			if (list) {
				var label = self.nextLabel(list, depth);
				if (label !== null) {
					var tag = document.createElement("span");
					tag.className = "pp-label";
					var labelChp = {};
					for (k in baseChp) { labelChp[k] = baseChp[k]; }
					labelChp.font = undefined;
					PP.Docx.applyRun(tag, labelChp);
					tag.style.minWidth = Math.max(0, -(pap.first || 0)) + "pt";
					tag.style.textIndent = "0";
					tag.appendChild(document.createTextNode(label));
					el.appendChild(tag);
				}
			}
			var any = false;
			for (var i = 0; i < runs.length; i++) {
				var r = runs[i];
				if (r.pageGap) {
					var gap = document.createElement("span");
					gap.className = "pp-page-gap";
					el.appendChild(gap);
					continue;
				}
				if (r.lineBreak) {
					el.appendChild(document.createElement("br"));
					continue;
				}
				if (!r.text) {
					continue;
				}
				var chp = {};
				for (k in baseChp) { chp[k] = baseChp[k]; }
				if (r.chp) {
					self.apply(model, wd, r.chp.at, r.chp.length, {}, chp);
				}
				if (chp.hidden) {
					continue;
				}
				var span = document.createElement("span");
				PP.Docx.applyRun(span, chp);
				span.appendChild(document.createTextNode(r.text));
				el.appendChild(span);
				any = true;
			}
			if (!any) {
				var empty = document.createElement("span");
				PP.Docx.applyRun(empty, baseChp);
				empty.appendChild(document.createTextNode(" "));
				el.appendChild(empty);
			}
			into.appendChild(el);
			if (into === sheet) {
				count++;
			}
			if (pap.inTable && isCellMark) {
				cell = null;  // the next paragraph starts the next cell
			}
			runs = [];
			current = null;
		}

		function add(text, chpRun) {
			if (!current || current.chp !== chpRun) {
				current = {text: "", chp: chpRun};
				runs.push(current);
			}
			current.text += text;
		}

		for (var p = 0; p < model.pieces.length; p++) {
			var piece = model.pieces[p];
			var step = piece.wide ? 2 : 1;
			var last = Math.min(piece.end, model.textLength);
			for (var cp = piece.start; cp < last; cp++) {
				var fc = piece.fc + (cp - piece.start) * step;
				var code = piece.wide ? this.u16(wd, fc) : this.u8(wd, fc);
				if (!piece.wide && code >= 0x80 && code <= 0x9F) {
					code = this.cp1252[code - 0x80];
				}
				if (code === 13 || code === 7) {
					endParagraph(fc, code === 7);
					continue;
				}
				// Fields: 19 starts one, 20 separates its instructions from what to show, 21 ends it.
				if (code === 19) {
					fieldDepth++;
					hideUntil.push(true);
					continue;
				}
				if (code === 20) {
					if (hideUntil.length) {
						hideUntil[hideUntil.length - 1] = false;
					}
					continue;
				}
				if (code === 21) {
					hideUntil.pop();
					fieldDepth = Math.max(0, fieldDepth - 1);
					continue;
				}
				var hidden = false;
				for (var h = 0; h < hideUntil.length; h++) {
					if (hideUntil[h]) {
						hidden = true;
					}
				}
				if (hidden) {
					continue;
				}
				var ci = this.runAt(model.chpRuns, fc, chpHint);
				chpHint = ci >= 0 ? ci : chpHint;
				var chpRun = ci >= 0 ? model.chpRuns[ci] : null;
				if (code === 12) {
					runs.push({pageGap: true});
					current = null;
				} else if (code === 11) {
					runs.push({lineBreak: true});
					current = null;
				} else if (code === 9) {
					add("  ", chpRun);
				} else if (code === 30) {
					add("‑", chpRun);
				} else if (code === 31) {
					add("­", chpRun);
				} else if (code >= 32) {
					add(String.fromCharCode(code), chpRun);
				}
				// Other codes below 32 mark pictures, drawings and notes, which are not shown yet.
			}
		}
		if (runs.length) {
			endParagraph(model.pieces[model.pieces.length - 1].fc, false);
		}
		closeTable();
		container.appendChild(sheet);
		return count;
	}
};
