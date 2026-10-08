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
 *   drawing      <- the "Office Art" records (filter/source/msfilter): stored pictures,
 *                   and which picture or text box each drawn shape shows
 *
 * Formatting ends up in the same shape Docx.js uses, so both draw with the same code.
 * The page is one continuous sheet: the first section gives its size and margins, its
 * header is shown once at the top and its footer once at the bottom, and footnotes and
 * endnotes are listed after the text.
 *
 * Drawn shapes are boxes, rounded boxes, ovals and straight lines, alone or in groups,
 * with their fill and outline; of any other shape only the text is shown.
 *
 * Objects placed over or under the text, and the members of a group, are positioned
 * absolutely. The view that shows the page scrolls in software (see DocView.js), so
 * none of this becomes a layer on the graphics chip.
 *
 * Not handled: Windows metafile pictures (.wmf, .emf; a box marks their place), slanted
 * lines (they would need a rotation, untried on the TouchPad), tab stops, columns,
 * Word 6/95 files, password-protected files.
 */
PP.Doc = {
	drawGroups: true,

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

	s32: function(s, at) {
		var v = this.u32(s, at);
		return v >= 0x80000000 ? v - 0x100000000 : v;
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
		var self = this;
		// The file's index: pairs of (where, how long) in the table stream, 8 bytes each from 0x9A.
		function where(index) {
			return {at: self.u32(wd, 0x9A + index * 8), length: self.u32(wd, 0x9E + index * 8)};
		}
		// The text is one run of characters: the body, then footnotes, headers and
		// footers, comments, endnotes and text boxes, each a given number of characters.
		var n = {text: this.u32(wd, 0x4C), foot: this.u32(wd, 0x50), head: this.u32(wd, 0x54),
			macro: this.u32(wd, 0x58), comment: this.u32(wd, 0x5C), end: this.u32(wd, 0x60), box: this.u32(wd, 0x64)};
		var model = {wd: wd, table: table, data: stream("Data") || "", textLength: n.text,
			footStart: n.text,
			headStart: n.text + n.foot,
			endStart: n.text + n.foot + n.head + n.macro + n.comment,
			boxStart: n.text + n.foot + n.head + n.macro + n.comment + n.end,
			headBoxStart: n.text + n.foot + n.head + n.macro + n.comment + n.end + n.box};
		model.styles = this.readStyles(table, where(1));
		model.chpRuns = this.readPages(wd, table, where(12), false);
		model.papRuns = this.readPages(wd, table, where(13), true);
		model.fonts = this.readFonts(table, where(15));
		// What text looks like before any style speaks: the style sheet names a font, and
		// Word's own starting size is 10 points.
		var sheet = where(1);
		model.baseChp = {size: 10, font: sheet.length >= 16 ? model.fonts[this.u16(table, sheet.at + 14)] : undefined};
		model.pieces = this.readPieces(table, where(33));
		model.lists = this.readLists(table, where(73), where(74));
		if (!model.pieces.length) {
			return {error: "This document has no text that Papers could find."};
		}
		model.sections = this.readSections(model, where(6));
		model.footRefs = this.positions(table, where(2), 2);
		model.footText = this.positions(table, where(3), 0);
		model.endRefs = this.positions(table, where(46), 2);
		model.endText = this.positions(table, where(47), 0);
		model.headers = this.positions(table, where(11), 0);
		model.boxes = this.positions(table, where(56), 22);
		model.headBoxes = this.positions(table, where(58), 22);
		model.anchors = {};
		this.readAnchors(model, where(40), 0);
		this.readAnchors(model, where(41), model.headStart);
		model.art = this.readArt(table, where(50));
		return model;
	},

	// A table of positions: (count + 1) character positions, then count entries of the given size.
	positions: function(table, plc, entrySize) {
		var out = [];
		if (plc.length < 4) {
			return out;
		}
		var count = Math.floor((plc.length - 4) / (4 + entrySize));
		for (var i = 0; i <= count; i++) {
			out.push(this.u32(table, plc.at + i * 4));
		}
		return out;
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

	rgb: function(s, at) {
		function hex(n) {
			return (n < 16 ? "0" : "") + n.toString(16);
		}
		return "#" + hex(this.u8(s, at)) + hex(this.u8(s, at + 1)) + hex(this.u8(s, at + 2));
	},

	// A line as CSS from its width (eighths of a point), kind and color.
	line: function(width, kind, color) {
		if (kind === 0 || kind === 0xFF) {
			return "none";
		}
		// The web engine draws nothing thinner than a pixel.
		var px = Math.max(1, Math.round(width / 8 * 96 / 72));
		var style = kind === 3 ? "double" : (kind === 6 ? "dotted" : (kind === 7 || kind === 22 ? "dashed" : "solid"));
		if (style === "double") {
			px = Math.max(px, 3);
		}
		return px + "px " + style + " " + (color || "#000");
	},

	// A border in the 4-byte form (Word 97): width, kind, color number, spacing.
	border4: function(s, at) {
		if (this.u32(s, at) === 0xFFFFFFFF) {
			return "none";
		}
		return this.line(this.u8(s, at), this.u8(s, at + 1), this.colors[this.u8(s, at + 2)]);
	},

	// A border in the 8-byte form (Word 2000 on): color, width, kind, spacing.
	border8: function(s, at) {
		if (this.u32(s, at) === 0xFFFFFFFF && this.u32(s, at + 4) === 0xFFFFFFFF) {
			return "none";
		}
		return this.line(this.u8(s, at + 4), this.u8(s, at + 5), this.u8(s, at + 3) === 0xFF ? undefined : this.rgb(s, at));
	},

	// Shading in the 2-byte form: color numbers and a pattern.
	shade2: function(s, at) {
		var v = this.u16(s, at);
		var pattern = v >> 10;
		if (pattern === 0) {
			return this.colors[(v >> 5) & 0x1F];
		}
		if (pattern === 1) {
			return this.colors[v & 0x1F] || "#000000";
		}
		// A dotted or striped pattern: a grey of about the same weight.
		return pattern <= 4 ? "#e6e6e6" : (pattern <= 8 ? "#bfbfbf" : "#8c8c8c");
	},

	// Shading in the 10-byte form: foreground color, background color, pattern.
	shade10: function(s, at) {
		var pattern = this.u16(s, at + 8);
		if (pattern === 0) {
			return this.u8(s, at + 7) === 0xFF ? undefined : this.rgb(s, at + 4);
		}
		if (pattern === 1) {
			return this.u8(s, at + 3) === 0xFF ? "#000000" : this.rgb(s, at);
		}
		return this.u8(s, at + 7) === 0xFF ? "#d9d9d9" : this.rgb(s, at + 4);
	},

	// Apply a list of codes from stream s to paragraph properties pap and character
	// properties chp. Section and table row settings also land in pap.
	apply: function(model, s, at, length, pap, chp) {
		var end = at + length;
		var i;
		var count;
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
			case 0x0806: chp.formData = this.u8(s, v) !== 0; break;
			case 0x6A03: chp.picture = this.u32(s, v); break;
			case 0x2A3E: chp.underline = this.u8(s, v) !== 0; break;
			case 0x4A43: chp.size = this.u16(s, v) / 2; break;
			case 0x2A42: chp.color = this.colors[this.u8(s, v)]; break;
			case 0x6870:
				chp.color = this.u8(s, v + 3) === 0xFF ? undefined : this.rgb(s, v);
				break;
			case 0x2A0C: chp.background = this.colors[this.u8(s, v)]; break;
			case 0x4866: chp.background = this.shade2(s, v); break;
			case 0xCA71: chp.background = this.shade10(s, v + 1); break;
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
			case 0x6424: pap.borderTop = this.border4(s, v); break;
			case 0x6425: pap.borderLeft = this.border4(s, v); break;
			case 0x6426: pap.borderBottom = this.border4(s, v); break;
			case 0x6427: pap.borderRight = this.border4(s, v); break;
			case 0xC64E: pap.borderTop = this.border8(s, v + 1); break;
			case 0xC64F: pap.borderLeft = this.border8(s, v + 1); break;
			case 0xC650: pap.borderBottom = this.border8(s, v + 1); break;
			case 0xC651: pap.borderRight = this.border8(s, v + 1); break;
			case 0x442D: pap.background = this.shade2(s, v); break;
			case 0xC64D: pap.background = this.shade10(s, v + 1); break;
			// table rows (these come with the mark that ends a row)
			case 0xD608:
				// Where each cell starts and ends (twips), then each cell's flags and borders.
				count = this.u8(s, v + 2);
				pap.edges = [];
				for (i = 0; i <= count; i++) {
					pap.edges.push(this.s16(s, v + 3 + i * 2));
				}
				pap.cells = [];
				var tc = v + 3 + (count + 1) * 2;
				for (i = 0; i < count && tc + 20 <= v + size; i++, tc += 20) {
					var bits = this.u16(s, tc);
					pap.cells.push({
						first: (bits & 0x01) !== 0, merged: (bits & 0x02) !== 0,
						down: (bits & 0x20) !== 0, downStart: (bits & 0x40) !== 0,
						valign: (bits >> 7) & 3,
						top: this.border4(s, tc + 4), left: this.border4(s, tc + 8),
						bottom: this.border4(s, tc + 12), right: this.border4(s, tc + 16),
						// A border of all zeros says "nothing set here; use the table's".
						set: [this.u32(s, tc + 4) !== 0, this.u32(s, tc + 8) !== 0,
							this.u32(s, tc + 12) !== 0, this.u32(s, tc + 16) !== 0]
					});
				}
				break;
			case 0xD605:
				pap.tableBorders = [];
				for (i = 0; i < 6; i++) {
					pap.tableBorders.push(this.border4(s, v + 1 + i * 4));
				}
				break;
			case 0xD613:
				pap.tableBorders = [];
				for (i = 0; i < 6; i++) {
					pap.tableBorders.push(this.border8(s, v + 1 + i * 8));
				}
				break;
			case 0xD609:
				pap.shades = [];
				for (i = 0; i < this.u8(s, v) / 2; i++) {
					pap.shades.push(this.shade2(s, v + 1 + i * 2));
				}
				break;
			case 0xD612: case 0xD616: case 0xD60C:
				// The colors of cells 1-22, 23-44 and 45-63.
				pap.shades = code === 0xD612 ? [] : (pap.shades || []);
				for (i = 0; i < Math.floor(this.u8(s, v) / 10); i++) {
					pap.shades.push(this.shade10(s, v + 1 + i * 10));
				}
				break;
			case 0x5400: pap.tableAlign = this.u16(s, v); break;
			// sections
			case 0xB01F: pap.pageWidth = this.u16(s, v) / 20; break;
			case 0xB020: pap.pageHeight = this.u16(s, v) / 20; break;
			case 0xB021: pap.marginLeft = this.u16(s, v) / 20; break;
			case 0xB022: pap.marginRight = this.u16(s, v) / 20; break;
			case 0x9023: pap.marginTop = Math.abs(this.s16(s, v)) / 20; break;
			case 0x9024: pap.marginBottom = Math.abs(this.s16(s, v)) / 20; break;
			case 0x300A: pap.titlePage = this.u8(s, v) !== 0; break;
			}
			at = v + size;
		}
	},

	// ---- sections: page size and margins ---------------------------------------------------------

	readSections: function(model, plc) {
		var out = [];
		var count = plc.length >= 4 ? Math.floor((plc.length - 4) / 16) : 0;
		for (var i = 0; i < count; i++) {
			// What Word assumes when a section says nothing: US Letter, 1.25" and 1" margins.
			var section = {end: this.u32(model.table, plc.at + (i + 1) * 4), pageWidth: 612, pageHeight: 792,
				marginLeft: 90, marginRight: 90, marginTop: 72, marginBottom: 72};
			var at = this.u32(model.table, plc.at + (count + 1) * 4 + i * 12 + 2);
			if (at !== 0xFFFFFFFF && at + 2 <= model.wd.length) {
				this.apply(model, model.wd, at + 2, this.u16(model.wd, at), section, {});
			}
			out.push(section);
		}
		if (!out.length) {
			out.push({end: model.textLength, pageWidth: 612, pageHeight: 792, marginLeft: 90, marginRight: 90,
				marginTop: 72, marginBottom: 72});
		}
		return out;
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
			return {pap: {}, chp: {size: model.baseChp.size, font: model.baseChp.font}};
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
		var out = {pap: {}, chp: {size: model.baseChp.size, font: model.baseChp.font}};
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

	// ---- pictures and drawn objects ---------------------------------------------------------------

	// Where drawn objects are anchored in the text: position -> {shape, left, top, width,
	// height (points), wrap, behind, fromPage, fromParagraph}.
	readAnchors: function(model, plc, offset) {
		var count = plc.length >= 4 ? Math.floor((plc.length - 4) / 30) : 0;
		for (var i = 0; i < count; i++) {
			var at = plc.at + (count + 1) * 4 + i * 26;
			var left = this.s32(model.table, at + 4);
			var top = this.s32(model.table, at + 8);
			var flags = this.u16(model.table, at + 20);
			model.anchors[offset + this.u32(model.table, plc.at + i * 4)] = {
				shape: this.u32(model.table, at),
				left: left / 20,
				top: top / 20,
				width: (this.s32(model.table, at + 12) - left) / 20,
				height: (this.s32(model.table, at + 16) - top) / 20,
				// 0 and 2: text runs beside it; 1: text stops above and goes on below; 3: text ignores it
				wrap: (flags >> 5) & 0xF,
				behind: (flags & 0x4000) !== 0,
				fromPage: ((flags >> 1) & 3) === 1,       // measured from the page edge, not the margin
				fromParagraph: ((flags >> 3) & 3) === 2   // measured down from its paragraph
			};
		}
	},

	// A drawing color: red, green, blue in the low three bytes. The top byte marks colors
	// taken from the system or a scheme, which are not looked up here.
	artColor: function(value) {
		if ((value >>> 24) & 0x19) {
			return undefined;
		}
		function hex(n) {
			return (n < 16 ? "0" : "") + n.toString(16);
		}
		return "#" + hex(value & 0xFF) + hex((value >> 8) & 0xFF) + hex((value >> 16) & 0xFF);
	},

	// The drawing layer: the list of stored pictures, and what each shape is.
	// Returns {pictures: [position in the WordDocument stream], shapes: {id: shape}}, a shape being
	//   {id, kind, flipH, flipV, picture, text, fill, filled, line, lined, lineWidth,
	//    box: [left, top, right, bottom] within its group, space: the group's own coordinates,
	//    members: [shapes of a group]}
	readArt: function(table, where) {
		var art = {pictures: [], shapes: {}};
		var self = this;
		// Records nest: 8 bytes of header (version and instance, kind, length), then the content.
		function walk(p, end, group) {
			var shape = null;
			while (p + 8 <= end) {
				var head = self.u16(table, p);
				var kind = self.u16(table, p + 2);
				var length = self.u32(table, p + 4);
				var body = p + 8;
				if (kind === 0xF007) {
					// A stored picture: its bytes are elsewhere, at this position.
					art.pictures.push(length >= 36 ? self.u32(table, body + 28) : 0xFFFFFFFF);
				} else if (kind === 0xF003) {
					// A group: its first shape stands for the group, the rest are its members.
					var holder = {members: [], isGroup: true};
					walk(body, Math.min(end, body + length), holder);
					if (group && holder.shape) {
						group.members.push(holder.shape);
					}
				} else if (kind === 0xF004) {
					shape = walk(body, Math.min(end, body + length), null);
					if (shape && group) {
						if (!group.shape) {
							group.shape = shape;
							shape.members = group.members;
						} else {
							group.members.push(shape);
						}
					}
				} else if (kind === 0xF009 && length >= 16) {
					// The coordinates a group's members are placed in. It comes before the shape's own record.
					shape = shape || {members: []};
					shape.space = [self.s32(table, body), self.s32(table, body + 4), self.s32(table, body + 8), self.s32(table, body + 12)];
				} else if (kind === 0xF00A) {
					shape = shape || {members: []};
					shape.id = self.u32(table, body);
					shape.kind = head >> 4;
					var bits = self.u32(table, body + 4);
					shape.flipH = (bits & 0x40) !== 0;
					shape.flipV = (bits & 0x80) !== 0;
					shape.filled = true;
					shape.lined = true;
					art.shapes[shape.id] = shape;
				} else if (kind === 0xF00B && shape) {
					// Properties: 6 bytes each, a number and a value.
					for (var i = 0; i < (head >> 4) && body + i * 6 + 6 <= end; i++) {
						var id = self.u16(table, body + i * 6) & 0x3FFF;
						var value = self.u32(table, body + i * 6 + 2);
						switch (id) {
						case 260: shape.picture = value; break;        // which stored picture, counting from 1
						case 128: shape.text = value >>> 16; break;    // which text box, counting from 1
						case 385: shape.fill = self.artColor(value); break;
						case 448: shape.line = self.artColor(value); break;
						case 459: shape.lineWidth = value / 12700; break;
						case 447:
							// Each on/off setting has a second bit saying whether it is given at all.
							if (value & 0x100000) { shape.filled = (value & 0x10) !== 0; }
							break;
						case 511:
							if (value & 0x80000) { shape.lined = (value & 0x08) !== 0; }
							break;
						}
					}
				} else if (kind === 0xF00F && shape && length >= 16) {
					// Where a member sits in its group's coordinates.
					shape.box = [self.s32(table, body), self.s32(table, body + 4), self.s32(table, body + 8), self.s32(table, body + 12)];
				} else if ((head & 0xF) === 0xF) {
					var inner = walk(body, Math.min(end, body + length), group);
					shape = shape || inner;
				}
				p = body + length;
			}
			return shape;
		}
		if (where.length > 8) {
			var p = where.at;
			var end = where.at + where.length;
			// The shared part, then one drawing per part of the document, each after a marker byte.
			while (p + 8 <= end) {
				var length = this.u32(table, p + 4);
				walk(p, Math.min(end, p + 8 + length), null);
				p += 8 + length + 1;
			}
		}
		return art;
	},

	// The bytes of a stream as a string of characters 0 to 255, which btoa needs.
	bytes: function(s, at, length) {
		var parts = [];
		var end = Math.min(s.length, at + length);
		for (var p = at; p < end; p += 4096) {
			var chunk = [];
			var stop = Math.min(end, p + 4096);
			for (var i = p; i < stop; i++) {
				chunk.push(s.charCodeAt(i) & 0xFF);
			}
			parts.push(String.fromCharCode.apply(null, chunk));
		}
		return parts.join("");
	},

	// A stored picture record at this position, as an address an <img> can show; null if
	// it is a kind the web engine cannot draw (Windows metafiles).
	pictureAt: function(s, at) {
		if (at + 8 > s.length) {
			return null;
		}
		var instance = this.u16(s, at) >> 4;
		var kind = this.u16(s, at + 2);
		var length = this.u32(s, at + 4);
		var body = at + 8;
		if (kind === 0xF007) {
			// A wrapper: 36 bytes and a name, then the picture itself.
			var inner = body + 36 + this.u8(s, body + 33);
			return inner + 8 <= body + length ? this.pictureAt(s, inner) : null;
		}
		var type = null;
		var skip = 17;  // an identifier and a marker byte come first
		if (kind === 0xF01E) {
			type = "image/png";
			skip = instance === 0x6E1 ? 33 : 17;
		} else if (kind === 0xF01D || kind === 0xF02A) {
			type = "image/jpeg";
			skip = instance === 0x46B || instance === 0x6E3 ? 33 : 17;
		} else if (kind === 0xF01F) {
			skip = instance === 0x7A9 ? 33 : 17;
			// A bitmap without its file header: put one in front.
			var dib = body + skip;
			var bits = this.u16(s, dib + 14);
			var used = this.u32(s, dib + 32);
			var palette = bits <= 8 ? (used || (1 << bits)) * 4 : 0;
			var total = length - skip + 14;
			var offset = 14 + this.u32(s, dib) + palette;
			var header = "BM" + this.le32(total) + this.le32(0) + this.le32(offset);
			return "data:image/bmp;base64," + btoa(header + this.bytes(s, dib, length - skip));
		}
		if (!type) {
			return null;
		}
		return "data:" + type + ";base64," + btoa(this.bytes(s, body + skip, length - skip));
	},

	le32: function(n) {
		return String.fromCharCode(n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF);
	},

	// A picture in the line of text: its record is in the Data stream at this position.
	inlinePicture: function(model, at) {
		var data = model.data;
		if (at + 0x44 > data.length) {
			return null;
		}
		var total = this.u32(data, at);
		var kind = this.u16(data, at + 6);
		var scaleX = this.u16(data, at + 0x20) || 1000;
		var scaleY = this.u16(data, at + 0x22) || 1000;
		var out = {width: this.u16(data, at + 0x1C) * scaleX / 1000 / 20, height: this.u16(data, at + 0x1E) * scaleY / 1000 / 20, src: null};
		var p = at + this.u16(data, at + 4);
		var end = Math.min(data.length, at + total);
		if (kind === 0x66) {
			p += 1 + this.u8(data, p);  // a linked file's name
		}
		// The picture is a drawing record; go down through its containers to the stored picture.
		while (p + 8 <= end) {
			var head = this.u16(data, p);
			var type = this.u16(data, p + 2);
			if (type === 0xF007 || (type >= 0xF018 && type <= 0xF117)) {
				out.src = this.pictureAt(data, p);
				break;
			}
			p += (head & 0xF) === 0xF ? 8 : 8 + this.u32(data, p + 4);
		}
		return out;
	},

	// ---- building the page ----------------------------------------------------------------------

	render: function(model, container) {
		var section = model.sections[0];
		var sheet = document.createElement("div");
		sheet.className = "pp-sheet";
		sheet.style.width = section.pageWidth + "pt";
		sheet.style.padding = section.marginTop + "pt " + section.marginRight + "pt " + section.marginBottom + "pt " +
			section.marginLeft + "pt";

		// Headers and footers: the stories come in sixes per section, after six for the
		// note separators: even header, odd header, even footer, odd footer, first-page
		// header, first-page footer. One sheet shows it all, so one of each is shown.
		var self = this;
		function story(index) {
			var h = model.headers;
			if (index + 1 >= h.length || h[index + 1] <= h[index]) {
				return null;
			}
			// Each ends with a paragraph mark of its own, which is not part of it.
			return {from: model.headStart + h[index], to: model.headStart + h[index + 1] - 1};
		}
		function strip(index, className) {
			var range = story(index);
			if (!range || range.to <= range.from) {
				return null;
			}
			var el = document.createElement("div");
			el.className = className;
			self.flow(model, range.from, range.to, el, {});
			return el;
		}
		var header = (section.titlePage && strip(10, "pp-header")) || strip(7, "pp-header");
		var footer = (section.titlePage && strip(11, "pp-footer")) || strip(9, "pp-footer");
		if (header) {
			sheet.appendChild(header);
		}

		var notes = {foot: [], end: []};
		var count = this.flow(model, 0, model.textLength, sheet, {notes: notes});

		// Footnotes, then endnotes, under a short rule.
		function noteList(list, refs, text, start, roman) {
			if (!list.length) {
				return;
			}
			var rule = document.createElement("div");
			rule.className = "pp-notes-rule";
			sheet.appendChild(rule);
			for (var i = 0; i < list.length; i++) {
				var index = list[i];
				if (index + 1 >= text.length) {
					continue;
				}
				var note = document.createElement("div");
				note.className = "pp-note";
				var label = roman ? PP.Docx.roman(index + 1) : String(index + 1);
				self.flow(model, start + text[index], start + text[index + 1], note, {noteLabel: label});
				sheet.appendChild(note);
			}
		}
		noteList(notes.foot, model.footRefs, model.footText, model.footStart, false);
		noteList(notes.end, model.endRefs, model.endText, model.endStart, true);

		if (footer) {
			sheet.appendChild(footer);
		}
		container.appendChild(sheet);
		return count;
	},

	// Lay out the characters from position "from" up to "to" as paragraphs and tables in a node.
	// options: {notes: {foot: [], end: []} to collect the notes referred to,
	//           noteLabel: the number to show for a note's own mark}
	// Returns how many top-level blocks were made.
	flow: function(model, from, to, target, options) {
		var wd = model.wd;
		var self = this;
		var count = 0;
		var into = target;      // where finished paragraphs go: the target, or the cell being filled
		var table = null;       // the table being built
		var rows = [];          // its rows so far: {cells: [td], pap}
		var row = null;         // the cells of the row being filled: [td]
		var cell = null;
		var items = [];         // the paragraph being collected
		var current = null;
		var fields = [];        // open fields: {hidden, code, link}
		var chpHint = 0;
		var papHint = 0;

		// Borders, shading, widths and merged cells are known once all rows are in.
		function closeTable() {
			if (!table) {
				return;
			}
			var open = {};  // column -> the cell that started a downward merge
			for (var r = 0; r < rows.length; r++) {
				var pap = rows[r].pap;
				var cells = rows[r].cells;
				var tr = document.createElement("tr");
				var borders = pap.tableBorders || [];
				var spanning = null;
				for (var c = 0; c < cells.length; c++) {
					var td = cells[c];
					var def = (pap.cells && pap.cells[c]) || {set: []};
					if (def.merged && !def.first && spanning) {
						// Joined to the cell on its left.
						spanning.colSpan = (spanning.colSpan || 1) + 1;
						continue;
					}
					spanning = def.first ? td : null;
					if (def.down && !def.downStart) {
						// Joined to the cell above.
						if (open[c]) {
							open[c].rowSpan = (open[c].rowSpan || 1) + 1;
							continue;
						}
					}
					open[c] = def.downStart ? td : null;
					if (pap.edges && pap.edges[c + 1] !== undefined) {
						td.style.width = (pap.edges[c + 1] - pap.edges[c]) / 20 + "pt";
					}
					if (pap.shades && pap.shades[c]) {
						td.style.backgroundColor = pap.shades[c];
					}
					if (def.valign) {
						td.style.verticalAlign = def.valign === 1 ? "middle" : "bottom";
					}
					// The cell's own lines where it sets them, else the table's: outer edge or inside.
					var sides = {
						Top: def.set[0] ? def.top : (r === 0 ? borders[0] : borders[4]),
						Left: def.set[1] ? def.left : (c === 0 ? borders[1] : borders[5]),
						Bottom: def.set[2] ? def.bottom : (r === rows.length - 1 ? borders[2] : borders[4]),
						Right: def.set[3] ? def.right : (c === cells.length - 1 ? borders[3] : borders[5])
					};
					for (var side in sides) {
						if (sides[side] && sides[side] !== "none") {
							td.style["border" + side] = sides[side];
						}
					}
					tr.appendChild(td);
				}
				table.appendChild(tr);
				if (r === 0 && pap.tableAlign === 1) {
					table.style.marginLeft = "auto";
					table.style.marginRight = "auto";
				} else if (r === 0 && pap.tableAlign === 2) {
					table.style.marginLeft = "auto";
				}
			}
			target.appendChild(table);
			count++;
			table = null;
			rows = [];
			row = null;
			cell = null;
			into = target;
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
					table.className = "pp-table";
				}
				rows.push({cells: row || [], pap: pap});
				row = null;
				cell = null;
				into = target;
				items = [];
				current = null;
				return;
			}
			if (pap.inTable) {
				if (!table) {
					table = document.createElement("table");
					table.className = "pp-table";
				}
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
			for (var i = 0; i < items.length; i++) {
				var item = items[i];
				if (item.node) {
					if (item.placed) {
						item.placed.style.left = (item.across - (pap.left || 0) - (pap.first || 0)) + "pt";
					}
					el.appendChild(item.node);
					any = true;
					continue;
				}
				if (!item.text) {
					continue;
				}
				var chp = {};
				for (k in baseChp) { chp[k] = baseChp[k]; }
				if (item.chp) {
					self.apply(model, wd, item.chp.at, item.chp.length, {}, chp);
				}
				if (chp.hidden) {
					continue;
				}
				if (item.note) {
					chp.vertical = "superscript";
				}
				var span = document.createElement("span");
				PP.Docx.applyRun(span, chp);
				if (item.link) {
					span.className = "pp-link";
				}
				span.appendChild(document.createTextNode(item.text));
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
			if (into === target) {
				count++;
			}
			if (pap.inTable && isCellMark) {
				cell = null;  // the next paragraph starts the next cell
			}
			items = [];
			current = null;
		}

		function add(text, chpRun, link) {
			if (!current || current.chp !== chpRun || current.link !== link) {
				current = {text: "", chp: chpRun, link: link};
				items.push(current);
			}
			current.text += text;
		}

		function addNode(node) {
			items.push({node: node});
			current = null;
		}

		// The formatting in force at a character, without the paragraph's style (enough to
		// tell what a special character stands for).
		function directChp(chpRun) {
			var chp = {};
			if (chpRun) {
				self.apply(model, wd, chpRun.at, chpRun.length, {}, chp);
			}
			return chp;
		}

		function pictureNode(src, width, height) {
			var node;
			if (src) {
				node = document.createElement("img");
				node.className = "pp-picture";
				node.src = src;
			} else {
				// A kind of picture the web engine cannot draw (a Windows metafile).
				node = document.createElement("span");
				node.className = "pp-missing";
				node.appendChild(document.createTextNode("[picture]"));
			}
			if (width > 0 && height > 0) {
				node.style.width = width + "pt";
				node.style.height = height + "pt";
			}
			return node;
		}

		// One shape as a node of the given size (points): a picture, a line, or a box that
		// may be filled, outlined, round, hold text, or hold the members of a group.
		function shapeNode(shape, width, height, inHeader, depth) {
			var node = document.createElement("span");
			node.className = "pp-shape";
			var s = node.style;
			var stroke = Math.max(1, Math.round((shape.lineWidth === undefined ? 0.75 : shape.lineWidth) * 96 / 72));
			var ink = shape.line || "#000";
			s.width = Math.max(0, width) + "pt";
			s.height = Math.max(0, height) + "pt";
			if (shape.picture) {
				var at = model.art.pictures[shape.picture - 1];
				var src = at !== undefined && at !== 0xFFFFFFFF ? self.pictureAt(wd, at) : null;
				var picture = pictureNode(src, width, height);
				picture.style.display = "block";
				node.appendChild(picture);
				return node;
			}
			if (shape.kind === 20 || shape.kind === 32) {
				// A straight line, from one corner of its box to the opposite one.
				if (!shape.lined) {
					return node;
				}
				// Level and upright lines are an edge of the box. A slanted line would need the
				// box turned, which has not been tried on the TouchPad.
				if (height < 1.5) {
					s.borderTop = stroke + "px solid " + ink;
				} else if (width < 1.5) {
					s.borderLeft = stroke + "px solid " + ink;
				}
				return node;
			}
			if (shape.members && shape.members.length && depth < 5 && self.drawGroups) {
				// A group: its members are placed by where they sit in the group's own coordinates.
				var space = shape.space || [0, 0, 1, 1];
				var scaleX = width / Math.max(1, space[2] - space[0]);
				var scaleY = height / Math.max(1, space[3] - space[1]);
				for (var m = 0; m < shape.members.length; m++) {
					var member = shape.members[m];
					var box = member.box || space;
					var child = shapeNode(member, (box[2] - box[0]) * scaleX, (box[3] - box[1]) * scaleY, inHeader, depth + 1);
					child.style.position = "absolute";
					child.style.left = (box[0] - space[0]) * scaleX + "pt";
					child.style.top = (box[1] - space[1]) * scaleY + "pt";
					node.appendChild(child);
				}
				return node;
			}
			// Boxes, rounded boxes, ovals and text boxes are drawn. Any other shape (an arrow,
			// a star, a callout...) has an outline this cannot draw yet, and a box in its
			// place would be wrong and would cover what is under it, so only its text shows.
			var known = shape.kind === 1 || shape.kind === 2 || shape.kind === 3 || shape.kind === 202;
			if (!known) {
				// nothing to paint
			} else if (shape.filled && shape.fill) {
				s.backgroundColor = shape.fill;
			} else if (shape.filled && shape.kind !== 202 && !shape.text) {
				s.backgroundColor = "#fff";  // a drawn shape is white inside unless told otherwise
			}
			if (shape.lined && known) {
				s.border = stroke + "px solid " + ink;
			}
			if (shape.kind === 3) {
				s.borderRadius = "50%";
				s.webkitBorderRadius = Math.max(width, height) + "pt";
			} else if (shape.kind === 2) {
				s.borderRadius = s.webkitBorderRadius = Math.min(width, height) / 6 + "pt";
			}
			if (shape.text) {
				var boxes = inHeader ? model.headBoxes : model.boxes;
				var start = inHeader ? model.headBoxStart : model.boxStart;
				if (shape.text < boxes.length && boxes[shape.text] > boxes[shape.text - 1]) {
					var inside = document.createElement("span");
					inside.className = "pp-textbox";
					// Its text ends with a paragraph mark of its own, which is not part of it.
					self.flow(model, start + boxes[shape.text - 1], start + boxes[shape.text] - 1, inside, {});
					node.appendChild(inside);
					// The box keeps the size it was drawn at, as in Word: text that does not fit is cut off.
					s.overflow = "hidden";
				}
			}
			return node;
		}

		// A drawn object anchored here, placed by how the text is to treat it.
		function drawn(shape, anchor, inHeader) {
			if (!shape) {
				return;
			}
			var node = shapeNode(shape, anchor.width, anchor.height, inHeader, 0);
			var s = node.style;
			var section = model.sections[0];
			// Across the page, measured from the left margin (where the text starts).
			var x = anchor.left - (anchor.fromPage ? section.marginLeft : 0);
			var column = section.pageWidth - section.marginLeft - section.marginRight;
			if (anchor.wrap === 3) {
				// Text ignores it: it lies over or under the text and takes up no room. It hangs
				// from a spot of no size at the start of its paragraph.
				var holder = document.createElement("span");
				holder.className = "pp-anchor";
				s.position = "absolute";
				s.top = (anchor.fromParagraph ? anchor.top : 0) + "pt";
				s.zIndex = anchor.behind ? "-1" : "1";
				holder.appendChild(node);
				// Its place across the page is measured from the edge of the text column. The
				// spot it hangs from is at the start of the paragraph's first line, which the
				// paragraph's indents move; they are known when the paragraph ends (see there).
				items.unshift({node: holder, placed: node, across: Math.max(-section.marginLeft, x)});
				current = null;
				return;
			}
			if (anchor.wrap === 1) {
				// Text stops above it and goes on below.
				s.display = "block";
				// It may reach into the left margin, as far as the edge of the page.
				s.marginLeft = Math.max(-section.marginLeft, x) + "pt";
				s.marginBottom = "6pt";
			} else {
				// Text runs beside it: it goes to whichever side it is nearer.
				var right = x + anchor.width / 2 > column / 2;
				s.cssFloat = right ? "right" : "left";
				s.margin = right ? "0 0 6pt 9pt" : "0 9pt 6pt 0";
			}
			items.unshift({node: node});
			current = null;
		}

		for (var p = 0; p < model.pieces.length; p++) {
			var piece = model.pieces[p];
			if (piece.end <= from || piece.start >= to) {
				continue;
			}
			var step = piece.wide ? 2 : 1;
			var last = Math.min(piece.end, to);
			for (var cp = Math.max(piece.start, from); cp < last; cp++) {
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
					fields.push({hidden: true, code: "", link: false});
					continue;
				}
				var field = fields.length ? fields[fields.length - 1] : null;
				if (code === 20) {
					if (field) {
						field.hidden = false;
						field.link = /^\s*HYPERLINK\b/i.test(field.code);
					}
					continue;
				}
				if (code === 21) {
					fields.pop();
					continue;
				}
				var hidden = false;
				var link = false;
				for (var f = 0; f < fields.length; f++) {
					hidden = hidden || fields[f].hidden;
					link = link || fields[f].link;
				}
				if (hidden) {
					if (field && code >= 32) {
						field.code += String.fromCharCode(code);
					}
					continue;
				}
				var ci = this.runAt(model.chpRuns, fc, chpHint);
				chpHint = ci >= 0 ? ci : chpHint;
				var chpRun = ci >= 0 ? model.chpRuns[ci] : null;
				if (code === 12) {
					var gap = document.createElement("span");
					gap.className = "pp-page-gap";
					addNode(gap);
				} else if (code === 11) {
					addNode(document.createElement("br"));
				} else if (code === 9) {
					add("  ", chpRun, link);
				} else if (code === 30) {
					add("‑", chpRun, link);
				} else if (code === 31) {
					add("­", chpRun, link);
				} else if (code >= 32) {
					add(String.fromCharCode(code), chpRun, link);
				} else if (code === 1) {
					// A picture in the line (unless it is the data of a form field).
					var pic = directChp(chpRun);
					// Hidden text can hold pictures too (an icon kept in the file but not shown).
					if (pic.special && pic.picture !== undefined && !pic.formData && !pic.hidden) {
						var found = this.inlinePicture(model, pic.picture);
						if (found) {
							addNode(pictureNode(found.src, found.width, found.height));
						}
					}
				} else if (code === 8) {
					var anchor = model.anchors[cp];
					var mark = directChp(chpRun);
					if (anchor && mark.special && !mark.hidden) {
						drawn(model.art.shapes[anchor.shape], anchor, cp >= model.headStart);
					}
				} else if (code === 2 && directChp(chpRun).special) {
					// A note's number: in the body it refers to the note; in the note it starts it.
					var label = options.noteLabel;
					if (options.notes) {
						var at = model.footRefs.indexOf(cp);
						if (at >= 0 && at < model.footRefs.length - 1) {
							options.notes.foot.push(at);
							label = String(at + 1);
						} else {
							at = model.endRefs.indexOf(cp);
							if (at >= 0 && at < model.endRefs.length - 1) {
								options.notes.end.push(at);
								label = PP.Docx.roman(at + 1);
							}
						}
					}
					if (label) {
						items.push({text: label, chp: chpRun, note: true});
						current = null;
					}
				}
				// Other codes below 32 are marks for comments and the like, which are not shown.
			}
		}
		if (items.length) {
			endParagraph(model.pieces[model.pieces.length - 1].fc, false);
		}
		closeTable();
		return count;
	}
};
