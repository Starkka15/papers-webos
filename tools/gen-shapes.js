// Makes app/source/ShapeTable.js from LibreOffice's table of preset shapes.
//   node tools/gen-shapes.js <libreoffice-core checkout> [out file]
// It reads, from that checkout:
//   svx/source/customshapes/EnhancedCustomShapeGeometry.cxx  the outlines, formulas and defaults of each shape
//   svx/source/customshapes/EnhancedCustomShape2d.cxx        which parts of a shape are shaded lighter or darker
//   include/svx/msdffdef.hxx                                 the shape numbers and property numbers
// The data written is LibreOffice's, under the Mozilla Public License 2.0; this script
// only changes its form.
var fs = require("fs");
var path = require("path");

var core = process.argv[2];
var out = process.argv[3] || path.join(__dirname, "..", "app", "source", "ShapeTable.js");
if (!core) {
	console.log("usage: node gen-shapes.js <libreoffice-core checkout> [out file]");
	process.exit(1);
}
function read(rel) {
	return fs.readFileSync(path.join(core, rel), "utf8").replace(/\r\n/g, "\n");
}
function bare(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

var defs = read("include/svx/msdffdef.hxx");
var geometry = bare(read("svx/source/customshapes/EnhancedCustomShapeGeometry.cxx"));
var engine = bare(read("svx/source/customshapes/EnhancedCustomShape2d.cxx"));

// Names the tables use for numbers.
var names = {MIN_INT32: -0x80000000, M_SQRT2: Math.SQRT2};
var m;
var re = /#define\s+(DFF_Prop_\w+)\s+(\d+)/g;
while ((m = re.exec(defs))) {
	names[m[1]] = parseInt(m[2], 10);
}
var flags = {NONE: 0, MIRRORED_X: 1, MIRRORED_Y: 2, SWITCHED: 4, POLAR: 8, MAP: 0x10, RANGE: 0x20,
	RANGE_X_MIN_IS_SPECIAL: 0x80, RANGE_X_MAX_IS_SPECIAL: 0x100, RANGE_Y_MIN_IS_SPECIAL: 0x200,
	RANGE_Y_MAX_IS_SPECIAL: 0x400, CENTER_X_IS_SPECIAL: 0x800, CENTER_Y_IS_SPECIAL: 0x1000, RADIUS_RANGE: 0x2000};

// The shape numbers: mso_sptName = number.
var types = {};
re = /\b(mso_spt\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+|mso_spt\w+)/g;
while ((m = re.exec(bare(defs)))) {
	types[m[1]] = /^mso/.test(m[2]) ? types[m[2]] : Number(m[2]);
}

// Every array in the geometry file, as nested lists of numbers.
function value(body, name) {
	var js = body.replace(/\{/g, "[").replace(/\}/g, "]")
		.replace(/static_cast<sal_Int32>/g, "Math.floor")
		.replace(/\b(\d+)[lL]\b/g, "$1")  // a C long, as in "4l"
		.replace(/\bMSO_I\b/g, "|0x80000000")
		.replace(/SvxMSDffHandleFlags::(\w+)/g, function(all, f) { return String(flags[f]); })
		.replace(/\b[A-Za-z_]\w*\b/g, function(word) {
			if (/^0x/i.test(word) || word === "Math" || word === "floor") { return word; }
			if (names[word] === undefined) { throw new Error("unknown name " + word + " in " + name); }
			return "(" + names[word] + ")";
		});
	return new Function("return [" + js + "];")();
}
function flat(list, unsigned, into) {
	into = into || [];
	for (var i = 0; i < list.length; i++) {
		if (list[i] instanceof Array) {
			flat(list[i], unsigned, into);
		} else {
			// Points are written as whole numbers 0 to 2^32, so a reference to a formula keeps
			// its marker in the top half; everything else keeps its sign.
			into.push(unsigned && list[i] < 0 ? list[i] >>> 0 : list[i]);
		}
	}
	return into;
}
var arrays = {};
re = /const\s+(SvxMSDffVertPair|sal_uInt16|SvxMSDffCalculationData|sal_Int32|SvxMSDffTextRectangles|SvxMSDffHandle)\s+(\w+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/g;
while ((m = re.exec(geometry))) {
	arrays[m[2]] = {type: m[1], value: value(m[3], m[2])};
}

// Each shape: which arrays it is made of.
var shapes = {};
re = /const\s+mso_CustomShape\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*;/g;
while ((m = re.exec(geometry))) {
	var body = m[2];
	var spans = [];
	var rest = body.replace(/std::span<[^>]*>\s*\(\s*(\w*)\s*\)/g, function(all, n) { spans.push(n); return "0"; });
	var numbers = value(rest, m[1]);
	if (spans.length !== 7 || numbers.length < 11) {
		throw new Error("unexpected layout of " + m[1]);
	}
	// vertices, segments, formulas, defaults, text areas, width, height, x and y that stay put, glue points, handles
	var shape = {w: numbers[5], h: numbers[6]};
	if (spans[0]) { shape.v = flat(arrays[spans[0]].value, true); }
	if (spans[1]) { shape.s = flat(arrays[spans[1]].value); }
	if (spans[2]) { shape.c = flat(arrays[spans[2]].value); }
	if (spans[3]) { shape.d = flat(arrays[spans[3]].value).slice(1); }
	if (spans[4]) { shape.t = flat(arrays[spans[4]].value, true); }
	if (numbers[7] !== -0x80000000) { shape.x = numbers[7]; }
	if (numbers[8] !== -0x80000000) { shape.y = numbers[8]; }
	// Handles that turn about a point keep their setting as an angle in 16.16 fixed point:
	// one bit per handle, as DffPropertyReader::ApplyCustomShapeGeometryAttributes works it out.
	if (spans[6]) {
		var handles = arrays[spans[6]].value;
		var polar = 0;
		for (var i = 0; i < handles.length; i++) {
			if ((handles[i][0] & flags.POLAR) && (handles[i][2] >= 0x256 || handles[i][2] <= 0x107)) {
				polar |= 1 << i;
			}
		}
		if (polar) { shape.p = polar; }
	}
	shapes[m[1]] = shape;
}

// A switch that sets something per shape number: {number: what the cases set}.
function cases(text, pattern) {
	var result = {};
	var waiting = [];
	var token = new RegExp("case\\s+(mso_spt\\w+)\\s*:|" + pattern, "g");
	var t;
	while ((t = token.exec(text))) {
		if (t[1]) {
			waiting.push(t[1]);
		} else {
			for (var i = 0; i < waiting.length; i++) {
				if (types[waiting[i]] === undefined) { throw new Error("no number for " + waiting[i]); }
				result[types[waiting[i]]] = t[2];
			}
			waiting = [];
		}
	}
	return result;
}
var start = geometry.indexOf("const mso_CustomShape* GetCustomShapeContent");
var byType = cases(geometry.substring(start), "pCustomShape\\s*=\\s*&(\\w+)");
var used = {};
var count = 0;
for (var t in byType) {
	if (!shapes[byType[t]]) { throw new Error("no shape " + byType[t]); }
	used[byType[t]] = shapes[byType[t]];
	count++;
}
start = engine.indexOf("switch( m_eSpType )");
var end = engine.indexOf("sal_Int32 nLength = m_seqEquations.getLength()", start);
var shading = cases(engine.substring(start, end), "m_nColorData\\s*=\\s*(0x[0-9a-fA-F]+)");
for (var s in shading) {
	shading[s] = Number(shading[s]);
}
delete shading[types.mso_sptNil];  // "no preset": its cases are for LibreOffice's own shapes
function table(name) {
	return flat(arrays[name].value);
}

var lines = [
	"/* -*- Mode: JavaScript; tab-width: 4 -*- */",
	"/*",
	" * This file is part of Papers and is derived from the LibreOffice project.",
	" *",
	" * This Source Code Form is subject to the terms of the Mozilla Public",
	" * License, v. 2.0. If a copy of the MPL was not distributed with this",
	" * file, You can obtain one at http://mozilla.org/MPL/2.0/.",
	" *",
	" * This file incorporates work covered by the following license notice:",
	" *",
	" *   Licensed to the Apache Software Foundation (ASF) under one or more",
	" *   contributor license agreements. See the NOTICE file distributed",
	" *   with this work for additional information regarding copyright",
	" *   ownership. The ASF licenses this file to you under the Apache",
	" *   License, Version 2.0 (the \"License\"); you may not use this file",
	" *   except in compliance with the License. You may obtain a copy of",
	" *   the License at http://www.apache.org/licenses/LICENSE-2.0 .",
	" */",
	"",
	"// GENERATED by tools/gen-shapes.js. Do not edit; change the generator and run it again.",
	"//",
	"// The preset shapes of Microsoft Office's drawing layer (arrows, stars, callouts,",
	"// flowchart symbols...), taken from LibreOffice:",
	"//   svx/source/customshapes/EnhancedCustomShapeGeometry.cxx  (the shapes)",
	"//   svx/source/customshapes/EnhancedCustomShape2d.cxx        (the shading of their parts)",
	"//   include/svx/msdffdef.hxx                                 (the shape numbers)",
	"// PP.Shapes (Shapes.js) draws them.",
	"//",
	"// shapes: by LibreOffice's name for the shape,",
	"//   v  the points, as x, y, x, y...; a number whose top half is 0x8000 means \"the result of formula n\"",
	"//   s  how the points are joined (segment codes)",
	"//   c  the formulas, four numbers each: operation and flags, then three values",
	"//   d  the adjust values a shape has when the document gives none",
	"//   t  where text goes: left, top, right, bottom of each area",
	"//   w, h  the size of the grid the points are on",
	"//   x, y  where the shape stops stretching with its box, if it does",
	"//   p  which adjust values are angles in 16.16 fixed point (one bit each)",
	"// byType: shape number -> name.  shading: shape number -> how its parts are shaded.",
	"// unfilled, unstroked: bit tables of the shapes that have no fill or no outline unless told.",
	"",
	"PP.ShapeTable = {"
];
lines.push("\tshapes: {");
var keys = Object.keys(used).sort();
keys.forEach(function(k, i) {
	lines.push("\t\t" + k + ": " + JSON.stringify(used[k]).replace(/"(\w+)":/g, "$1:") + (i < keys.length - 1 ? "," : ""));
});
lines.push("\t},");
lines.push("\tbyType: " + JSON.stringify(byType).replace(/"(\d+)":/g, "$1:") + ",");
lines.push("\tshading: " + JSON.stringify(shading).replace(/"(\d+)":/g, "$1:") + ",");
lines.push("\tunfilled: " + JSON.stringify(table("mso_DefaultFillingTable")) + ",");
lines.push("\tunstroked: " + JSON.stringify(table("mso_DefaultStrokingTable")));
lines.push("};");
lines.push("");
fs.writeFileSync(out, lines.join("\n"));
console.log(count + " shape numbers, " + keys.length + " outlines, " + Object.keys(shading).length + " shaded; wrote " +
	fs.statSync(out).size + " bytes to " + out);
