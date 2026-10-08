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
 * Not handled yet: headers and footers, footnotes, floating shapes and text
 * boxes placed off the text flow, charts, tracked-change display, page breaks as
 * real pages (the document is one continuous sheet).
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
		var model = {dir: dir, rels: {}, styles: {}, defaults: {ppr: {}, rpr: {}}, nums: {}, abstracts: {}};
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
						callback(model);
					});
				});
			});
		});
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

	// Builds the page inside container (a DOM node). Returns how many blocks it made.
	render: function(model, container) {
		var body = this.kid(model.doc.documentElement, "body");
		var sheet = document.createElement("div");
		sheet.className = "pp-sheet";
		// Page size and margins come from the last section; one sheet shows it all.
		var sect = body ? this.kid(body, "sectPr") : null;
		var size = this.kid(sect, "pgSz");
		var margins = this.kid(sect, "pgMar");
		var width = size ? this.number(this.att(size, "w")) / 20 : 612;
		sheet.style.width = width + "pt";
		if (margins) {
			sheet.style.padding = (this.number(this.att(margins, "top")) || 1440) / 20 + "pt " +
				(this.number(this.att(margins, "right")) || 1440) / 20 + "pt " +
				(this.number(this.att(margins, "bottom")) || 1440) / 20 + "pt " +
				(this.number(this.att(margins, "left")) || 1440) / 20 + "pt";
		}
		var count = this.blocks(model, body, sheet);
		container.appendChild(sheet);
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

	paragraph: function(model, p) {
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

		var state = {inField: 0};
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
				// Two versions of the same drawing: take the newer one's picture if it has one.
				var pictures = c.getElementsByTagNameNS(this.A, "blip");
				if (pictures.length) {
					this.picture(model, c, into);
				}
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
				text(c.textContent || "");
			} else if (name === "tab") {
				text("\u2003\u2003");
			} else if (name === "br") {
				var type = this.att(c, "type");
				if (type === "page") {
					var gap = document.createElement("span");
					gap.className = "pp-page-gap";
					into.appendChild(gap);
				} else {
					into.appendChild(document.createElement("br"));
				}
				span = null;
			} else if (name === "cr") {
				into.appendChild(document.createElement("br"));
				span = null;
			} else if (name === "noBreakHyphen") {
				text("\u2011");
			} else if (name === "softHyphen") {
				text("\u00AD");
			} else if (name === "sym") {
				var code = parseInt(this.att(c, "char") || "", 16);
				// Symbol-font characters live in a private range the TouchPad cannot draw.
				text(isNaN(code) || code >= 0xF000 ? "\u2022" : String.fromCharCode(code));
			} else if (name === "drawing" || name === "pict" || name === "object") {
				this.picture(model, c, into);
				span = null;
			}
		}
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
