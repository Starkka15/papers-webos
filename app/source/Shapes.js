/* -*- Mode: JavaScript; tab-width: 4 -*- */
/*
 * This file is part of Papers and is derived from the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following license notice:
 *
 *   Licensed to the Apache Software Foundation (ASF) under one or more
 *   contributor license agreements. See the NOTICE file distributed
 *   with this work for additional information regarding copyright
 *   ownership. The ASF licenses this file to you under the Apache
 *   License, Version 2.0 (the "License"); you may not use this file
 *   except in compliance with the License. You may obtain a copy of
 *   the License at http://www.apache.org/licenses/LICENSE-2.0 .
 */

// Draws the preset shapes of Microsoft Office's drawing layer (arrows, stars, callouts,
// flowchart symbols...) on a canvas. A translation to JavaScript of the parts of
// LibreOffice that do this:
//   svx/source/customshapes/EnhancedCustomShape2d.cxx
//     GetEquation, AppendEnhancedCustomShapeEquationParameter  -> formula()
//     SetPathSize, GetParameter, GetPoint                      -> scale(), parameter(), point()
//     CreateSubPath, CreateArc                                 -> subPath(), arc()
//     GetLuminanceChange, GetColorData                         -> shade()
//     GetTextRect                                              -> PP.Shapes.textArea()
//   svx/source/svdraw/svdoashp.cxx   lcl_ShapeSegmentFromBinary -> the segment codes in subPath()
//   filter/source/msfilter/msdffimp.cxx  the adjust values that are angles -> adjustments()
//   basegfx/source/polygon/b2dpolygontools.cxx, tools/source/generic/poly.cxx
//     the ellipse and arc builders, here as straight pieces short enough to look round
// The shapes themselves are in ShapeTable.js, generated from LibreOffice's table.
//
// Not carried over: handles (they are for editing), glue points, shadows, text on a path.

PP.Shapes = {
	// Is there an outline for this shape number?
	has: function(kind) {
		return PP.ShapeTable.byType[kind] !== undefined;
	},

	// Shapes that have no fill, or no outline, unless the document says they do
	// (IsCustomShapeFilledByDefault, IsCustomShapeStrokedByDefault).
	filledByDefault: function(kind) {
		return kind >= 0x100 || (PP.ShapeTable.unfilled[kind >> 4] & (1 << (kind & 0xF))) === 0;
	},
	strokedByDefault: function(kind) {
		return kind >= 0x100 || (PP.ShapeTable.unstroked[kind >> 4] & (1 << (kind & 0xF))) === 0;
	},

	// The preset shapes drawn as whole ellipses whatever angles their "U" segments give.
	// (ellipse, ring, smiley, sun, forbidden, flowchart connector, summing junction, or, cloud callout)
	WHOLE_ELLIPSES: {3: 1, 23: 1, 96: 1, 183: 1, 57: 1, 120: 1, 123: 1, 124: 1, 106: 1},

	// A shape ready to be measured or drawn at a size:
	//   kind: the shape number;  width, height: its box, in pixels
	//   adjust: the document's adjust values (missing ones take the shape's defaults)
	setup: function(kind, width, height, adjust) {
		var def = PP.ShapeTable.shapes[PP.ShapeTable.byType[kind]];
		if (!def) {
			return null;
		}
		var g = {kind: kind, def: def, width: width, height: height, results: [], busy: []};
		g.adjust = this.adjustments(def, adjust || []);
		this.scale(g);
		return g;
	},

	// The adjust values: the document's where it gives them, the shape's defaults elsewhere.
	// Those that set an angle are stored as 16.16 fixed point and are made plain degrees.
	adjustments: function(def, given) {
		var defaults = def.d || [];
		var out = [];
		var count = Math.max(defaults.length, given.length);
		for (var i = 0; i < count; i++) {
			var value = given[i];
			if (value === undefined || value === null) {
				value = defaults[i] || 0;
			} else if (def.p & (1 << i)) {
				value = value / 65536;
			}
			out.push(value);
		}
		return out;
	},

	// SetPathSize: how the shape's grid maps to its box. A shape may say its outline
	// stops stretching one way (x or y set): then that way is scaled like the other.
	scale: function(g) {
		var def = g.def;
		g.coordWidth = def.w;
		g.coordHeight = def.h;
		g.xScale = def.w === 0 ? 0 : g.width / def.w;
		g.yScale = def.h === 0 ? 0 : g.height / def.h;
		g.xRatio = 1;
		g.yRatio = 1;
		if (def.x !== undefined && g.height) {
			g.xRatio = g.width / g.height;
			if (g.xRatio > 1) {
				g.xScale /= g.xRatio;
			} else {
				g.xRatio = 1;
			}
		}
		if (def.y !== undefined && g.width) {
			g.yRatio = g.height / g.width;
			if (g.yRatio > 1) {
				g.yScale /= g.yRatio;
			} else {
				g.yRatio = 1;
			}
		}
	},

	// One value of a formula (AppendEnhancedCustomShapeEquationParameter).
	operand: function(g, value, special) {
		if (!special) {
			return value;
		}
		if (value & 0x400) {
			return this.formula(g, value & 0xFF);
		}
		if (value >= 327 && value <= 336) {
			return g.adjust[value - 327] || 0;  // an adjust value
		}
		switch (value) {
		case 320: return 0;                              // left
		case 321: return 0;                              // top
		case 322: return g.coordWidth * g.xRatio;        // right
		case 323: return g.coordHeight * g.yRatio;       // bottom
		}
		return 0;
	},

	// The result of formula n (GetEquation, and the evaluation of what it writes).
	formula: function(g, n) {
		var c = g.def.c;
		if (!c || n * 4 + 3 >= c.length) {
			return 0;
		}
		if (g.results[n] !== undefined) {
			return g.results[n];
		}
		if (g.busy[n]) {
			return 0;  // a formula that needs itself
		}
		g.busy[n] = true;
		var flags = c[n * 4];
		var special1 = (flags & 0x2000) !== 0;
		var special2 = (flags & 0x4000) !== 0;
		var special3 = (flags & 0x8000) !== 0;
		var raw2 = c[n * 4 + 2];
		var raw3 = c[n * 4 + 3];
		var self = this;
		// Values are worked out only when the operation uses them, as in the original.
		function p1() { return self.operand(g, c[n * 4 + 1], special1); }
		function p2() { return self.operand(g, raw2, special2); }
		function p3() { return self.operand(g, raw3, special3); }
		var rad = Math.PI / 180;
		var r = 0;
		var a, b;
		switch (flags & 0xFF) {
		case 0:
		case 14:
			r = p1() + p2() - (special3 || raw3 ? p3() : 0);
			break;
		case 1:
			r = p1();
			if (special2 || raw2 !== 1) { r *= p2(); }
			if (special3 || (raw3 !== 1 && raw3 !== 0)) { r /= p3(); }
			break;
		case 2: r = (p1() + p2()) / 2; break;
		case 3: r = Math.abs(p1()); break;
		case 4: r = Math.min(p1(), p2()); break;
		case 5: r = Math.max(p1(), p2()); break;
		case 6: r = p1() > 0 ? p2() : p3(); break;
		case 7:
			a = p1(); b = p2(); r = p3();
			r = Math.sqrt(a * a + b * b + r * r);
			break;
		case 8: r = Math.atan2(p2(), p1()) / rad; break;
		case 9: r = p1() * Math.sin(p2() * rad); break;
		case 10: r = p1() * Math.cos(p2() * rad); break;
		case 11: r = p1() * Math.cos(Math.atan2(p3(), p2())); break;
		case 12: r = p1() * Math.sin(Math.atan2(p3(), p2())); break;
		case 13: r = Math.sqrt(p1()); break;
		case 15:
			a = p1() / p2();
			r = p3() * Math.sqrt(1 - a * a);
			break;
		case 16: r = p1() * Math.tan(p2()); break;
		case 0x80:
			a = p1(); b = p3();
			r = Math.sqrt(b * b - a * a);
			break;
		case 0x81:
			a = p3() * rad;
			r = (Math.cos(a) * (p1() - 10800) + Math.sin(a) * (p2() - 10800)) + 10800;
			break;
		case 0x82:
			a = p3() * rad;
			r = -(Math.sin(a) * (p1() - 10800) - Math.cos(a) * (p2() - 10800)) + 10800;
			break;
		}
		if (!isFinite(r)) {
			r = 0;
		}
		g.busy[n] = false;
		g.results[n] = r;
		return r;
	},

	// GetParameter: one number of a point, on the shape's grid. A number equal to the
	// grid's width or height is stretched along when the shape keeps its proportions.
	parameter: function(g, value, replaceWidth, replaceHeight) {
		if ((value >>> 16) === 0x8000) {
			return this.formula(g, value & 0xFFFF);
		}
		value = value | 0;
		if (replaceWidth && value === g.coordWidth) {
			return value * g.xRatio;
		}
		if (replaceHeight && value === g.coordHeight) {
			return value * g.yRatio;
		}
		return value;
	},

	// GetPoint: point number n of the shape, in pixels within its box.
	point: function(g, n) {
		var v = g.def.v;
		return [this.parameter(g, v[n * 2], true, false) * g.xScale,
			this.parameter(g, v[n * 2 + 1], false, true) * g.yScale];
	},

	// Points along an ellipse from one angle to another, the way angles grow (down the
	// screen from the right: clockwise as seen). Angles in radians, 0 to 2 pi.
	// (basegfx::utils::createPolygonFromEllipseSegment)
	ellipsePiece: function(cx, cy, rx, ry, from, to) {
		var points = [];
		if (to < from) {
			to += 2 * Math.PI;
		}
		var steps = Math.max(1, Math.ceil((to - from) / (Math.PI / 30)));
		if (to - from < 1e-9) {
			steps = 0;
		}
		for (var i = 0; i <= steps; i++) {
			var a = steps ? from + (to - from) * i / steps : from;
			points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
		}
		return points;
	},

	// lcl_getNormalizedCircleAngleRad: an angle to a point on the ellipse, as the angle
	// that reaches the same point when the ellipse is drawn as a squashed circle.
	circleAngle: function(wr, hr, degrees) {
		var d = degrees % 360;
		if (d < 0) {
			d += 360;
		}
		if (d === 0 || d === 90 || d === 180 || d === 270) {
			return d * Math.PI / 180;
		}
		var x = hr * Math.cos(d * Math.PI / 180);
		var y = wr * Math.sin(d * Math.PI / 180);
		var r = 0;
		if (x !== 0 || y !== 0) {
			r = Math.atan2(y, x);
			if (r < 0) {
				r += 2 * Math.PI;
			}
		}
		return r;
	},

	// CreateArc: the part of the ellipse in a box between the directions of two points,
	// going counter-clockwise as seen from start to end, or clockwise from end to start
	// with the points handed over the other way around. (tools::Polygon's arc.)
	arc: function(left, top, right, bottom, start, end, clockwise) {
		if (left > right || top > bottom) {
			var swap = (left > right ? 1 : 0) ^ (top > bottom ? 1 : 0);
			var t;
			if (left > right) { t = left; left = right; right = t; }
			if (top > bottom) { t = top; top = bottom; bottom = t; }
			if (swap) { t = start; start = end; end = t; }
		}
		var cx = (left + right) / 2;
		var cy = (top + bottom) / 2;
		var rx = cx - left;
		var ry = cy - top;
		function where(p) {
			var dx = p[0] - cx;
			var a = Math.atan2(cy - p[1], dx === 0 ? 0.000000001 : dx);
			return Math.atan2(rx * Math.sin(a), ry * Math.cos(a));
		}
		var from = where(start);
		var diff = where(end) - from;
		if (diff < 0) {
			diff += 2 * Math.PI;
		}
		if (diff < 1e-9 && Math.abs(start[0] - end[0]) < 1e-6 && Math.abs(start[1] - end[1]) < 1e-6) {
			diff = 2 * Math.PI;  // the same point twice: all the way around
		}
		var steps = Math.max(1, Math.ceil(diff / (Math.PI / 30)));
		var points = [];
		for (var i = 0; i <= steps; i++) {
			var a = from + diff * i / steps;
			points.push([cx + rx * Math.cos(a), cy - ry * Math.sin(a)]);
		}
		if (clockwise) {
			points.reverse();
		}
		return points;
	},

	// CreateSubPath: the next part of the outline, up to where the segment list says a
	// part ends. state is {point, segment}, moved along. Returns
	//   {polygons: [{points: [[x, y]], closed}], noFill, noStroke}
	subPath: function(g, state) {
		var def = g.def;
		var segments = def.s || [];
		var total = def.v ? def.v.length / 2 : 0;
		var self = this;
		var polygons = [];
		var current = [];
		var closed = false;
		var part = {polygons: polygons, noFill: false, noStroke: false};
		var i, n, a, b, c, pts;

		// basegfx::utils::checkClosed: a polygon ending where it began is a closed one.
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
		function append(points) {
			for (var k = 0; k < points.length; k++) {
				current.push(points[k]);
			}
		}
		function curve(from, c1, c2, to) {
			for (var k = 1; k <= 16; k++) {
				var t = k / 16;
				var u = 1 - t;
				current.push([
					u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
					u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1]]);
			}
		}

		if (!segments.length) {
			// No segment list: the points in order, joined and closed.
			for (i = 0; i < total; i++) {
				current.push(this.point(g, i));
			}
			state.point = total;
			finish(true);
			state.segment = 1;
			return part;
		}

		while (state.segment < segments.length) {
			var code = segments[state.segment++];
			var command = code >> 8;
			var count = code & 0xFF;
			var ended = false;
			switch (command) {
			case 0xAA: part.noFill = true; break;
			case 0xAB: part.noStroke = true; break;
			case 0x40:  // move to
				finish(false);
				if (state.point < total) {
					current.push(this.point(g, state.point++));
				}
				break;
			case 0x80:  // end of this part
				ended = true;
				break;
			case 0x60:  // close
				if (current.length) {
					if (current.length > 1) {
						polygons.push({points: current, closed: true});
					}
					current = [];
				}
				break;
			case 0x20:  // curves
				count = count || 1;
				for (i = 0; i < count && state.point + 2 < total; i++) {
					a = this.point(g, state.point++);
					b = this.point(g, state.point++);
					c = this.point(g, state.point++);
					if (current.length) {
						curve(current[current.length - 1], a, b, c);
					} else {
						current.push(c);
					}
				}
				break;
			case 0x00:  // lines
				count = count || 1;
				for (i = 0; i < count && state.point < total; i++) {
					current.push(this.point(g, state.point++));
				}
				break;
			case 0xA1:  // ellipse by angles, from where the pen is
			case 0xA2:  // ellipse by angles, as a new figure
				count = Math.floor(count / 3);
				for (i = 0; i < count && state.point + 2 < total; i++) {
					if (command === 0xA2) {
						finish(false);
					}
					var center = this.point(g, state.point);
					var v = def.v;
					var wr = this.parameter(g, v[(state.point + 1) * 2], true, false);
					var hr = this.parameter(g, v[(state.point + 1) * 2 + 1], false, true);
					var startAngle = this.parameter(g, v[(state.point + 2) * 2], false, false);
					var endAngle = this.parameter(g, v[(state.point + 2) * 2 + 1], false, false);
					state.point += 3;
					var swr = wr * g.xScale;
					var shr = hr * g.yScale;
					if (swr === 0 && shr === 0) {
						current.push(center);
						continue;
					}
					if (this.WHOLE_ELLIPSES[g.kind]) {
						append(this.ellipsePiece(center[0], center[1], swr, shr, 0, Math.PI));
						append(this.ellipsePiece(center[0], center[1], swr, shr, Math.PI, 2 * Math.PI));
						continue;
					}
					if (Math.abs(Math.abs(endAngle - startAngle) - 360) < 1e-15) {
						// all the way around, as two halves
						append(this.ellipsePiece(center[0], center[1], swr, shr,
							this.circleAngle(wr, hr, startAngle), this.circleAngle(wr, hr, startAngle + 180)));
						append(this.ellipsePiece(center[0], center[1], swr, shr,
							this.circleAngle(wr, hr, startAngle + 180), this.circleAngle(wr, hr, endAngle)));
						continue;
					}
					append(this.ellipsePiece(center[0], center[1], swr, shr,
						this.circleAngle(wr, hr, startAngle), this.circleAngle(wr, hr, endAngle)));
				}
				break;
			case 0xA3:  // arc, from where the pen is
			case 0xA4:  // arc, as a new figure
			case 0xA5:  // clockwise arc, from where the pen is
			case 0xA6:  // clockwise arc, as a new figure
				var clockwise = command === 0xA5 || command === 0xA6;
				var xor = clockwise ? 3 : 2;
				count = count >> 2;
				for (i = 0; i < count && state.point + 3 < total; i++) {
					if (command === 0xA4 || command === 0xA6) {
						finish(false);
					}
					a = this.point(g, state.point);
					b = this.point(g, state.point + 1);
					if (Math.abs(a[0] - b[0]) > 1e-9 && Math.abs(a[1] - b[1]) > 1e-9) {
						append(this.arc(a[0], a[1], b[0], b[1],
							this.point(g, state.point + xor), this.point(g, state.point + (xor ^ 1)), clockwise));
					}
					state.point += 4;
				}
				break;
			case 0xA7:  // quarter ellipses, leaving level first
			case 0xA8:  // quarter ellipses, leaving upright first
				if (count && state.point < total) {
					var from;
					i = 0;
					if (state.point) {
						from = this.point(g, state.point - 1);
					} else {
						from = this.point(g, state.point);
						current.push(from);
						state.point++;
						i++;
					}
					var level = command === 0xA7;
					for (; i < count && state.point < total; i++) {
						var to = this.point(g, state.point);
						var rx = Math.abs(to[0] - from[0]);
						var ry = Math.abs(to[1] - from[1]);
						var cx, cy, s, e, flip;
						var half = Math.PI / 2;
						var leftward = to[0] < from[0];
						var upward = to[1] < from[1];
						if (level) {
							cx = from[0]; cy = to[1];
							if (leftward) {
								if (upward) { s = half; e = Math.PI; flip = false; }
								else { s = Math.PI; e = 3 * half; flip = true; }
							} else if (upward) { s = 0; e = half; flip = true; }
							else { s = 3 * half; e = 4 * half; flip = false; }
						} else {
							cx = to[0]; cy = from[1];
							if (leftward) {
								if (upward) { s = 3 * half; e = 4 * half; flip = true; }
								else { s = 0; e = half; flip = false; }
							} else if (upward) { s = Math.PI; e = 3 * half; flip = false; }
							else { s = half; e = Math.PI; flip = true; }
						}
						pts = this.ellipsePiece(cx, cy, rx, ry, s, e);
						if (flip) {
							pts.reverse();
						}
						append(pts);
						state.point++;
						level = !level;
						from = to;
					}
				}
				break;
			}
			if (ended) {
				break;
			}
		}
		if (state.segment === segments.length) {
			state.segment++;
		}
		finish(false);
		return part;
	},

	// All the parts of the outline.
	parts: function(g) {
		var state = {point: 0, segment: 0};
		var segments = g.def.s || [];
		var parts = [];
		var guard = 0;
		while (state.segment <= segments.length && guard++ < 200) {
			var part = this.subPath(g, state);
			if (part.polygons.length) {
				parts.push(part);
			}
		}
		return parts;
	},

	// GetLuminanceChange and GetColorData: some shapes shade their parts (the top of a
	// can, the sides of a cube). The shading table holds, four bits each, how many tenths
	// lighter or darker each filled part is.
	shade: function(color, kind, index) {
		var data = PP.ShapeTable.shading[kind] || 0;
		var count = data >>> 28;
		if (!count || !/^#[0-9a-fA-F]{6}$/.test(color)) {
			return color;
		}
		if (index >= count) {
			index = count - 1;
		}
		var luminance = ((data << ((1 + index) << 2)) >> 28) * 10;
		if (!luminance) {
			return color;
		}
		var r = parseInt(color.substring(1, 3), 16) / 255;
		var gr = parseInt(color.substring(3, 5), 16) / 255;
		var b = parseInt(color.substring(5, 7), 16) / 255;
		// to hue, saturation, value
		var max = Math.max(r, gr, b);
		var min = Math.min(r, gr, b);
		var delta = max - min;
		var h = 0;
		var s = max === 0 ? 0 : delta / max;
		var v = max;
		if (delta !== 0) {
			if (r === max) { h = (gr - b) / delta; }
			else if (gr === max) { h = 2 + (b - r) / delta; }
			else { h = 4 + (r - gr) / delta; }
			h *= 60;
			if (h < 0) { h += 360; }
		}
		if (luminance > 0) {
			s = s * (1 - luminance / 100);
			v = luminance / 100 + (1 - luminance / 100) * v;
		} else {
			v = (1 + luminance / 100) * v;
		}
		// and back
		if (s === 0) {
			r = gr = b = v;
		} else {
			var sector = (h % 360) / 60;
			var whole = Math.floor(sector);
			var f = sector - whole;
			var p = v * (1 - s);
			var q = v * (1 - s * f);
			var t = v * (1 - s * (1 - f));
			switch (whole) {
			case 0: r = v; gr = t; b = p; break;
			case 1: r = q; gr = v; b = p; break;
			case 2: r = p; gr = v; b = t; break;
			case 3: r = p; gr = q; b = v; break;
			case 4: r = t; gr = p; b = v; break;
			default: r = v; gr = p; b = q; break;
			}
		}
		function hex(x) {
			var n = Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16);
			return n.length < 2 ? "0" + n : n;
		}
		return "#" + hex(r) + hex(gr) + hex(b);
	},

	// Is a point inside a polygon? (crossing count)
	inside: function(point, points) {
		var x = point[0], y = point[1];
		var hit = false;
		for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
			var a = points[i], b = points[j];
			if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) {
				hit = !hit;
			}
		}
		return hit;
	},

	// LibreOffice fills a figure made of several outlines so that an outline inside
	// another is a hole (a ring, the eyes of a face). The TouchPad's canvas only fills
	// by the direction outlines run in, so make holes run the other way around.
	// (what basegfx::utils::correctOrientations does)
	orient: function(polygons) {
		if (polygons.length < 2) {
			return;
		}
		for (var i = 0; i < polygons.length; i++) {
			var points = polygons[i].points;
			var depth = 0;
			for (var j = 0; j < polygons.length; j++) {
				if (j !== i && this.inside(points[0], polygons[j].points)) {
					depth++;
				}
			}
			var area = 0;
			for (var k = 0, l = points.length - 1; k < points.length; l = k++) {
				area += (points[l][0] - points[k][0]) * (points[l][1] + points[k][1]);
			}
			if ((area > 0) !== (depth % 2 === 0)) {
				points.reverse();
			}
		}
	},

	// GetTextRect: where the shape's text goes, as [left, top, right, bottom] in pixels
	// within its box, or null if the shape does not say (then it is the whole box).
	textArea: function(kind, width, height, adjust, flipH, flipV) {
		var g = this.setup(kind, width, height, adjust);
		if (!g || !g.def.t || g.def.t.length < 4) {
			return null;
		}
		var t = g.def.t;
		var left = this.parameter(g, t[0], true, false) * g.xScale;
		var top = this.parameter(g, t[1], false, true) * g.yScale;
		var right = this.parameter(g, t[2], true, false) * g.xScale;
		var bottom = this.parameter(g, t[3], false, true) * g.yScale;
		if (flipH) {
			var l = width - right;
			right = width - left;
			left = l;
		}
		if (flipV) {
			var tp = height - bottom;
			bottom = height - top;
			top = tp;
		}
		if (!(right > left) || !(bottom > top)) {
			return null;
		}
		return [left, top, right, bottom];
	},

	// A straight line from one corner of its box to the opposite one, which may be
	// dashed and may end in arrowheads. (This part is Papers' own, not from LibreOffice:
	// the TouchPad's canvas has no dashes, so they are laid down piece by piece.)
	// options: {width, height (pixels), line, lineWidth, flipH, flipV, dash: MSO dash
	// style number, startArrow, endArrow: true or false}. Returns {canvas, margin}.
	DASHES: {1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1], 5: [1, 3], 6: [4, 3], 7: [8, 3],
		8: [4, 3, 1, 3], 9: [8, 3, 1, 3], 10: [8, 3, 1, 3, 1, 3]},
	line: function(options) {
		var width = options.width;
		var height = options.height;
		var w = Math.max(1, options.lineWidth || 1);
		var head = Math.max(8, w * 3.5);
		var margin = Math.ceil(head + w);
		var canvas = document.createElement("canvas");
		canvas.width = Math.ceil(width) + 2 * margin;
		canvas.height = Math.ceil(height) + 2 * margin;
		var ctx = canvas.getContext("2d");
		ctx.translate(margin, margin);
		var x1 = options.flipH ? width : 0, y1 = options.flipV ? height : 0;
		var x2 = options.flipH ? 0 : width, y2 = options.flipV ? 0 : height;
		var length = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
		if (length < 0.01) {
			return {canvas: canvas, margin: margin};
		}
		var ux = (x2 - x1) / length, uy = (y2 - y1) / length;
		// The line stops short inside an arrowhead, so its blunt end does not show past the tip.
		var from = options.startArrow ? Math.min(head * 0.8, length / 2) : 0;
		var to = length - (options.endArrow ? Math.min(head * 0.8, length / 2) : 0);
		var pattern = this.DASHES[options.dash];
		ctx.strokeStyle = ctx.fillStyle = options.line || "#000";
		ctx.lineWidth = w;
		ctx.beginPath();
		if (!pattern) {
			ctx.moveTo(x1 + ux * from, y1 + uy * from);
			ctx.lineTo(x1 + ux * to, y1 + uy * to);
		} else {
			var at = from, n = 0;
			while (at < to) {
				var piece = pattern[n % pattern.length] * w;
				if (n % 2 === 0) {
					ctx.moveTo(x1 + ux * at, y1 + uy * at);
					ctx.lineTo(x1 + ux * Math.min(to, at + piece), y1 + uy * Math.min(to, at + piece));
				}
				at += piece;
				n++;
			}
		}
		ctx.stroke();
		function arrow(tx, ty, dx, dy) {
			var bx = tx - dx * head, by = ty - dy * head;
			ctx.beginPath();
			ctx.moveTo(tx, ty);
			ctx.lineTo(bx - dy * head * 0.45, by + dx * head * 0.45);
			ctx.lineTo(bx + dy * head * 0.45, by - dx * head * 0.45);
			ctx.closePath();
			ctx.fill();
		}
		if (options.endArrow) { arrow(x2, y2, ux, uy); }
		if (options.startArrow) { arrow(x1, y1, -ux, -uy); }
		return {canvas: canvas, margin: margin};
	},

	// Draw a shape. options: {width, height (pixels), adjust: [], fill: color or null,
	// line: color or null, lineWidth (pixels), flipH, flipV}.
	// Returns {canvas, margin}: the canvas is larger than the shape's box by margin on
	// every side, so thick outlines and points outside the box are not cut off.
	draw: function(kind, options) {
		var width = Math.max(1, options.width);
		var height = Math.max(1, options.height);
		var g = this.setup(kind, width, height, options.adjust);
		if (!g) {
			return null;
		}
		var lineWidth = options.line ? Math.max(1, options.lineWidth || 1) : 0;
		var parts = this.parts(g);
		// How far outside its box does it reach? (callout tails, mostly)
		var reach = 0;
		var i, j, k, polygon, points;
		for (i = 0; i < parts.length; i++) {
			for (j = 0; j < parts[i].polygons.length; j++) {
				points = parts[i].polygons[j].points;
				for (k = 0; k < points.length; k++) {
					reach = Math.max(reach, -points[k][0], -points[k][1], points[k][0] - width, points[k][1] - height);
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
		var colorIndex = 0;
		var colorCount = (PP.ShapeTable.shading[kind] || 0) >>> 28;
		function trace(polygons, closeAll) {
			ctx.beginPath();
			for (var a = 0; a < polygons.length; a++) {
				var pts = polygons[a].points;
				ctx.moveTo(pts[0][0], pts[0][1]);
				for (var b = 1; b < pts.length; b++) {
					ctx.lineTo(pts[b][0], pts[b][1]);
				}
				if (closeAll || polygons[a].closed) {
					ctx.closePath();
				}
			}
		}
		for (i = 0; i < parts.length; i++) {
			var part = parts[i];
			var fills = options.fill && !part.noFill;
			var strokes = options.line && !part.noStroke;
			if (fills) {
				this.orient(part.polygons);
				trace(part.polygons, true);
				ctx.fillStyle = this.shade(options.fill, kind, colorCount ? Math.min(colorIndex, colorCount - 1) : colorIndex);
				ctx.fill();
			}
			// Each part takes the next shading, filled or not.
			if (colorIndex < colorCount) {
				colorIndex++;
			}
			if (strokes) {
				// A filled part that was closed all around is outlined closed; an open
				// one keeps its outline open even where it is filled.
				trace(part.polygons, false);
				ctx.strokeStyle = options.line;
				ctx.lineWidth = lineWidth;
				ctx.stroke();
			}
		}
		return {canvas: canvas, margin: margin};
	}
};
