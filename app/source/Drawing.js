/* -*- Mode: JavaScript; tab-width: 4 -*- */
/*
 * This file is part of Papers and is derived from the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// Works out and draws the shapes of the newer Office formats (DrawingML: a:prstGeom
// and a:custGeom in .docx, .xlsx, .pptx). It follows LibreOffice:
//   oox/source/drawingml/customshapegeometry.cxx   what each guide formula means
//   svx/source/customshapes/EnhancedCustomShape2d.cxx
//     CreateSubPath (ARCANGLETO, the path commands), GetColorData -> path(), tone()
// The preset shapes are in PresetTable.js, generated from LibreOffice's definitions.
// A shape here is described as that table describes one:
//   {av: [name, formula...], gd: [name, formula...], rect: [l, t, r, b], paths: [{c, w, h, fill, stroke}]}

PP.Drawing = {
	EMU: 9525,  // English Metric Units to a pixel

	// The description of a preset shape by its name, or null.
	preset: function(name) {
		return PP.PresetTable[name] || null;
	},

	// Work out a shape's guides at a size.
	//   width, height: pixels;  adjust: {name: formula} from the document (a:avLst)
	// Returns {def, w, h, values: {name: number}}.
	setup: function(def, width, height, adjust) {
		var w = width * this.EMU;
		var h = height * this.EMU;
		var ss = Math.min(w, h);
		var ls = Math.max(w, h);
		var v = {
			"3cd4": 16200000, "3cd8": 8100000, "5cd8": 13500000, "7cd8": 18900000,
			cd2: 10800000, cd4: 5400000, cd8: 2700000,
			l: 0, t: 0, r: w, b: h, w: w, h: h, hc: w / 2, vc: h / 2, ss: ss, ls: ls,
			hd2: h / 2, hd3: h / 3, hd4: h / 4, hd5: h / 5, hd6: h / 6, hd8: h / 8, hd10: h / 10, hd12: h / 12, hd32: h / 32,
			wd2: w / 2, wd3: w / 3, wd4: w / 4, wd5: w / 5, wd6: w / 6, wd8: w / 8, wd10: w / 10, wd12: w / 12, wd32: w / 32,
			ssd2: ss / 2, ssd4: ss / 4, ssd6: ss / 6, ssd8: ss / 8, ssd16: ss / 16, ssd32: ss / 32
		};
		var g = {def: def, w: w, h: h, values: v};
		var i;
		var av = def.av || [];
		for (i = 0; i + 1 < av.length; i += 2) {
			v[av[i]] = this.formula(g, adjust && adjust[av[i]] !== undefined ? adjust[av[i]] : av[i + 1]);
		}
		// A document may set adjust values the description does not list.
		for (var name in adjust || {}) {
			if (v[name] === undefined) {
				v[name] = this.formula(g, adjust[name]);
			}
		}
		var gd = def.gd || [];
		for (i = 0; i + 1 < gd.length; i += 2) {
			v[gd[i]] = this.formula(g, gd[i + 1]);
		}
		return g;
	},

	// A number, or the value of a guide by name.
	value: function(g, token) {
		if (typeof token === "number") {
			return token;
		}
		if (token === undefined || token === null) {
			return 0;
		}
		var known = g.values[token];
		if (known !== undefined) {
			return known;
		}
		var n = parseFloat(token);
		return isNaN(n) ? 0 : n;
	},

	// One guide formula: an operation and up to three values. Angles are in 60,000ths
	// of a degree. (The meanings are those of convertToOOEquation in LibreOffice.)
	formula: function(g, text) {
		var parts = String(text).replace(/^\s+|\s+$/g, "").split(/\s+/);
		var op = parts[0];
		var x = this.value(g, parts[1]);
		var y = this.value(g, parts[2]);
		var z = this.value(g, parts[3]);
		var angle = Math.PI / 10800000;
		var r;
		switch (op) {
		case "val": r = x; break;
		case "*/": r = x * y / z; break;
		case "+-": r = x + y - z; break;
		case "+/": r = (x + y) / z; break;
		case "?:": r = x > 0 ? y : z; break;
		case "abs": r = Math.abs(x); break;
		case "at2": r = Math.atan2(y, x) / angle; break;
		case "cat2": r = x * Math.cos(Math.atan2(z, y)); break;
		case "sat2": r = x * Math.sin(Math.atan2(z, y)); break;
		case "cos": r = x * Math.cos(y * angle); break;
		case "sin": r = x * Math.sin(y * angle); break;
		case "tan": r = x * Math.tan(y * angle); break;
		case "max": r = Math.max(x, y); break;
		case "min": r = Math.min(x, y); break;
		case "mod": r = Math.sqrt(x * x + y * y + z * z); break;
		case "pin": r = x - y > 0 ? x : (z - y > 0 ? y : z); break;
		case "sqrt": r = Math.sqrt(x); break;
		default: r = parts.length === 1 ? this.value(g, op) : 0;
		}
		return isFinite(r) ? r : 0;
	},

	// One path of a shape as polygons in pixels: [{points: [[x, y]], closed}].
	path: function(g, path) {
		var c = path.c;
		var sx = (path.w ? g.w / path.w : 1) / this.EMU;
		var sy = (path.h ? g.h / path.h : 1) / this.EMU;
		var polygons = [];
		var current = [];
		var self = this;
		var i = 0;
		function num() { return self.value(g, c[i++]); }
		function finish(close) {
			if (current.length > 1) {
				var first = current[0];
				var last = current[current.length - 1];
				if (!close && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
					current.pop();
					close = true;
				}
				polygons.push({points: current, closed: close});
			}
			current = [];
		}
		function bezier(from, c1, c2, to) {
			for (var k = 1; k <= 16; k++) {
				var t = k / 16;
				var u = 1 - t;
				current.push([
					u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
					u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1]]);
			}
		}
		var a, b, d, from;
		while (i < c.length) {
			var command = c[i++];
			switch (command) {
			case "M":
				finish(false);
				current.push([num() * sx, num() * sy]);
				break;
			case "L":
				current.push([num() * sx, num() * sy]);
				break;
			case "Z":
				if (current.length > 1) {
					// Go on from where the closed figure began, as a pen would.
					from = current[0];
					polygons.push({points: current, closed: true});
					current = [];
				}
				break;
			case "C":
				a = [num() * sx, num() * sy];
				b = [num() * sx, num() * sy];
				d = [num() * sx, num() * sy];
				if (current.length) {
					bezier(current[current.length - 1], a, b, d);
				} else {
					current.push(d);
				}
				break;
			case "Q":
				a = [num() * sx, num() * sy];
				d = [num() * sx, num() * sy];
				if (current.length) {
					from = current[current.length - 1];
					bezier(from, [(from[0] + 2 * a[0]) / 3, (from[1] + 2 * a[1]) / 3],
						[(2 * a[0] + d[0]) / 3, (2 * a[1] + d[1]) / 3], d);
				} else {
					current.push(d);
				}
				break;
			case "A":
				// An arc of an ellipse of the given radii, starting where the pen is at the
				// start angle and swinging by the swing angle (clockwise above zero).
				// The angles are worked out on the path's own grid, before it is stretched to the box.
				var gridW = num();
				var gridH = num();
				var wr = gridW * sx;
				var hr = gridH * sy;
				var start = num() / 60000;
				var swing = Math.max(-360, Math.min(360, num() / 60000));
				if (!current.length || (wr === 0 && hr === 0)) {
					break;
				}
				var end = start + swing;
				if (swing < 0) { var keep = start; start = end; end = keep; }
				var piece = [];
				var at = start;
				if (swing >= 360 || swing <= -360) {
					var to = at + 180;
					while (to < end) {
						piece = piece.concat(PP.Shapes.ellipsePiece(wr, hr, wr, hr,
							PP.Shapes.circleAngle(gridW, gridH, at), PP.Shapes.circleAngle(gridW, gridH, to)));
						at = to;
						to += 180;
					}
				}
				piece = piece.concat(PP.Shapes.ellipsePiece(wr, hr, wr, hr,
					PP.Shapes.circleAngle(gridW, gridH, at), PP.Shapes.circleAngle(gridW, gridH, end)));
				if (swing < 0) {
					piece.reverse();
				}
				var pen = current[current.length - 1];
				var dx = pen[0] - piece[0][0];
				var dy = pen[1] - piece[0][1];
				for (var k = 1; k < piece.length; k++) {
					current.push([piece[k][0] + dx, piece[k][1] + dy]);
				}
				break;
			default:
				i = c.length;  // not a command: stop
			}
		}
		finish(false);
		return polygons;
	},

	// A path may ask for its fill a little lighter or darker than the shape's.
	tone: function(color, mode) {
		var by = {lighten: 0.4, lightenLess: 0.2, darken: -0.4, darkenLess: -0.2}[mode];
		if (!by || !/^#[0-9a-fA-F]{6}$/.test(color)) {
			return color;
		}
		var out = "#";
		for (var i = 1; i < 7; i += 2) {
			var v = parseInt(color.substring(i, i + 2), 16);
			v = by > 0 ? v * (1 - by) + by * 255 : v * (1 + by);
			var hex = Math.max(0, Math.min(255, Math.floor(v))).toString(16);
			out += hex.length < 2 ? "0" + hex : hex;
		}
		return out;
	},

	// Where the shape's text goes: [left, top, right, bottom] in pixels, or null.
	textArea: function(def, width, height, adjust) {
		if (!def || !def.rect) {
			return null;
		}
		var g = this.setup(def, width, height, adjust);
		var r = def.rect;
		var out = [this.value(g, r[0]) / this.EMU, this.value(g, r[1]) / this.EMU,
			this.value(g, r[2]) / this.EMU, this.value(g, r[3]) / this.EMU];
		return out[2] > out[0] && out[3] > out[1] ? out : null;
	},

	// Draw a shape. options: {width, height (pixels), adjust: {name: formula},
	// fill: color or null, line: color or null, lineWidth (pixels), flipH, flipV}.
	// Returns {canvas, margin}, the canvas larger than the shape's box by margin all around.
	draw: function(def, options) {
		var width = Math.max(1, options.width);
		var height = Math.max(1, options.height);
		var g = this.setup(def, width, height, options.adjust);
		var lineWidth = options.line ? Math.max(1, options.lineWidth || 1) : 0;
		var parts = [];
		var reach = 0;
		var i, j, k;
		for (i = 0; i < (def.paths || []).length; i++) {
			var polygons = this.path(g, def.paths[i]);
			parts.push(polygons);
			for (j = 0; j < polygons.length; j++) {
				var pts = polygons[j].points;
				for (k = 0; k < pts.length; k++) {
					reach = Math.max(reach, -pts[k][0], -pts[k][1], pts[k][0] - width, pts[k][1] - height);
				}
			}
		}
		var margin = Math.ceil(Math.min(reach, 2000) + lineWidth + 1);
		var canvas = document.createElement("canvas");
		canvas.width = Math.ceil(width) + 2 * margin;
		canvas.height = Math.ceil(height) + 2 * margin;
		var ctx = canvas.getContext("2d");
		ctx.translate(margin, margin);
		if (options.flipH) {
			ctx.translate(width, 0);
			ctx.scale(-1, 1);
		}
		if (options.flipV) {
			ctx.translate(0, height);
			ctx.scale(1, -1);
		}
		ctx.lineJoin = "miter";
		ctx.miterLimit = 8;
		function trace(list, closeAll) {
			ctx.beginPath();
			for (var a = 0; a < list.length; a++) {
				var p = list[a].points;
				ctx.moveTo(p[0][0], p[0][1]);
				for (var b = 1; b < p.length; b++) {
					ctx.lineTo(p[b][0], p[b][1]);
				}
				if (closeAll || list[a].closed) {
					ctx.closePath();
				}
			}
		}
		for (i = 0; i < parts.length; i++) {
			var path = def.paths[i];
			if (!parts[i].length) {
				continue;
			}
			if (options.fill && path.fill !== "none") {
				PP.Shapes.orient(parts[i]);
				trace(parts[i], true);
				ctx.fillStyle = this.tone(options.fill, path.fill);
				ctx.fill();
			}
			if (options.line && path.stroke !== false) {
				trace(parts[i], false);
				ctx.strokeStyle = options.line;
				ctx.lineWidth = lineWidth;
				ctx.stroke();
			}
		}
		return {canvas: canvas, margin: margin};
	}
};
