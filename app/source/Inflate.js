/* Unpacks "deflate" data (the compression inside zip files, PNG and zlib streams).
 *
 * Office files keep some parts packed this way inside other parts, where the zip
 * helper cannot reach: metafile pictures in old Word files are one. The method is
 * the standard one (RFC 1951): blocks that are stored as they are, or coded with
 * fixed or per-block Huffman tables, with repeats given as a length and a distance
 * back into what has already been produced.
 *
 * PP.inflate(data, at, length, zlib) -> array of byte values, or null if the data is bad.
 *   data:  a string with one character per byte (see PP.readBinary)
 *   zlib:  true if the data starts with zlib's two-byte header
 */
(function() {
	var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
	var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
	var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
		4097, 6145, 8193, 12289, 16385, 24577];
	var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
	// The order in which a block lists the code lengths of its code-length code.
	var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

	// A Huffman code from the length of each symbol's code: how many codes there are of
	// each length, and the symbols in code order.
	function Tree(lengths, count) {
		this.counts = [];
		this.symbols = [];
		var i;
		for (i = 0; i < 16; i++) {
			this.counts[i] = 0;
		}
		for (i = 0; i < count; i++) {
			this.counts[lengths[i]]++;
		}
		this.counts[0] = 0;
		var offsets = [];
		var sum = 0;
		for (i = 0; i < 16; i++) {
			offsets[i] = sum;
			sum += this.counts[i];
		}
		for (i = 0; i < count; i++) {
			if (lengths[i]) {
				this.symbols[offsets[lengths[i]]++] = i;
			}
		}
	}

	var fixedLengths = null;
	var fixedDistances = null;
	function fixedTrees() {
		if (!fixedLengths) {
			var lengths = [];
			var i;
			for (i = 0; i < 144; i++) { lengths[i] = 8; }
			for (i = 144; i < 256; i++) { lengths[i] = 9; }
			for (i = 256; i < 280; i++) { lengths[i] = 7; }
			for (i = 280; i < 288; i++) { lengths[i] = 8; }
			fixedLengths = new Tree(lengths, 288);
			var distances = [];
			for (i = 0; i < 30; i++) { distances[i] = 5; }
			fixedDistances = new Tree(distances, 30);
		}
	}

	PP.inflate = function(data, at, length, zlib) {
		var pos = at + (zlib ? 2 : 0);
		var end = at + length;
		var hold = 0;       // bits read from the data but not used yet
		var held = 0;
		var out = [];
		var bad = false;

		function bit() {
			if (!held) {
				if (pos >= end) {
					bad = true;
					return 0;
				}
				hold = data.charCodeAt(pos++) & 0xFF;
				held = 8;
			}
			var b = hold & 1;
			hold >>= 1;
			held--;
			return b;
		}

		function bits(count, base) {
			var value = 0;
			for (var i = 0; i < count; i++) {
				value |= bit() << i;
			}
			return value + base;
		}

		function symbol(tree) {
			var sum = 0;
			var code = 0;
			var len = 0;
			do {
				code = 2 * code + bit();
				len++;
				sum += tree.counts[len];
				code -= tree.counts[len];
			} while (code >= 0 && len < 15 && !bad);
			return tree.symbols[sum + code];
		}

		function block(lengthTree, distanceTree) {
			while (!bad) {
				var sym = symbol(lengthTree);
				if (sym === undefined) {
					bad = true;
					return;
				}
				if (sym === 256) {
					return;
				}
				if (sym < 256) {
					out.push(sym);
					continue;
				}
				sym -= 257;
				var count = bits(LENGTH_EXTRA[sym], LENGTH_BASE[sym]);
				var d = symbol(distanceTree);
				if (d === undefined || d > 29) {
					bad = true;
					return;
				}
				var from = out.length - bits(DIST_EXTRA[d], DIST_BASE[d]);
				if (from < 0) {
					bad = true;
					return;
				}
				for (var i = 0; i < count; i++) {
					out.push(out[from + i]);
				}
			}
		}

		function dynamicBlock() {
			var literals = bits(5, 257);
			var distances = bits(5, 1);
			var codes = bits(4, 4);
			var lengths = [];
			var i;
			for (i = 0; i < 19; i++) {
				lengths[i] = 0;
			}
			for (i = 0; i < codes; i++) {
				lengths[ORDER[i]] = bits(3, 0);
			}
			var codeTree = new Tree(lengths, 19);
			var all = [];
			while (all.length < literals + distances && !bad) {
				var sym = symbol(codeTree);
				var repeat;
				var value;
				if (sym === undefined) {
					bad = true;
				} else if (sym < 16) {
					all.push(sym);
				} else {
					if (sym === 16) {
						value = all.length ? all[all.length - 1] : 0;
						repeat = bits(2, 3);
					} else if (sym === 17) {
						value = 0;
						repeat = bits(3, 3);
					} else {
						value = 0;
						repeat = bits(7, 11);
					}
					while (repeat-- > 0) {
						all.push(value);
					}
				}
			}
			if (bad) {
				return;
			}
			block(new Tree(all.slice(0, literals), literals), new Tree(all.slice(literals, literals + distances), distances));
		}

		function storedBlock() {
			held = 0;  // the rest of the current byte is padding
			if (pos + 4 > end) {
				bad = true;
				return;
			}
			var count = (data.charCodeAt(pos) & 0xFF) | ((data.charCodeAt(pos + 1) & 0xFF) << 8);
			pos += 4;
			if (pos + count > end) {
				bad = true;
				return;
			}
			for (var i = 0; i < count; i++) {
				out.push(data.charCodeAt(pos++) & 0xFF);
			}
		}

		var last;
		do {
			last = bit();
			var type = bits(2, 0);
			if (type === 0) {
				storedBlock();
			} else if (type === 1) {
				fixedTrees();
				block(fixedLengths, fixedDistances);
			} else if (type === 2) {
				dynamicBlock();
			} else {
				bad = true;
			}
		} while (!last && !bad);

		return bad ? null : out;
	};
})();
