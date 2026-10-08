/* Windows metafile pictures (.wmf): a list of drawing commands, drawn here onto a canvas.
 *
 * Old Office files keep clip art and pasted drawings this way, and the web engine
 * cannot show the format itself. The commands follow LibreOffice's reader
 * (emfio/source/reader/wmfreader.cxx): a "window" gives the coordinates the drawing
 * uses, pens and brushes are made, picked and deleted by slot number, and shapes are
 * outlined with the current pen and filled with the current brush.
 *
 * Handled: polygons and lines, rectangles, rounded rectangles, ellipses, arcs, pies
 * and chords, text, and bitmaps without compression. Not handled: clipping regions,
 * pattern and hatched brushes (drawn solid), raster operations, compressed bitmaps.
 *
 * PP.Wmf.draw(bytes, bounds, width, height) -> a <canvas> element, or null.
 *   bytes:  array of byte values (the metafile, with or without its "placeable" header)
 *   bounds: [left, top, right, bottom] the picture covers, if the file does not say
 *   width, height: the size to draw at, in CSS pixels
 */
PP.Wmf = {
	u16: function(b, at) {
		return b[at] | (b[at + 1] << 8);
	},

	s16: function(b, at) {
		var v = b[at] | (b[at + 1] << 8);
		return v >= 0x8000 ? v - 0x10000 : v;
	},

	u32: function(b, at) {
		return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 16777216;
	},

	color: function(b, at) {
		return "rgb(" + b[at] + "," + b[at + 1] + "," + b[at + 2] + ")";
	},

	draw: function(bytes, bounds, width, height) {
		var self = this;
		var canvas = document.createElement("canvas");
		// Keep the canvas a sensible size whatever the document asks for.
		var w = Math.max(1, Math.min(2048, Math.round(width)));
		var h = Math.max(1, Math.min(2048, Math.round(height)));
		canvas.width = w;
		canvas.height = h;
		var g = canvas.getContext && canvas.getContext("2d");
		if (!g) {
			return null;
		}

		var at = 0;
		if (bytes.length > 22 && this.u32(bytes, 0) === 0x9AC6CDD7) {
			// A "placeable" header: it gives the area the picture covers.
			bounds = [this.s16(bytes, 6), this.s16(bytes, 8), this.s16(bytes, 10), this.s16(bytes, 12)];
			at = 22;
		}
		if (bytes.length < at + 18) {
			return null;
		}
		bounds = bounds || [0, 0, 1000, 1000];
		at += this.u16(bytes, at + 2) * 2;

		// The drawing state. "org" and "ext" are the window: the drawing's own coordinates.
		var state = {orgX: bounds[0], orgY: bounds[1], extX: (bounds[2] - bounds[0]) || 1, extY: (bounds[3] - bounds[1]) || 1,
			pen: {style: 0, width: 0, color: "rgb(0,0,0)"}, brush: {style: 0, color: "rgb(255,255,255)"},
			font: {height: 0}, textColor: "rgb(0,0,0)", curX: 0, curY: 0};
		var saved = [];
		var objects = [];

		function X(x) { return (x - state.orgX) * w / state.extX; }
		function Y(y) { return (y - state.orgY) * h / state.extY; }

		function addObject(object) {
			for (var i = 0; i < objects.length; i++) {
				if (!objects[i]) {
					objects[i] = object;
					return;
				}
			}
			objects.push(object);
		}

		// Fill with the brush and outline with the pen, whichever are in use.
		function paint(fill) {
			if (fill && state.brush.style !== 1) {
				g.fillStyle = state.brush.color;
				g.fill();
			}
			if (state.pen.style !== 5) {
				g.strokeStyle = state.pen.color;
				g.lineWidth = Math.max(1, Math.abs(state.pen.width * w / state.extX));
				g.stroke();
			}
		}

		function path(points, from, count, close) {
			for (var i = 0; i < count; i++) {
				var x = X(self.s16(bytes, from + i * 4));
				var y = Y(self.s16(bytes, from + i * 4 + 2));
				if (i === 0) {
					g.moveTo(x, y);
				} else {
					g.lineTo(x, y);
				}
			}
			if (close) {
				g.closePath();
			}
		}

		// An ellipse inside a box, or part of one between two angles.
		function ellipse(left, top, right, bottom, startAngle, endAngle, toCenter, chord) {
			var cx = (X(left) + X(right)) / 2;
			var cy = (Y(top) + Y(bottom)) / 2;
			var rx = Math.abs(X(right) - X(left)) / 2;
			var ry = Math.abs(Y(bottom) - Y(top)) / 2;
			if (rx <= 0 || ry <= 0) {
				return;
			}
			g.save();
			g.translate(cx, cy);
			g.scale(rx, ry);
			g.beginPath();
			if (toCenter) {
				g.moveTo(0, 0);
			}
			// Windows draws arcs counter-clockwise.
			g.arc(0, 0, 1, startAngle, endAngle, startAngle !== 0 || endAngle !== Math.PI * 2);
			if (toCenter || chord) {
				g.closePath();
			}
			g.restore();
		}

		// The angle of a point as seen from the middle of a box, on the unit circle the ellipse is drawn from.
		function angle(x, y, left, top, right, bottom) {
			var cx = (X(left) + X(right)) / 2;
			var cy = (Y(top) + Y(bottom)) / 2;
			var rx = Math.abs(X(right) - X(left)) / 2 || 1;
			var ry = Math.abs(Y(bottom) - Y(top)) / 2 || 1;
			return Math.atan2((Y(y) - cy) / ry, (X(x) - cx) / rx);
		}

		// A bitmap stored in the file ("DIB"): returns a small canvas holding it, or null.
		function bitmap(p, end) {
			if (p + 40 > end) {
				return null;
			}
			var headerSize = self.u32(bytes, p);
			var bw = self.u32(bytes, p + 4);
			var bh = self.u32(bytes, p + 8);
			var bottomUp = true;
			if (bh >= 0x80000000) {
				bh = 0x100000000 - bh;
				bottomUp = false;
			}
			var bits = self.u16(bytes, p + 14);
			var compression = self.u32(bytes, p + 16);
			if (headerSize < 40 || compression !== 0 || bw < 1 || bh < 1 || bw > 2048 || bh > 2048) {
				return null;
			}
			var colors = bits <= 8 ? (self.u32(bytes, p + 32) || (1 << bits)) : 0;
			var palette = p + headerSize;
			var data = palette + colors * 4;
			var rowBytes = Math.floor((bw * bits + 31) / 32) * 4;
			if (data + rowBytes * bh > end) {
				return null;
			}
			var small = document.createElement("canvas");
			small.width = bw;
			small.height = bh;
			var sg = small.getContext("2d");
			var image = sg.createImageData(bw, bh);
			var px = image.data;
			for (var row = 0; row < bh; row++) {
				var src = data + (bottomUp ? bh - 1 - row : row) * rowBytes;
				var dst = row * bw * 4;
				for (var col = 0; col < bw; col++, dst += 4) {
					var c;
					if (bits === 24 || bits === 32) {
						c = src + col * (bits / 8);
						px[dst] = bytes[c + 2];
						px[dst + 1] = bytes[c + 1];
						px[dst + 2] = bytes[c];
					} else if (bits === 16) {
						var v = self.u16(bytes, src + col * 2);
						px[dst] = ((v >> 10) & 31) * 255 / 31;
						px[dst + 1] = ((v >> 5) & 31) * 255 / 31;
						px[dst + 2] = (v & 31) * 255 / 31;
					} else {
						var index;
						if (bits === 8) {
							index = bytes[src + col];
						} else if (bits === 4) {
							index = (bytes[src + (col >> 1)] >> ((col & 1) ? 0 : 4)) & 15;
						} else {
							index = (bytes[src + (col >> 3)] >> (7 - (col & 7))) & 1;
						}
						c = palette + index * 4;
						px[dst] = bytes[c + 2];
						px[dst + 1] = bytes[c + 1];
						px[dst + 2] = bytes[c];
					}
					px[dst + 3] = 255;
				}
			}
			sg.putImageData(image, 0, 0);
			return small;
		}

		function place(image, dstX, dstY, dstW, dstH) {
			if (image && dstW && dstH) {
				g.drawImage(image, X(dstX), Y(dstY), X(dstX + dstW) - X(dstX), Y(dstY + dstH) - Y(dstY));
			}
		}

		function text(str, x, y) {
			var size = Math.abs((state.font.height || 12) * h / state.extY);
			if (size < 1 || !str) {
				return;
			}
			g.font = Math.max(4, Math.round(size)) + "px sans-serif";
			g.fillStyle = state.textColor;
			g.textBaseline = "top";
			g.fillText(str, X(x), Y(y));
		}

		function chars(from, count) {
			var s = "";
			for (var i = 0; i < count; i++) {
				s += String.fromCharCode(bytes[from + i]);
			}
			return s;
		}

		var guard = 0;
		while (at + 6 <= bytes.length && guard++ < 200000) {
			var size = this.u32(bytes, at) * 2;
			var fn = this.u16(bytes, at + 4);
			var p = at + 6;
			var end = Math.min(bytes.length, at + size);
			if (fn === 0 || size < 6) {
				break;
			}
			var n;
			var i;
			var object;
			switch (fn) {
			case 0x020B: state.orgY = this.s16(bytes, p); state.orgX = this.s16(bytes, p + 2); break;
			case 0x020C: state.extY = this.s16(bytes, p) || 1; state.extX = this.s16(bytes, p + 2) || 1; break;
			case 0x02FA:
				addObject({kind: "pen", style: this.u16(bytes, p) & 0xF, width: this.s16(bytes, p + 2), color: this.color(bytes, p + 6)});
				break;
			case 0x02FC:
				addObject({kind: "brush", style: this.u16(bytes, p), color: this.color(bytes, p + 2)});
				break;
			case 0x02FB:
				addObject({kind: "font", height: this.s16(bytes, p)});
				break;
			case 0x00F7: case 0x06FF: case 0x0142: case 0x01F9:
				// A palette, a region or a pattern brush: it takes a slot even though it is not used.
				addObject({kind: fn === 0x0142 || fn === 0x01F9 ? "brush" : "other", style: 0, color: "rgb(128,128,128)"});
				break;
			case 0x012D:
				object = objects[this.u16(bytes, p)];
				if (object && object.kind === "pen") {
					state.pen = object;
				} else if (object && object.kind === "brush") {
					state.brush = object;
				} else if (object && object.kind === "font") {
					state.font = object;
				}
				break;
			case 0x01F0: objects[this.u16(bytes, p)] = null; break;
			case 0x0209: state.textColor = this.color(bytes, p); break;
			case 0x001E:
				saved.push({orgX: state.orgX, orgY: state.orgY, extX: state.extX, extY: state.extY, pen: state.pen,
					brush: state.brush, font: state.font, textColor: state.textColor, curX: state.curX, curY: state.curY});
				break;
			case 0x0127:
				if (saved.length) {
					state = saved.pop();
				}
				break;
			case 0x0324: case 0x0325:
				n = this.u16(bytes, p);
				if (p + 2 + n * 4 <= end && n > 0) {
					g.beginPath();
					path(bytes, p + 2, n, fn === 0x0324);
					paint(fn === 0x0324);
				}
				break;
			case 0x0538:
				// Several polygons as one shape: how many, the size of each, then all the points.
				n = this.u16(bytes, p);
				var points = p + 2 + n * 2;
				g.beginPath();
				for (i = 0; i < n; i++) {
					var count = this.u16(bytes, p + 2 + i * 2);
					if (points + count * 4 > end) {
						break;
					}
					path(bytes, points, count, true);
					points += count * 4;
				}
				paint(true);
				break;
			case 0x041B:
				// Bottom, right, top, left.
				g.beginPath();
				g.rect(X(this.s16(bytes, p + 6)), Y(this.s16(bytes, p + 4)),
					X(this.s16(bytes, p + 2)) - X(this.s16(bytes, p + 6)), Y(this.s16(bytes, p)) - Y(this.s16(bytes, p + 4)));
				paint(true);
				break;
			case 0x061C:
				// Corner height and width, then bottom, right, top, left.
				var rl = X(this.s16(bytes, p + 10));
				var rt = Y(this.s16(bytes, p + 8));
				var rr = X(this.s16(bytes, p + 6));
				var rb = Y(this.s16(bytes, p + 4));
				var cw = Math.min(Math.abs(this.s16(bytes, p + 2) * w / state.extX) / 2, Math.abs(rr - rl) / 2);
				var ch = Math.min(Math.abs(this.s16(bytes, p) * h / state.extY) / 2, Math.abs(rb - rt) / 2);
				g.beginPath();
				g.moveTo(rl + cw, rt);
				g.lineTo(rr - cw, rt);
				g.quadraticCurveTo(rr, rt, rr, rt + ch);
				g.lineTo(rr, rb - ch);
				g.quadraticCurveTo(rr, rb, rr - cw, rb);
				g.lineTo(rl + cw, rb);
				g.quadraticCurveTo(rl, rb, rl, rb - ch);
				g.lineTo(rl, rt + ch);
				g.quadraticCurveTo(rl, rt, rl + cw, rt);
				g.closePath();
				paint(true);
				break;
			case 0x0418:
				ellipse(this.s16(bytes, p + 6), this.s16(bytes, p + 4), this.s16(bytes, p + 2), this.s16(bytes, p), 0, Math.PI * 2, false, false);
				paint(true);
				break;
			case 0x0817: case 0x081A: case 0x0830:
				// End point, start point, then bottom, right, top, left.
				var al = this.s16(bytes, p + 14);
				var atp = this.s16(bytes, p + 12);
				var ar = this.s16(bytes, p + 10);
				var ab = this.s16(bytes, p + 8);
				ellipse(al, atp, ar, ab,
					angle(this.s16(bytes, p + 6), this.s16(bytes, p + 4), al, atp, ar, ab),
					angle(this.s16(bytes, p + 2), this.s16(bytes, p), al, atp, ar, ab),
					fn === 0x081A, fn === 0x0830);
				paint(fn !== 0x0817);
				break;
			case 0x0214: state.curY = this.s16(bytes, p); state.curX = this.s16(bytes, p + 2); break;
			case 0x0213:
				g.beginPath();
				g.moveTo(X(state.curX), Y(state.curY));
				state.curY = this.s16(bytes, p);
				state.curX = this.s16(bytes, p + 2);
				g.lineTo(X(state.curX), Y(state.curY));
				paint(false);
				break;
			case 0x0521:
				// How many characters, the characters (padded to an even count), then y and x.
				n = this.u16(bytes, p);
				var after = p + 2 + n + (n & 1);
				text(chars(p + 2, n), this.s16(bytes, after + 2), this.s16(bytes, after));
				break;
			case 0x0A32:
				// y, x, how many characters, options, an optional box, then the characters.
				n = this.u16(bytes, p + 4);
				var from = p + 8 + ((this.u16(bytes, p + 6) & 6) ? 8 : 0);
				if (from + n <= end) {
					text(chars(from, n), this.s16(bytes, p + 2), this.s16(bytes, p));
				}
				break;
			case 0x0F43:
				// Raster operation, color use, source height, width, y, x, then where it goes.
				place(bitmap(p + 22, end), this.s16(bytes, p + 20), this.s16(bytes, p + 18), this.s16(bytes, p + 16), this.s16(bytes, p + 14));
				break;
			case 0x0B41:
				if (size > 28) {
					place(bitmap(p + 20, end), this.s16(bytes, p + 18), this.s16(bytes, p + 16), this.s16(bytes, p + 14), this.s16(bytes, p + 12));
				}
				break;
			case 0x0940:
				if (size > 24) {
					place(bitmap(p + 16, end), this.s16(bytes, p + 14), this.s16(bytes, p + 12), this.s16(bytes, p + 10), this.s16(bytes, p + 8));
				}
				break;
			}
			at += size;
		}
		return canvas;
	}
};
