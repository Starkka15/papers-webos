// File helper for the Papers app (node 0.4.12 on webOS 3 / webOS CE, ES5 only).
//
// A web app can neither look through the TouchPad's storage nor open a zip
// archive, and modern office files (docx, xlsx, pptx, odt...) are zip archives
// of XML. This service finds the documents on the TouchPad and unpacks one into
// a cache folder, where the app reads the parts it needs as plain files.

if (typeof require === "undefined") {
	require = IMPORTS.require;
}

var child_process = require("child_process");
var fs = require("fs");

var ROOT = "/media/internal";
var CACHE = ROOT + "/.papers/cache";
var KEEP = 4;                      // unpacked documents kept at a time
var TYPES = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|txt|csv)$/i;
var MAX_DEPTH = 7;
var LOADER = "/lib/ld-linux.so.3";
var PPZIP = "/media/cryptofs/apps/usr/palm/services/com.stark.papers.service/bin/ppzip";

function log(msg) {
	try { console.log("[ppfiles] " + msg); } catch (e) {}
}

function mkdirs(path) {
	var parts = path.split("/");
	var at = "";
	for (var i = 1; i < parts.length; i++) {
		at += "/" + parts[i];
		try { fs.mkdirSync(at, 493 /* 0755 */); } catch (e) {}
	}
}

// Documents under a folder: [{path, name, size, modified}]
function walk(dir, depth, out) {
	var names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return out;
	}
	for (var i = 0; i < names.length; i++) {
		var name = names[i];
		if (name.charAt(0) === ".") {
			continue;
		}
		var full = dir + "/" + name;
		var st;
		try {
			st = fs.statSync(full);
		} catch (e2) {
			continue;
		}
		if (st.isDirectory()) {
			if (depth < MAX_DEPTH) {
				walk(full, depth + 1, out);
			}
		} else if (TYPES.test(name)) {
			out.push({path: full, name: name, size: st.size, modified: st.mtime.getTime()});
		}
	}
	return out;
}

// A short name for one version of a file.
function keyFor(path, st) {
	var a = 5381;
	var b = 52711;
	var text = path + "|" + st.size + "|" + st.mtime.getTime();
	for (var i = 0; i < text.length; i++) {
		var c = text.charCodeAt(i);
		a = ((a * 33) ^ c) >>> 0;
		b = ((b * 31) + c) >>> 0;
	}
	return a.toString(36) + b.toString(36);
}

// Remove all but the newest few unpacked documents.
function trimCache(keep) {
	var names;
	try {
		names = fs.readdirSync(CACHE);
	} catch (e) {
		return;
	}
	var dirs = [];
	for (var i = 0; i < names.length; i++) {
		if (!/^[0-9a-z]+$/.test(names[i]) || names[i] === keep) {
			continue;
		}
		try {
			dirs.push({name: names[i], when: fs.statSync(CACHE + "/" + names[i]).mtime.getTime()});
		} catch (e2) {}
	}
	dirs.sort(function(x, y) { return y.when - x.when; });
	for (var k = KEEP - 1; k < dirs.length; k++) {
		// Only ever a plain name directly inside the cache folder.
		child_process.spawn("/bin/rm", ["-rf", CACHE + "/" + dirs[k].name]);
	}
}

// ---- commands ---------------------------------------------------------------

// Every document on the TouchPad.
var findAssistant = function() {};
findAssistant.prototype.run = function(future) {
	var files = walk(ROOT, 0, []);
	future.result = {returnValue: true, files: files};
	return future;
};

// {file} -> {dir}: the folder its contents were unpacked into.
var unpackAssistant = function() {};
unpackAssistant.prototype.run = function(future) {
	var args = this.controller.args || {};
	var file = String(args.file || "");
	var st;
	if (file.indexOf(ROOT + "/") !== 0 || /\/\.\.(\/|$)/.test(file)) {
		future.result = {returnValue: false, errorText: "The file is not on the TouchPad's storage."};
		return future;
	}
	try {
		st = fs.statSync(file);
	} catch (e) {
		future.result = {returnValue: false, errorText: "The file could not be found."};
		return future;
	}
	var key = keyFor(file, st);
	var dir = CACHE + "/" + key;
	var done = dir + "/.unpacked";
	try {
		fs.statSync(done);
		future.result = {returnValue: true, dir: dir};
		return future;
	} catch (e2) {}

	function failed(why) {
		log("unpack " + file + ": " + why);
		child_process.spawn("/bin/rm", ["-rf", dir]);
		future.result = {returnValue: false, errorText: "The file could not be opened. It may be damaged, " +
			"protected with a password, or not really this kind of file."};
	}

	// The TouchPad's own unzip cannot read archives written in one pass (most
	// current programs write them so) and stops when the storage refuses
	// permissions, so the unpacking is done by our own helper (native/ppzip.c).
	// It is started through the system's program loader, which does not need the
	// file to be marked as a program: installing a package does not keep that mark.
	mkdirs(dir);
	var errors = "";
	var child;
	try {
		child = child_process.spawn(LOADER, [PPZIP, "x", file, dir]);
	} catch (e3) {
		failed("the helper could not be started: " + e3);
		return future;
	}
	child.stderr.on("data", function(d) { errors += d.toString(); });
	child.on("exit", function(code) {
		if (code !== 0) {
			failed("ppzip " + code + ": " + errors.replace(/\s+$/, ""));
			return;
		}
		try { fs.writeFileSync(done, ""); } catch (e4) {}
		trimCache(key);
		future.result = {returnValue: true, dir: dir};
	});
	return future;
};
