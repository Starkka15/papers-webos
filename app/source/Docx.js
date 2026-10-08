/* Word documents (.docx): reads the unpacked parts and builds the page as HTML.
 *
 * The structure follows LibreOffice's Word import (sw/source/writerfilter/dmapper):
 *   styles      <- StyleSheetTable   styles.xml, with "based on" inheritance
 *   numbering   <- NumberingManager  numbering.xml, list labels and counters
 *   properties  <- PropertyMap       paragraph and run formatting, merged in the
 *                                    order defaults, style chain, direct formatting
 *   body        <- DomainMapper      paragraphs, runs, tables, pictures, links
 *
 * Lengths in the file are twips (1/20 point), font sizes half-points, and picture
 * sizes EMU (12700 per point). Everything is turned into points for CSS.
 *
 * Each page the document starts (a page break, a new section, or a place where Word
 * noted it broke the page) is a sheet of its own. The first section's header is shown
 * at the top of the first page and the last footer at the bottom of the last page;
 * footnotes and endnotes are listed at the end.
 *
 * Not handled yet: old-style (VML) shapes, turned shapes, charts, tracked-change display.
 */
PP.Docx = {
	W: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	R: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	A: "http://schemas.openxmlformats.org/drawingml/2006/main",
	WP: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
	V: "urn:schemas-microsoft-com:vml",
	MC: "http://schemas.openxmlformats.org/markup-compatibility/2006",

	// ---- reading the parts ---------------------------------------------------------

	// dir: where the file was unpacked. callback(model) or callback(null, message).
	open: function(dir, callback) {
		var self = this;
		var model = {dir: dir, rels: {}, styles: {}, defaults: {ppr: {}, rpr: {}}, nums: {}, abstracts: {}, parts: {},
			used: {foot: [], end: []}};
		PP.readXml(dir + "/word/document.xml", function(doc) {
			if (!doc) {
				callback(null, "This does not look like a Word document.");
				return;
			}
			model.doc = doc;
			PP.readXml(dir + "/word/_rels/document.xml.rels", function(rels) {
				if (rels) {
					self.readRels(model, rels);
				}
				PP.readXml(dir + "/word/styles.xml", function(styles) {
					if (styles) {
						self.readStyles(model, styles);
					}
					PP.readXml(dir + "/word/numbering.xml", function(numbering) {
						if (numbering) {
							self.readNumbering(model, numbering);
						}
						self.readParts(model, function() {
							callback(model);
						});
					});
				});
			});
		});
	},

	// The other parts the body refers to: each header and footer, and the footnotes and
	// endnotes. Each is a file of its own with its own list of pictures and links.
	// They end up in model.parts by name: {doc, rels}.
	readParts: function(model, done) {
		var self = this;
		var wanted = [];
		for (var id in model.rels) {
			var target = model.rels[id].target || "";
			if (!model.rels[id].external && /(^|\/)(header|footer)\d*\.xml$/i.test(target)) {
				wanted.push({name: id, target: target});
			} else if (/(^|\/)footnotes\.xml$/i.test(target)) {
				wanted.push({name: "footnotes", target: target});
			} else if (/(^|\/)endnotes\.xml$/i.test(target)) {
				wanted.push({name: "endnotes", target: target});
			} else if (/(^|\/)theme\d*\.xml$/i.test(target)) {
				wanted.push({name: "theme", target: target});
			}
		}
		function next() {
			var item = wanted.shift();
			if (!item) {
				self.readTheme(model);
				done();
				return;
			}
			var path = item.target.replace(/^\/+/, "");
			if (!/^word\//.test(path)) {
				path = "word/" + path;
			}
			var slash = path.lastIndexOf("/");
			PP.readXml(model.dir + "/" + path, function(doc) {
				if (!doc) {
					next();
					return;
				}
				PP.readXml(model.dir + "/" + path.substring(0, slash) + "/_rels/" + path.substring(slash + 1) + ".rels", function(rels) {
					var holder = {rels: {}};
					if (rels) {
						self.readRels(holder, rels);
					}
					model.parts[item.name] = {doc: doc, rels: holder.rels};
					next();
				});
			});
		}
		next();
	},

	// ---- small XML helpers -----------------------------------------------------------

	// Child elements in the Word namespace with this name.
	kids: function(node, name) {
		var out = [];
		for (var c = node ? node.firstChild : null; c; c = c.nextSibling) {
			if (c.nodeType === 1 && c.localName === name && c.namespaceURI === this.W) {
				out.push(c);
			}
		}
		return out;
	},

	kid: function(node, name) {
		for (var c = node ? node.firstChild : null; c; c = c.nextSibling) {
			if (c.nodeType === 1 && c.localName === name && c.namespaceURI === this.W) {
				return c;
			}
		}
		return null;
	},

	// A w: attribute.
	att: function(node, name) {
		if (!node) {
			return null;
		}
		var v = node.getAttributeNS(this.W, name);
		if (v === null || v === "") {
			v = node.getAttribute("w:" + name);
		}
		return v === "" ? null : v;
	},

	// <w:b/> is on; <w:b w:val="0"/> is off; absent says nothing (undefined).
	toggle: function(parent, name) {
		var el = this.kid(parent, name);
		if (!el) {
			return undefined;
		}
		var v = this.att(el, "val");
		return !(v === "0" || v === "false" || v === "off");
	},

	number: function(text) {
		var n = parseFloat(text);
		return isNaN(n) ? undefined : n;
	},

	// "auto" and missing colors say nothing.
	color: function(text) {
		return text && /^[0-9A-Fa-f]{6}$/.test(text) ? "#" + text : undefined;
	},

	// Later sources win wherever they say something.
	merge: function(into, from) {
		for (var k in from) {
			if (from[k] !== undefined) {
				into[k] = from[k];
			}
		}
		return into;
	},

	// ---- properties (PropertyMap) --------------------------------------------------------

	highlights: {yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff",
		red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080",
		darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000"},

	// Run (character) formatting from a w:rPr.
	runProps: function(rpr) {
		var p = {};
		if (!rpr) {
			return p;
		}
		p.bold = this.toggle(rpr, "b");
		p.italic = this.toggle(rpr, "i");
		p.strike = this.toggle(rpr, "strike");
		p.caps = this.toggle(rpr, "caps");
		p.smallCaps = this.toggle(rpr, "smallCaps");
		p.hidden = this.toggle(rpr, "vanish");
		var u = this.kid(rpr, "u");
		if (u) {
			p.underline = this.att(u, "val") !== "none";
		}
		var color = this.kid(rpr, "color");
		if (color) {
			p.color = this.color(this.att(color, "val"));
		}
		var sz = this.kid(rpr, "sz");
		if (sz) {
			var half = this.number(this.att(sz, "val"));
			p.size = half === undefined ? undefined : half / 2;
		}
		var hl = this.kid(rpr, "highlight");
		if (hl) {
			p.background = this.highlights[this.att(hl, "val")];
		}
		var shd = this.kid(rpr, "shd");
		if (shd && p.background === undefined) {
			p.background = this.color(this.att(shd, "fill"));
		}
		var va = this.kid(rpr, "vertAlign");
		if (va) {
			p.vertical = this.att(va, "val");
		}
		var fonts = this.kid(rpr, "rFonts");
		if (fonts) {
			p.font = this.att(fonts, "ascii") || this.att(fonts, "hAnsi") || undefined;
		}
		var style = this.kid(rpr, "rStyle");
		if (style) {
			p.style = this.att(style, "val");
		}
		return p;
	},

	// Paragraph formatting from a w:pPr.
	paraProps: function(ppr) {
		var p = {};
		if (!ppr) {
			return p;
		}
		var style = this.kid(ppr, "pStyle");
		if (style) {
			p.style = this.att(style, "val");
		}
		var jc = this.kid(ppr, "jc");
		if (jc) {
			var a = this.att(jc, "val");
			p.align = a === "both" || a === "distribute" ? "justify" :
				(a === "center" ? "center" : (a === "right" || a === "end" ? "right" : "left"));
		}
		var ind = this.kid(ppr, "ind");
		if (ind) {
			var left = this.att(ind, "left") || this.att(ind, "start");
			var right = this.att(ind, "right") || this.att(ind, "end");
			p.left = left === null ? undefined : this.number(left) / 20;
			p.right = right === null ? undefined : this.number(right) / 20;
			if (this.att(ind, "hanging") !== null) {
				p.first = -this.number(this.att(ind, "hanging")) / 20;
			} else if (this.att(ind, "firstLine") !== null) {
				p.first = this.number(this.att(ind, "firstLine")) / 20;
			}
		}
		var sp = this.kid(ppr, "spacing");
		if (sp) {
			if (this.att(sp, "before") !== null) {
				p.before = this.number(this.att(sp, "before")) / 20;
			}
			if (this.att(sp, "after") !== null) {
				p.after = this.number(this.att(sp, "after")) / 20;
			}
			if (this.att(sp, "line") !== null) {
				var line = this.number(this.att(sp, "line"));
				var rule = this.att(sp, "lineRule") || "auto";
				// "auto" counts in 240ths of a line; the others are a height in twips.
				p.line = rule === "auto" ? (line / 240) : (line / 20) + "pt";
			}
		}
		var num = this.kid(ppr, "numPr");
		if (num) {
			var id = this.kid(num, "numId");
			var lvl = this.kid(num, "ilvl");
			p.numId = id ? this.att(id, "val") : undefined;
			p.level = lvl ? parseInt(this.att(lvl, "val"), 10) || 0 : undefined;
		}
		var outline = this.kid(ppr, "outlineLvl");
		if (outline) {
			p.outline = parseInt(this.att(outline, "val"), 10);
		}
		var shd = this.kid(ppr, "shd");
		if (shd) {
			p.background = this.color(this.att(shd, "fill"));
		}
		p.pageBreak = this.toggle(ppr, "pageBreakBefore");
		var bdr = this.kid(ppr, "pBdr");
		if (bdr) {
			p.borderTop = this.border(this.kid(bdr, "top"));
			p.borderBottom = this.border(this.kid(bdr, "bottom"));
			p.borderLeft = this.border(this.kid(bdr, "left"));
			p.borderRight = this.border(this.kid(bdr, "right"));
		}
		return p;
	},

	// A border element as CSS, or "none"; undefined if it is not given.
	border: function(el) {
		if (!el) {
			return undefined;
		}
		var kind = this.att(el, "val");
		if (!kind || kind === "nil" || kind === "none") {
			return "none";
		}
		// Widths are in eighths of a point. The web engine draws nothing for a line
		// thinner than one pixel, so hairlines become one pixel.
		var width = Math.max(1, Math.round((this.number(this.att(el, "sz")) || 4) / 8 * 96 / 72));
		var style = kind === "dashed" || kind === "dashSmallGap" ? "dashed" :
			(kind === "dotted" ? "dotted" : (kind === "double" ? "double" : "solid"));
		if (style === "double") {
			width = Math.max(width, 3);
		}
		return width + "px " + style + " " + (this.color(this.att(el, "color")) || "#000");
	},

	// ---- styles (StyleSheetTable) ----------------------------------------------------------

	readRels: function(model, doc) {
		var list = doc.getElementsByTagName("Relationship");
		for (var i = 0; i < list.length; i++) {
			model.rels[list[i].getAttribute("Id")] = {
				target: list[i].getAttribute("Target"),
				external: list[i].getAttribute("TargetMode") === "External"
			};
		}
	},

	readStyles: function(model, doc) {
		var root = doc.documentElement;
		var defaults = this.kid(root, "docDefaults");
		if (defaults) {
			model.defaults.rpr = this.runProps(this.kid(this.kid(defaults, "rPrDefault"), "rPr"));
			model.defaults.ppr = this.paraProps(this.kid(this.kid(defaults, "pPrDefault"), "pPr"));
		}
		var styles = this.kids(root, "style");
		for (var i = 0; i < styles.length; i++) {
			var s = styles[i];
			var id = this.att(s, "styleId");
			var based = this.kid(s, "basedOn");
			var name = this.kid(s, "name");
			var tblPr = this.kid(s, "tblPr");
			model.styles[id] = {
				type: this.att(s, "type"),
				name: name ? this.att(name, "val") : "",
				based: based ? this.att(based, "val") : null,
				ppr: this.paraProps(this.kid(s, "pPr")),
				rpr: this.runProps(this.kid(s, "rPr")),
				tableBorders: tblPr ? this.kid(tblPr, "tblBorders") : null
			};
			if (this.att(s, "default") === "1" && this.att(s, "type") === "paragraph") {
				model.defaultParagraph = id;
			}
		}
	},

	// A style with everything it inherits: {ppr, rpr}.
	style: function(model, id) {
		var chain = [];
		var seen = {};
		while (id && model.styles[id] && !seen[id]) {
			seen[id] = true;
			chain.unshift(model.styles[id]);
			id = model.styles[id].based;
		}
		var out = {ppr: {}, rpr: {}, name: chain.length ? chain[chain.length - 1].name : ""};
		for (var i = 0; i < chain.length; i++) {
			this.merge(out.ppr, chain[i].ppr);
			this.merge(out.rpr, chain[i].rpr);
		}
		return out;
	},

	// ---- lists (NumberingManager) -------------------------------------------------------------

	readNumbering: function(model, doc) {
		var root = doc.documentElement;
		var abstracts = this.kids(root, "abstractNum");
		var i, j;
		for (i = 0; i < abstracts.length; i++) {
			var levels = {};
			var lvls = this.kids(abstracts[i], "lvl");
			for (j = 0; j < lvls.length; j++) {
				levels[parseInt(this.att(lvls[j], "ilvl"), 10) || 0] = this.level(lvls[j]);
			}
			model.abstracts[this.att(abstracts[i], "abstractNumId")] = levels;
		}
		var nums = this.kids(root, "num");
		for (i = 0; i < nums.length; i++) {
			var ref = this.kid(nums[i], "abstractNumId");
			var num = {levels: (ref && model.abstracts[this.att(ref, "val")]) || {}, counts: []};
			// A list may replace some levels of the definition it is built on.
			var overrides = this.kids(nums[i], "lvlOverride");
			for (j = 0; j < overrides.length; j++) {
				var own = this.kid(overrides[j], "lvl");
				var start = this.kid(overrides[j], "startOverride");
				var at = parseInt(this.att(overrides[j], "ilvl"), 10) || 0;
				if (own || start) {
					var copy = this.merge({}, num.levels);
					copy[at] = own ? this.level(own) : this.merge({}, num.levels[at] || {});
					if (start) {
						copy[at].start = parseInt(this.att(start, "val"), 10) || 1;
					}
					num.levels = copy;
				}
			}
			model.nums[this.att(nums[i], "numId")] = num;
		}
	},

	level: function(lvl) {
		var start = this.kid(lvl, "start");
		var fmt = this.kid(lvl, "numFmt");
		var text = this.kid(lvl, "lvlText");
		return {
			start: start ? parseInt(this.att(start, "val"), 10) || 1 : 1,
			format: fmt ? this.att(fmt, "val") : "decimal",
			text: text ? (this.att(text, "val") || "") : "",
			ppr: this.paraProps(this.kid(lvl, "pPr")),
			rpr: this.runProps(this.kid(lvl, "rPr"))
		};
	},

	roman: function(n) {
		var parts = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"],
			[40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
		var out = "";
		for (var i = 0; i < parts.length; i++) {
			while (n >= parts[i][0]) {
				out += parts[i][1];
				n -= parts[i][0];
			}
		}
		return out;
	},

	letters: function(n) {
		// a..z, aa..zz, aaa...
		var letter = String.fromCharCode(97 + ((n - 1) % 26));
		var times = Math.floor((n - 1) / 26) + 1;
		var out = "";
		for (var i = 0; i < times; i++) {
			out += letter;
		}
		return out;
	},

	formatNumber: function(n, format) {
		switch (format) {
		case "lowerLetter": return this.letters(n);
		case "upperLetter": return this.letters(n).toUpperCase();
		case "lowerRoman": return this.roman(n);
		case "upperRoman": return this.roman(n).toUpperCase();
		case "decimalZero": return (n < 10 ? "0" : "") + n;
		case "none": return "";
		default: return String(n);
		}
	},

	// The label of the next paragraph in a list ("3.", "b)", a bullet), counting as it goes.
	nextLabel: function(model, numId, ilvl) {
		var num = model.nums[numId];
		if (!num) {
			return null;
		}
		var lvl = num.levels[ilvl];
		if (!lvl) {
			return null;
		}
		var counts = num.counts;
		counts[ilvl] = counts[ilvl] === undefined ? lvl.start : counts[ilvl] + 1;
		counts.length = ilvl + 1;  // deeper levels start over
		if (lvl.format === "bullet") {
			// Bullets are often private characters of the Symbol and Wingdings fonts.
			var ch = lvl.text.charCodeAt(0);
			if (!lvl.text || ch >= 0xF000 || lvl.text === "\u00B7") {
				return ilvl % 3 === 1 ? "\u25E6" : (ilvl % 3 === 2 ? "\u25AA" : "\u2022");
			}
			return lvl.text;
		}
		var self = this;
		return lvl.text.replace(/%(\d)/g, function(all, digit) {
			var at = parseInt(digit, 10) - 1;
			var other = num.levels[at] || lvl;
			var value = counts[at] === undefined ? other.start : counts[at];
			return self.formatNumber(value, at === ilvl ? lvl.format : other.format);
		});
	},

	// ---- the body (DomainMapper) ------------------------------------------------------------------

	// A section's page setup, from its w:sectPr. Lengths in points.
	section: function(sect) {
		var size = this.kid(sect, "pgSz");
		var margins = this.kid(sect, "pgMar");
		var type = this.kid(sect, "type");
		var self = this;
		function twips(el, name, fallback) {
			var v = el ? self.number(self.att(el, name)) : undefined;
			return (v === undefined ? fallback : Math.abs(v)) / 20;
		}
		var out = {
			width: twips(size, "w", 12240), height: twips(size, "h", 15840),
			top: twips(margins, "top", 1440), right: twips(margins, "right", 1440),
			bottom: twips(margins, "bottom", 1440), left: twips(margins, "left", 1440),
			headerTop: twips(margins, "header", 720), footerBottom: twips(margins, "footer", 720),
			titlePage: this.toggle(sect, "titlePg") === true,
			continuous: !!type && this.att(type, "val") === "continuous",
			headers: {}, footers: {}
		};
		var refs = sect ? sect.childNodes : [];
		for (var i = 0; i < refs.length; i++) {
			var r = refs[i];
			if (r.nodeType === 1 && (r.localName === "headerReference" || r.localName === "footerReference")) {
				var id = r.getAttributeNS(this.R, "id") || r.getAttribute("r:id");
				(r.localName === "headerReference" ? out.headers : out.footers)[this.att(r, "type") || "default"] = id;
			}
		}
		return out;
	},

	// A header or footer part, or the notes, drawn into a block; null if there is nothing in it.
	// The part has its own list of pictures and links, which stands in while it is drawn.
	partBlock: function(model, name, className, from) {
		var part = model.parts[name];
		if (!part) {
			return null;
		}
		var el = document.createElement("div");
		el.className = className;
		var rels = model.rels;
		model.rels = part.rels;
		var count = this.blocks(model, from || part.doc.documentElement, el);
		model.rels = rels;
		return count ? el : null;
	},

	// Builds the pages inside container (a DOM node). Returns how many blocks it made.
	// Each page the document starts (a page break, a new section, or a place where Word
	// noted it broke the page) is a sheet of its own, at least a page high.
	render: function(model, container) {
		var self = this;
		var body = this.kid(model.doc.documentElement, "body");
		// The sections, in order: each ends at a paragraph that carries its setup, and the
		// last one's setup is at the end of the body.
		var setups = [];
		var marks = body ? body.getElementsByTagNameNS(this.W, "sectPr") : [];
		for (var i = 0; i < marks.length; i++) {
			setups.push(this.section(marks[i]));
		}
		if (!setups.length) {
			setups.push(this.section(null));
		}
		var at = 0;
		var section = setups[0];
		model.section = section;
		model.used = {foot: [], end: []};

		function newSheet() {
			var page = document.createElement("div");
			page.className = "pp-sheet";
			page.style.width = section.width + "pt";
			page.style.minHeight = section.height + "pt";
			page.style.padding = section.top + "pt " + section.right + "pt " + section.bottom + "pt " + section.left + "pt";
			container.appendChild(page);
			return page;
		}
		var sheet = newSheet();
		var count = 0;

		// The header starts in the top margin, a set distance from the top of the page; if it
		// is taller than the margin leaves room for, the text starts below it.
		var header = this.partBlock(model, (section.titlePage && section.headers.first) || section.headers["default"], "pp-header");
		if (header) {
			var room = Math.max(0, section.top - section.headerTop);
			header.style.marginTop = -room + "pt";
			header.style.minHeight = room + "pt";
			header.style.marginBottom = "0";
			sheet.appendChild(header);
		}
		var footerName = section.footers["default"] || section.footers.first;

		function walk(parent) {
			for (var c = parent ? parent.firstChild : null; c; c = c.nextSibling) {
				if (c.nodeType !== 1 || c.namespaceURI !== self.W) {
					continue;
				}
				if (c.localName === "p") {
					var flags = {};
					var el = self.paragraph(model, c, flags);
					if (flags.pageStarts) {
						sheet = newSheet();
					}
					sheet.appendChild(el);
					count++;
					if (flags.sectionEnds) {
						// The next section's setup takes over; unless it is "continuous" it starts a page.
						at = Math.min(at + 1, setups.length - 1);
						section = setups[at];
						model.section = section;
						footerName = section.footers["default"] || footerName;
						if (!section.continuous) {
							sheet = newSheet();
						}
					} else if (flags.pageEnds) {
						sheet = newSheet();
					}
				} else if (c.localName === "tbl") {
					sheet.appendChild(self.table(model, c));
					count++;
				} else if (c.localName === "sdt") {
					walk(self.kid(c, "sdtContent"));
				}
			}
		}
		walk(body);

		// Footnotes, then endnotes, under a short rule on the last page.
		function notes(ids, name, tag, roman) {
			var part = model.parts[name];
			if (!ids.length || !part) {
				return;
			}
			var rule = document.createElement("div");
			rule.className = "pp-notes-rule";
			sheet.appendChild(rule);
			var all = part.doc.getElementsByTagNameNS(self.W, tag);
			for (var n = 0; n < ids.length; n++) {
				for (var k = 0; k < all.length; k++) {
					if (self.att(all[k], "id") === ids[n]) {
						model.noteLabel = roman ? self.roman(n + 1) : String(n + 1);
						var note = self.partBlock(model, name, "pp-note", all[k]);
						model.noteLabel = null;
						if (note) {
							sheet.appendChild(note);
						}
						break;
					}
				}
			}
		}
		var used = model.used;
		model.used = {foot: [], end: []};  // notes inside notes are not followed
		notes(used.foot, "footnotes", "footnote", false);
		notes(used.end, "endnotes", "endnote", true);

		var footer = this.partBlock(model, footerName, "pp-footer");
		if (footer) {
			sheet.appendChild(footer);
		}
		return count;
	},

	// Paragraphs and tables inside a body, a table cell or a text box.
	blocks: function(model, parent, into) {
		var count = 0;
		for (var c = parent ? parent.firstChild : null; c; c = c.nextSibling) {
			if (c.nodeType !== 1) {
				continue;
			}
			if (c.namespaceURI !== this.W) {
				continue;
			}
			if (c.localName === "p") {
				into.appendChild(this.paragraph(model, c));
				count++;
			} else if (c.localName === "tbl") {
				into.appendChild(this.table(model, c));
				count++;
			} else if (c.localName === "sdt") {
				// A content control: show what is inside it.
				count += this.blocks(model, this.kid(c, "sdtContent"), into);
			}
		}
		return count;
	},

	// flags, when given (for paragraphs directly on a page), receives pageStarts, pageEnds
	// and sectionEnds, and page breaks are reported there and not drawn as a strip.
	paragraph: function(model, p, flags) {
		var direct = this.paraProps(this.kid(p, "pPr"));
		var style = this.style(model, direct.style || model.defaultParagraph);
		// In a table, the table style's paragraph settings come before the paragraph's own style.
		var props = this.merge(this.merge(this.merge(this.merge({}, model.defaults.ppr), model.cellPpr || {}),
			style.ppr), direct);
		var el = document.createElement("div");
		el.className = "pp-p";

		// What runs in this paragraph start from: defaults, then the paragraph's style.
		var base = this.merge(this.merge({}, model.defaults.rpr), style.rpr);

		// A list paragraph takes its indents from the list level unless it sets its own.
		var label = null;
		var labelProps = null;
		if (props.numId !== undefined && props.numId !== "0") {
			var num = model.nums[props.numId];
			var lvl = num && num.levels[props.level || 0];
			if (lvl) {
				var fromList = this.merge(this.merge({}, lvl.ppr), {left: direct.left, first: direct.first});
				if (direct.left === undefined && style.ppr.left !== undefined && lvl.ppr.left === undefined) {
					fromList.left = style.ppr.left;
				}
				props.left = fromList.left !== undefined ? fromList.left : props.left;
				props.first = fromList.first !== undefined ? fromList.first : props.first;
				label = this.nextLabel(model, props.numId, props.level || 0);
				labelProps = this.merge(this.merge({}, base), lvl.rpr);
				// The symbol fonts are not on the TouchPad; the bullet was already translated.
				labelProps.font = undefined;
			}
		}

		if (flags) {
			if (props.pageBreak) {
				flags.pageStarts = true;
				props.pageBreak = false;
			}
			if (this.kid(this.kid(p, "pPr"), "sectPr")) {
				flags.sectionEnds = true;
			}
		}
		this.applyPara(el, props);

		if (label !== null) {
			var tag = document.createElement("span");
			tag.className = "pp-label";
			this.applyRun(tag, labelProps);
			// The label sits in the hanging indent; give it at least that much room.
			tag.style.minWidth = Math.max(0, -(props.first || 0)) + "pt";
			tag.style.textIndent = "0";
			tag.appendChild(document.createTextNode(label));
			el.appendChild(tag);
		}

		var state = {inField: 0, flags: flags || null, holder: el, labelled: label !== null,
			indent: (props.left || 0) + (props.first || 0)};
		this.inlines(model, p, el, base, state);
		if (!el.lastChild || (label !== null && el.childNodes.length === 1)) {
			// An empty paragraph still takes up a line.
			var empty = document.createElement("span");
			this.applyRun(empty, base);
			empty.appendChild(document.createTextNode("\u00A0"));
			el.appendChild(empty);
		}
		return el;
	},

	// The runs, links and fields of a paragraph (or of a link inside one).
	inlines: function(model, parent, into, base, state) {
		for (var c = parent.firstChild; c; c = c.nextSibling) {
			if (c.nodeType !== 1) {
				continue;
			}
			var name = c.localName;
			if (c.namespaceURI !== this.W) {
				continue;
			}
			if (name === "r") {
				this.run(model, c, into, base, state);
			} else if (name === "hyperlink") {
				var link = document.createElement("span");
				link.className = "pp-link";
				var rel = model.rels[c.getAttributeNS(this.R, "id") || c.getAttribute("r:id")];
				if (rel && rel.external) {
					link.setAttribute("data-href", rel.target);
				}
				this.inlines(model, c, link, base, state);
				into.appendChild(link);
			} else if (name === "ins" || name === "smartTag" || name === "fldSimple" || name === "bdo" || name === "dir") {
				// Inserted text (tracked changes), smart tags and simple fields: show the contents.
				this.inlines(model, c, into, base, state);
			} else if (name === "sdt") {
				var content = this.kid(c, "sdtContent");
				if (content) {
					this.inlines(model, content, into, base, state);
				}
			}
			// w:del (deleted text), bookmarks, proofing marks and comments are left out.
		}
	},

	run: function(model, r, into, base, state) {
		var direct = this.runProps(this.kid(r, "rPr"));
		var props = this.merge({}, base);
		if (direct.style) {
			this.merge(props, this.style(model, direct.style).rpr);
		}
		this.merge(props, direct);
		if (props.hidden) {
			return;
		}
		var span = null;
		var self = this;
		function text(t) {
			if (!span) {
				span = document.createElement("span");
				self.applyRun(span, props);
				into.appendChild(span);
			}
			span.appendChild(document.createTextNode(t));
		}
		for (var c = r.firstChild; c; c = c.nextSibling) {
			if (c.nodeType !== 1) {
				continue;
			}
			var name = c.localName;
			if (c.namespaceURI === this.MC && name === "AlternateContent") {
				// Two versions of the same drawing: the newer one (DrawingML) if it is there,
				// else the old one's picture.
				var newer = c.getElementsByTagNameNS(this.W, "drawing");
				if (newer.length) {
					this.drawing(model, newer[0], into, state);
				} else if (c.getElementsByTagNameNS(this.V, "imagedata").length) {
					this.picture(model, c, into);
				}
				span = null;
				continue;
			}
			if (c.namespaceURI !== this.W) {
				continue;
			}
			// A field is: begin, its code, separate, the text to show, end.
			if (name === "fldChar") {
				var kind = this.att(c, "fldCharType");
				if (kind === "begin") {
					state.inField++;
					state.hide = true;
				} else if (kind === "separate") {
					state.hide = false;
				} else if (kind === "end") {
					state.inField = Math.max(0, state.inField - 1);
					state.hide = false;
				}
				continue;
			}
			if (state.hide) {
				continue;
			}
			if (name === "t") {
				text(PP.plainGlyphs(c.textContent || ""));
			} else if (name === "tab") {
				text("\u2003\u2003");
			} else if (name === "br") {
				var type = this.att(c, "type");
				if (type === "page" && state.flags) {
					this.pageBreak(state);
				} else if (type === "page") {
					var gap = document.createElement("span");
					gap.className = "pp-page-gap";
					into.appendChild(gap);
				} else {
					into.appendChild(document.createElement("br"));
				}
				span = null;
			} else if (name === "lastRenderedPageBreak" && state.flags) {
				// Word's own note of where it started a new page when it last laid the text out.
				this.pageBreak(state);
			} else if (name === "footnoteReference" || name === "endnoteReference") {
				// A note's number in the text; the notes themselves are listed at the end.
				var list = name === "footnoteReference" ? model.used.foot : model.used.end;
				list.push(this.att(c, "id"));
				this.noteMark(into, props, name === "footnoteReference" ? String(list.length) : this.roman(list.length));
				span = null;
			} else if ((name === "footnoteRef" || name === "endnoteRef") && model.noteLabel) {
				// The note's own number, at the start of its text.
				this.noteMark(into, props, model.noteLabel);
				span = null;
			} else if (name === "cr") {
				into.appendChild(document.createElement("br"));
				span = null;
			} else if (name === "noBreakHyphen") {
				text("-");
			} else if (name === "softHyphen") {
				text("\u00AD");
			} else if (name === "sym") {
				var code = parseInt(this.att(c, "char") || "", 16);
				// Symbol-font characters live in a private range the TouchPad cannot draw.
				text(isNaN(code) || code >= 0xF000 ? "\u2022" : String.fromCharCode(code));
			} else if (name === "drawing") {
				this.drawing(model, c, into, state);
				span = null;
			} else if (name === "pict" || name === "object") {
				this.picture(model, c, into);
				span = null;
			}
		}
	},

	// A page break in a paragraph that sits directly on a page: before anything of the
	// paragraph it opens the new page with this paragraph, otherwise the page ends after it.
	pageBreak: function(state) {
		var holder = state.holder;
		var empty = !holder.lastChild || (state.labelled && holder.childNodes.length === 1);
		if (empty) {
			state.flags.pageStarts = true;
		} else {
			state.flags.pageEnds = true;
		}
	},

	noteMark: function(into, props, label) {
		var mark = document.createElement("span");
		var look = this.merge({}, props);
		look.vertical = "superscript";
		this.applyRun(mark, look);
		mark.appendChild(document.createTextNode(label));
		into.appendChild(mark);
	},

	// Paragraph formatting as CSS on a block. Lengths are in points.
	applyPara: function(el, props) {
		var s = el.style;
		if (props.align) { s.textAlign = props.align; }
		if (props.left) { s.marginLeft = props.left + "pt"; }
		if (props.right) { s.marginRight = props.right + "pt"; }
		if (props.first) { s.textIndent = props.first + "pt"; }
		s.marginTop = (props.before || 0) + "pt";
		s.marginBottom = (props.after || 0) + "pt";
		if (props.line !== undefined) { s.lineHeight = String(props.line); }
		if (props.background) { s.backgroundColor = props.background; }
		if (props.borderTop && props.borderTop !== "none") { s.borderTop = props.borderTop; }
		if (props.borderBottom && props.borderBottom !== "none") { s.borderBottom = props.borderBottom; }
		if (props.borderLeft && props.borderLeft !== "none") { s.borderLeft = props.borderLeft; s.paddingLeft = "4pt"; }
		if (props.borderRight && props.borderRight !== "none") { s.borderRight = props.borderRight; s.paddingRight = "4pt"; }
		if (props.pageBreak) { el.className += " pp-page-break"; }
	},

	// Run formatting as CSS on a span.
	applyRun: function(span, p) {
		var s = span.style;
		if (p.bold) { s.fontWeight = "bold"; }
		if (p.italic) { s.fontStyle = "italic"; }
		var lines = [];
		if (p.underline) { lines.push("underline"); }
		if (p.strike) { lines.push("line-through"); }
		if (lines.length) { s.textDecoration = lines.join(" "); }
		if (p.color) { s.color = p.color; }
		if (p.background) { s.backgroundColor = p.background; }
		if (p.size) { s.fontSize = p.size + "pt"; }
		if (p.caps) { s.textTransform = "uppercase"; }
		if (p.smallCaps) { s.fontVariant = "small-caps"; }
		if (p.vertical === "superscript") {
			s.verticalAlign = "super";
			s.fontSize = (p.size || 11) * 0.65 + "pt";
		} else if (p.vertical === "subscript") {
			s.verticalAlign = "sub";
			s.fontSize = (p.size || 11) * 0.65 + "pt";
		}
		if (p.font) {
			// Few fonts are on the TouchPad; keep the kind of face at least.
			var kind = /courier|consolas|mono|lucida console/i.test(p.font) ? "monospace" :
				(/times|georgia|cambria|garamond|serif|book|palatino|minion/i.test(p.font) &&
					!/sans/i.test(p.font) ? "serif" : "sans-serif");
			s.fontFamily = "'" + p.font.replace(/['"\\]/g, "") + "', " + kind;
		}
	},

	// A picture placed in the text. Both the current kind (w:drawing) and the old one (w:pict).
	picture: function(model, node, into) {
		var id = null;
		var width = 0;
		var height = 0;
		var blips = node.getElementsByTagNameNS(this.A, "blip");
		if (blips.length) {
			id = blips[0].getAttributeNS(this.R, "embed") || blips[0].getAttribute("r:embed");
			var extents = node.getElementsByTagNameNS(this.WP, "extent");
			if (extents.length) {
				width = (parseFloat(extents[0].getAttribute("cx")) || 0) / 12700;
				height = (parseFloat(extents[0].getAttribute("cy")) || 0) / 12700;
			}
		} else {
			var old = node.getElementsByTagNameNS(this.V, "imagedata");
			if (old.length) {
				id = old[0].getAttributeNS(this.R, "id") || old[0].getAttribute("r:id");
				var shape = old[0].parentNode;
				var style = (shape && shape.getAttribute && shape.getAttribute("style")) || "";
				var w = /width:\s*([\d.]+)pt/.exec(style);
				var h = /height:\s*([\d.]+)pt/.exec(style);
				width = w ? parseFloat(w[1]) : 0;
				height = h ? parseFloat(h[1]) : 0;
			}
		}
		var rel = id && model.rels[id];
		if (!rel || rel.external) {
			return;
		}
		var target = rel.target.replace(/^\/+/, "");
		var path = /^word\//.test(target) || rel.target.charAt(0) === "/" ? target : "word/" + target;
		var img = document.createElement("img");
		img.className = "pp-picture";
		// Windows metafiles cannot be drawn by the web engine.
		if (/\.(emf|wmf)$/i.test(path)) {
			var box = document.createElement("span");
			box.className = "pp-missing";
			box.appendChild(document.createTextNode("[picture]"));
			if (width && height) {
				box.style.width = width + "pt";
				box.style.height = height + "pt";
			}
			into.appendChild(box);
			return;
		}
		img.src = PP.fileUrl(model.dir + "/" + path);
		if (width && height) {
			img.style.width = width + "pt";
			img.style.height = height + "pt";
		}
		into.appendChild(img);
	},

	// ---- drawings (oox/source/drawingml, writerfilter's GraphicImport) ----------------------------

	// The first child element with this name, whatever its namespace (drawings mix several).
	child: function(node, name) {
		for (var c = node ? node.firstChild : null; c; c = c.nextSibling) {
			if (c.nodeType === 1 && c.localName === name) {
				return c;
			}
		}
		return null;
	},
	children: function(node) {
		var out = [];
		for (var c = node ? node.firstChild : null; c; c = c.nextSibling) {
			if (c.nodeType === 1) {
				out.push(c);
			}
		}
		return out;
	},

	// The document's theme: its twelve named colors.
	readTheme: function(model) {
		model.theme = {};
		var part = model.parts.theme;
		if (!part) {
			return;
		}
		delete model.parts.theme;
		var scheme = part.doc.getElementsByTagNameNS(this.A, "clrScheme")[0];
		var list = this.children(scheme);
		for (var i = 0; i < list.length; i++) {
			var c = this.children(list[i])[0];
			var value = c && (c.getAttribute("val") || c.getAttribute("lastClr"));
			if (this.color(value)) {
				model.theme[list[i].localName] = this.color(value);
			}
		}
	},

	// The color an element holds (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr inside it),
	// with its lighter/darker changes applied; undefined if it holds none.
	drawingColor: function(model, holder) {
		var list = this.children(holder);
		for (var i = 0; i < list.length; i++) {
			var c = list[i];
			var base;
			if (c.localName === "srgbClr") {
				base = this.color(c.getAttribute("val"));
			} else if (c.localName === "sysClr") {
				base = this.color(c.getAttribute("lastClr")) || (c.getAttribute("val") === "window" ? "#ffffff" : "#000000");
			} else if (c.localName === "schemeClr") {
				var name = c.getAttribute("val");
				name = {tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2"}[name] || name;
				base = (model.theme || {})[name] ||
					{dk1: "#000000", lt1: "#ffffff", dk2: "#44546a", lt2: "#e7e6e6", accent1: "#4472c4", accent2: "#ed7d31",
					accent3: "#a5a5a5", accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47"}[name];
			} else if (c.localName === "prstClr") {
				base = {black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
					yellow: "#ffff00", gray: "#808080", lightGray: "#d3d3d3", darkGray: "#a9a9a9"}[c.getAttribute("val")];
			} else {
				continue;
			}
			if (!base) {
				return undefined;
			}
			var rgb = [parseInt(base.substring(1, 3), 16), parseInt(base.substring(3, 5), 16), parseInt(base.substring(5, 7), 16)];
			var mods = this.children(c);
			for (var m = 0; m < mods.length; m++) {
				var by = (parseFloat(mods[m].getAttribute("val")) || 0) / 100000;
				for (var k = 0; k < 3; k++) {
					switch (mods[m].localName) {
					case "shade": case "lumMod": rgb[k] = rgb[k] * by; break;
					case "tint": rgb[k] = rgb[k] * by + 255 * (1 - by); break;
					case "lumOff": rgb[k] = rgb[k] + 255 * by; break;
					}
				}
			}
			var out = "#";
			for (var j = 0; j < 3; j++) {
				var hex = Math.max(0, Math.min(255, Math.round(rgb[j]))).toString(16);
				out += hex.length < 2 ? "0" + hex : hex;
			}
			return out;
		}
		return undefined;
	},

	// A w:drawing: something in the line of text (wp:inline) or placed on the page (wp:anchor).
	drawing: function(model, node, into, state) {
		var place = this.child(node, "inline") || this.child(node, "anchor");
		if (!place) {
			return;
		}
		var extent = this.child(place, "extent");
		var width = extent ? (parseFloat(extent.getAttribute("cx")) || 0) / 12700 : 0;
		var height = extent ? (parseFloat(extent.getAttribute("cy")) || 0) / 12700 : 0;
		var data = this.child(this.child(place, "graphic"), "graphicData");
		var content = this.children(data)[0];
		var made = content ? this.drawingNode(model, content, width, height, 0) : null;
		if (!made) {
			return;
		}
		var s = made.style;
		if (place.localName === "inline" || !state || !state.holder) {
			into.appendChild(made);
			return;
		}
		var section = model.section || this.section(null);
		var column = section.width - section.left - section.right;
		var self = this;
		// How far across or down, from what.
		function position(name) {
			var pos = self.child(place, name);
			var from = pos ? pos.getAttribute("relativeFrom") : "";
			var offset = self.child(pos, "posOffset");
			var align = self.child(pos, "align");
			return {from: from, offset: offset ? (parseFloat(offset.textContent) || 0) / 12700 : 0,
				align: align ? align.textContent : ""};
		}
		var h = position("positionH");
		var v = position("positionV");
		var fromPage = h.from === "page" || h.from === "leftMargin";
		var room = fromPage ? section.width : column;
		var x = h.align === "center" ? (room - width) / 2 : (h.align === "right" ? room - width : h.offset);
		if (fromPage) {
			x -= section.left;
		}
		var wrap = "";
		var kinds = this.children(place);
		for (var i = 0; i < kinds.length; i++) {
			if (/^wrap/.test(kinds[i].localName)) {
				wrap = kinds[i].localName;
			}
		}
		if (wrap === "wrapNone" || wrap === "") {
			// Text ignores it: it lies over or under the text and takes up no room. It hangs
			// from a spot of no size at the start of its paragraph (as in Doc.js).
			var holder = document.createElement("span");
			holder.className = "pp-anchor";
			s.position = "absolute";
			s.left = (Math.max(-section.left, x) - (state.indent || 0)) + "pt";
			s.top = (v.from === "paragraph" || v.from === "line" ? v.offset : 0) + "pt";
			s.zIndex = place.getAttribute("behindDoc") === "1" ? "-1" : "1";
			holder.appendChild(made);
			state.holder.insertBefore(holder, state.holder.firstChild);
		} else if (wrap === "wrapTopAndBottom") {
			s.display = "block";
			s.marginLeft = Math.max(-section.left, x) + "pt";
			s.marginBottom = "6pt";
			into.appendChild(made);
		} else {
			// Text runs beside it: it goes to whichever side it is nearer.
			var right = x + width / 2 > column / 2;
			s.cssFloat = right ? "right" : "left";
			s.margin = right ? "0 0 6pt 9pt" : "0 9pt 6pt 0";
			state.holder.insertBefore(made, state.holder.firstChild);
		}
	},

	// One drawn thing as a node of a size in points: a picture (pic:pic), a shape or text
	// box (wps:wsp), or a group of them (wpg:wgp, wpg:grpSp).
	drawingNode: function(model, el, width, height, depth) {
		var name = el.localName;
		var node;
		if (name === "pic") {
			var blip = el.getElementsByTagNameNS(this.A, "blip")[0];
			var id = blip && (blip.getAttributeNS(this.R, "embed") || blip.getAttribute("r:embed"));
			node = this.imageNode(model, id, width, height);
			if (node) {
				node.style.display = "inline-block";
				node.style.verticalAlign = "top";
			}
			return node;
		}
		if (name !== "wsp" && name !== "wgp" && name !== "grpSp") {
			return null;
		}
		node = document.createElement("span");
		node.className = "pp-shape";
		node.style.width = Math.max(0, width) + "pt";
		node.style.height = Math.max(0, height) + "pt";
		if (name === "wsp") {
			this.shape(model, el, node, width, height);
			return node;
		}
		if (depth > 5) {
			return node;
		}
		// A group: its members sit in its own coordinates.
		var xfrm = this.child(this.child(el, "grpSpPr"), "xfrm");
		var chOff = this.child(xfrm, "chOff");
		var chExt = this.child(xfrm, "chExt");
		function n(e, a) { return e ? parseFloat(e.getAttribute(a)) || 0 : 0; }
		var scaleX = chExt && n(chExt, "cx") ? width / n(chExt, "cx") : 1 / 12700;
		var scaleY = chExt && n(chExt, "cy") ? height / n(chExt, "cy") : 1 / 12700;
		var members = this.children(el);
		for (var i = 0; i < members.length; i++) {
			var member = members[i];
			if (member.localName !== "wsp" && member.localName !== "pic" && member.localName !== "grpSp") {
				continue;
			}
			var own = this.child(this.child(member, member.localName === "grpSp" ? "grpSpPr" : "spPr"), "xfrm");
			var off = this.child(own, "off");
			var ext = this.child(own, "ext");
			var kid = this.drawingNode(model, member, n(ext, "cx") * scaleX, n(ext, "cy") * scaleY, depth + 1);
			if (kid) {
				kid.style.position = "absolute";
				kid.style.left = (n(off, "x") - n(chOff, "x")) * scaleX + "pt";
				kid.style.top = (n(off, "y") - n(chOff, "y")) * scaleY + "pt";
				node.appendChild(kid);
			}
		}
		return node;
	},

	// A document's own outline for a shape (a:custGeom), in the form of PresetTable.js.
	customGeometry: function(geom) {
		var self = this;
		function guides(list) {
			var out = [];
			var gd = self.children(list);
			for (var i = 0; i < gd.length; i++) {
				if (gd[i].localName === "gd") {
					out.push(gd[i].getAttribute("name"), gd[i].getAttribute("fmla"));
				}
			}
			return out;
		}
		function value(v) {
			return /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
		}
		var def = {av: guides(this.child(geom, "avLst")), gd: guides(this.child(geom, "gdLst")), paths: []};
		var rect = this.child(geom, "rect");
		if (rect) {
			def.rect = [value(rect.getAttribute("l")), value(rect.getAttribute("t")), value(rect.getAttribute("r")), value(rect.getAttribute("b"))];
		}
		var paths = this.children(this.child(geom, "pathLst"));
		var letters = {moveTo: "M", lnTo: "L", cubicBezTo: "C", quadBezTo: "Q"};
		for (var i = 0; i < paths.length; i++) {
			var path = paths[i];
			var one = {c: []};
			if (path.getAttribute("w")) { one.w = parseFloat(path.getAttribute("w")); }
			if (path.getAttribute("h")) { one.h = parseFloat(path.getAttribute("h")); }
			var fill = path.getAttribute("fill");
			if (fill && fill !== "norm") { one.fill = fill; }
			var stroke = path.getAttribute("stroke");
			if (stroke === "false" || stroke === "0") { one.stroke = false; }
			var commands = this.children(path);
			for (var k = 0; k < commands.length; k++) {
				var c = commands[k];
				if (c.localName === "close") {
					one.c.push("Z");
				} else if (c.localName === "arcTo") {
					one.c.push("A", value(c.getAttribute("wR")), value(c.getAttribute("hR")),
						value(c.getAttribute("stAng")), value(c.getAttribute("swAng")));
				} else if (letters[c.localName]) {
					one.c.push(letters[c.localName]);
					var pts = this.children(c);
					for (var q = 0; q < pts.length; q++) {
						one.c.push(value(pts[q].getAttribute("x")), value(pts[q].getAttribute("y")));
					}
				}
			}
			def.paths.push(one);
		}
		return def;
	},

	// A shape (wps:wsp) drawn into its node: its outline, fill and line, and its text.
	shape: function(model, el, node, width, height) {
		var spPr = this.child(el, "spPr");
		var style = this.child(el, "style");
		var xfrm = this.child(spPr, "xfrm");
		var flipH = !!xfrm && xfrm.getAttribute("flipH") === "1";
		var flipV = !!xfrm && xfrm.getAttribute("flipV") === "1";
		var s = node.style;
		// What it looks like: a preset by name, or its own outline.
		var prst = this.child(spPr, "prstGeom");
		var cust = this.child(spPr, "custGeom");
		var kind = prst ? prst.getAttribute("prst") : "";
		var def = cust ? this.customGeometry(cust) : PP.Drawing.preset(kind || "rect");
		var adjust = {};
		var given = this.children(this.child(prst, "avLst"));
		for (var i = 0; i < given.length; i++) {
			adjust[given[i].getAttribute("name")] = given[i].getAttribute("fmla");
		}
		// Its fill: said outright, or by the shape's style.
		var fill;
		if (this.child(spPr, "noFill")) {
			fill = null;
		} else if (this.child(spPr, "solidFill")) {
			fill = this.drawingColor(model, this.child(spPr, "solidFill")) || null;
		} else if (this.child(spPr, "gradFill")) {
			// A blend of colors is drawn as its first color.
			var stop = this.child(spPr, "gradFill").getElementsByTagNameNS(this.A, "gs")[0];
			fill = (stop && this.drawingColor(model, stop)) || null;
		} else {
			var fillRef = this.child(style, "fillRef");
			fill = fillRef && fillRef.getAttribute("idx") !== "0" ? this.drawingColor(model, fillRef) || null : null;
		}
		// Its line.
		var ln = this.child(spPr, "ln");
		var lnRef = this.child(style, "lnRef");
		var line = null;
		if (ln && this.child(ln, "noFill")) {
			line = null;
		} else if (ln && this.child(ln, "solidFill")) {
			line = this.drawingColor(model, this.child(ln, "solidFill")) || "#000000";
		} else if (lnRef && lnRef.getAttribute("idx") !== "0") {
			line = this.drawingColor(model, lnRef) || "#000000";
		} else if (ln && !style) {
			line = "#000000";
		}
		var emu = ln ? parseFloat(ln.getAttribute("w")) : NaN;
		var stroke = Math.max(1, Math.round((isNaN(emu) ? 9525 : emu) / 9525));
		var dash = this.child(ln, "prstDash");
		var dashKind = dash ? {dash: 6, sysDash: 1, dot: 5, sysDot: 2, lgDash: 7, dashDot: 8, sysDashDot: 3,
			lgDashDot: 9, lgDashDotDot: 10, sysDashDotDot: 4}[dash.getAttribute("val")] : 0;
		function arrow(e) { return !!e && !!e.getAttribute("type") && e.getAttribute("type") !== "none"; }
		var startArrow = arrow(this.child(ln, "headEnd"));
		var endArrow = arrow(this.child(ln, "tailEnd"));
		var px = 96 / 72;
		var drawing = null;
		var boxed = !cust && (kind === "rect" || kind === "") ;
		var straight = !cust && (kind === "line" || kind === "straightConnector1");
		if (straight) {
			if (line) {
				drawing = PP.Shapes.line({width: width * px, height: height * px, line: line, lineWidth: stroke,
					flipH: flipH, flipV: flipV, dash: dashKind, startArrow: startArrow, endArrow: endArrow});
			}
		} else if (boxed && !dashKind) {
			// A plain box is cheaper as a box than as a drawing.
			if (fill) { s.backgroundColor = fill; }
			if (line) { s.border = stroke + "px solid " + line; }
		} else if (def) {
			drawing = PP.Drawing.draw(def, {width: width * px, height: height * px, adjust: adjust,
				fill: fill, line: line, lineWidth: stroke, flipH: flipH, flipV: flipV});
		}
		if (drawing) {
			var c = drawing.canvas;
			c.style.position = "absolute";
			c.style.left = c.style.top = -drawing.margin + "px";
			c.style.width = c.width + "px";
			c.style.height = c.height + "px";
			node.appendChild(c);
		}
		// Its text, inside the part of the shape meant for text.
		var content = this.child(this.child(el, "txbx"), "txbxContent");
		if (content) {
			var inside = document.createElement("span");
			inside.className = "pp-textbox";
			var body = this.child(el, "bodyPr");
			var sides = [["tIns", 45720], ["rIns", 91440], ["bIns", 45720], ["lIns", 91440]];
			var padding = [];
			for (var k = 0; k < sides.length; k++) {
				var inset = body ? parseFloat(body.getAttribute(sides[k][0])) : NaN;
				padding.push((isNaN(inset) ? sides[k][1] : inset) / 12700 + "pt");
			}
			inside.style.padding = padding.join(" ");
			this.blocks(model, content, inside);
			var area = !boxed && def ? PP.Drawing.textArea(def, width * px, height * px, adjust) : null;
			inside.style.position = "absolute";
			inside.style.overflow = "hidden";
			inside.style.webkitBoxSizing = inside.style.boxSizing = "border-box";
			if (area) {
				inside.style.left = area[0] / px + "pt";
				inside.style.top = area[1] / px + "pt";
				inside.style.width = (area[2] - area[0]) / px + "pt";
				inside.style.height = (area[3] - area[1]) / px + "pt";
			} else {
				inside.style.left = inside.style.top = "0";
				inside.style.width = width + "pt";
				inside.style.height = height + "pt";
			}
			node.appendChild(inside);
		}
	},

	// A stored picture by its relationship id, as a node of a size in points; null if there is none.
	imageNode: function(model, id, width, height) {
		var rel = id && model.rels[id];
		if (!rel || rel.external) {
			return null;
		}
		var target = rel.target.replace(/^\/+/, "");
		var path = /^word\//.test(target) || rel.target.charAt(0) === "/" ? target : "word/" + target;
		var node;
		if (/\.(emf|wmf)$/i.test(path)) {
			// Windows metafiles cannot be drawn by the web engine.
			node = document.createElement("span");
			node.className = "pp-missing";
			node.appendChild(document.createTextNode("[picture]"));
		} else {
			node = document.createElement("img");
			node.className = "pp-picture";
			node.src = PP.fileUrl(model.dir + "/" + path);
		}
		if (width && height) {
			node.style.width = width + "pt";
			node.style.height = height + "pt";
		}
		return node;
	},

	// ---- tables (DomainMapperTableManager) --------------------------------------------------------

	table: function(model, tbl) {
		var table = document.createElement("table");
		table.className = "pp-table";
		var tblPr = this.kid(tbl, "tblPr");
		var borders = this.kid(tblPr, "tblBorders");
		var styleRef = this.kid(tblPr, "tblStyle");
		// Borders set on the table win; otherwise the table style's (and what it is based on).
		var id = styleRef ? this.att(styleRef, "val") : null;
		var seen = {};
		while (!borders && id && model.styles[id] && !seen[id]) {
			seen[id] = true;
			borders = model.styles[id].tableBorders;
			id = model.styles[id].based;
		}
		// Paragraph settings the table style gives to the text in its cells.
		var outerPpr = model.cellPpr;
		model.cellPpr = styleRef ? this.style(model, this.att(styleRef, "val")).ppr : {};
		var edge = {
			top: this.border(this.kid(borders, "top")), bottom: this.border(this.kid(borders, "bottom")),
			left: this.border(this.kid(borders, "left")) || this.border(this.kid(borders, "start")),
			right: this.border(this.kid(borders, "right")) || this.border(this.kid(borders, "end")),
			insideH: this.border(this.kid(borders, "insideH")), insideV: this.border(this.kid(borders, "insideV"))
		};
		var jc = this.kid(tblPr, "jc");
		if (jc && this.att(jc, "val") === "center") {
			table.style.marginLeft = "auto";
			table.style.marginRight = "auto";
		}

		var rows = this.kids(tbl, "tr");
		// Cells joined downward: column -> the cell that started the join.
		var open = {};
		for (var r = 0; r < rows.length; r++) {
			var tr = document.createElement("tr");
			var cells = this.kids(rows[r], "tc");
			var column = 0;
			for (var c = 0; c < cells.length; c++) {
				var tcPr = this.kid(cells[c], "tcPr");
				var span = this.kid(tcPr, "gridSpan");
				var cols = span ? parseInt(this.att(span, "val"), 10) || 1 : 1;
				var merge = this.kid(tcPr, "vMerge");
				if (merge && this.att(merge, "val") !== "restart") {
					// Continues the cell above: that one grows instead.
					if (open[column]) {
						open[column].rowSpan = (open[column].rowSpan || 1) + 1;
					}
					column += cols;
					continue;
				}
				var td = document.createElement("td");
				if (cols > 1) {
					td.colSpan = cols;
				}
				open[column] = merge ? td : null;
				var width = this.kid(tcPr, "tcW");
				if (width && this.att(width, "type") === "dxa") {
					td.style.width = this.number(this.att(width, "w")) / 20 + "pt";
				}
				var shade = this.kid(tcPr, "shd");
				var fill = shade ? this.color(this.att(shade, "fill")) : undefined;
				if (fill) {
					td.style.backgroundColor = fill;
				}
				var align = this.kid(tcPr, "vAlign");
				if (align) {
					var v = this.att(align, "val");
					td.style.verticalAlign = v === "center" ? "middle" : (v === "bottom" ? "bottom" : "top");
				}
				// The cell's own borders, else the table's: outer edges or inside lines.
				var own = this.kid(tcPr, "tcBorders");
				var last = c === cells.length - 1;
				var sides = {
					Top: this.border(this.kid(own, "top")) || (r === 0 ? edge.top : edge.insideH),
					Bottom: this.border(this.kid(own, "bottom")) || (r === rows.length - 1 ? edge.bottom : edge.insideH),
					Left: this.border(this.kid(own, "left")) || this.border(this.kid(own, "start")) ||
						(c === 0 ? edge.left : edge.insideV),
					Right: this.border(this.kid(own, "right")) || this.border(this.kid(own, "end")) ||
						(last ? edge.right : edge.insideV)
				};
				for (var side in sides) {
					if (sides[side] && sides[side] !== "none") {
						td.style["border" + side] = sides[side];
					}
				}
				this.blocks(model, cells[c], td);
				tr.appendChild(td);
				column += cols;
			}
			table.appendChild(tr);
		}
		model.cellPpr = outerPpr;
		return table;
	}
};
