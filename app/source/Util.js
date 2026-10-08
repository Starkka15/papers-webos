/* Shared helpers. (webOS 3 WebKit: ES5 only.) */
var PP = window.PP || {};

PP.log = function(msg) {
	try { console.log("[papers] " + msg); } catch (e) {}
};

// "1.4 MB"
PP.size = function(bytes) {
	if (bytes === undefined || bytes === null || isNaN(bytes)) {
		return "";
	}
	var units = ["bytes", "KB", "MB", "GB"];
	var n = bytes;
	var u = 0;
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024;
		u++;
	}
	return (u === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + units[u];
};

// "10/16/11 7:50 PM"
PP.when = function(ms) {
	if (!ms) {
		return "";
	}
	var d = new Date(ms);
	var h = d.getHours();
	var m = d.getMinutes();
	return (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).substring(2) + " " +
		((h % 12) || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM");
};

PP.extension = function(name) {
	var dot = name.lastIndexOf(".");
	return dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
};

// What a file is, going by its extension: "text", "sheet", "slides" or "plain".
PP.family = function(name) {
	var ext = PP.extension(name);
	if (/^(docx?|odt|rtf)$/.test(ext)) { return "text"; }
	if (/^(xlsx?|ods|csv)$/.test(ext)) { return "sheet"; }
	if (/^(pptx?|odp)$/.test(ext)) { return "slides"; }
	return "plain";
};

// A file on the TouchPad as an address the web engine will fetch.
PP.fileUrl = function(path) {
	var parts = path.split("/");
	for (var i = 0; i < parts.length; i++) {
		parts[i] = encodeURIComponent(parts[i]);
	}
	return "file://" + parts.join("/");
};

// Read a local file as text: callback(text) or callback(null) if it is not there.
PP.readText = function(path, callback) {
	var req = new XMLHttpRequest();
	var done = false;
	function finish(text) {
		if (!done) {
			done = true;
			callback(text);
		}
	}
	try {
		req.open("GET", PP.fileUrl(path), true);
	} catch (e) {
		finish(null);
		return;
	}
	req.onreadystatechange = function() {
		if (req.readyState === 4) {
			// A local file answers with status 0; an empty answer means it is missing.
			finish(req.responseText ? req.responseText : null);
		}
	};
	req.onerror = function() { finish(null); };
	try {
		req.send(null);
	} catch (e2) {
		finish(null);
	}
};

// Read a local XML file: callback(document) or callback(null).
PP.readXml = function(path, callback) {
	PP.readText(path, function(text) {
		if (!text) {
			callback(null);
			return;
		}
		var doc = null;
		try {
			doc = new DOMParser().parseFromString(text, "text/xml");
		} catch (e) {}
		if (doc && doc.getElementsByTagName("parsererror").length) {
			doc = null;
		}
		callback(doc);
	});
};

// Read a local file as bytes: callback(string with one character per byte), or
// callback(null). Use charCodeAt(i) & 0xFF to get a byte.
PP.readBinary = function(path, callback) {
	var req = new XMLHttpRequest();
	var done = false;
	function finish(data) {
		if (!done) {
			done = true;
			callback(data);
		}
	}
	try {
		req.open("GET", PP.fileUrl(path), true);
		// Keeps the web engine from decoding the bytes as text.
		req.overrideMimeType("text/plain; charset=x-user-defined");
	} catch (e) {
		finish(null);
		return;
	}
	req.onreadystatechange = function() {
		if (req.readyState === 4) {
			finish(req.responseText ? req.responseText : null);
		}
	};
	req.onerror = function() { finish(null); };
	try {
		req.send(null);
	} catch (e2) {
		finish(null);
	}
};

// Characters the TouchPad's fonts have no shape for (they draw as empty boxes), and
// the nearest character they do have. Add to this as more turn up.
PP.glyphs = {
	0x02B9: 0x27,    // modifier prime -> apostrophe
	0x02BA: 0x22,    // modifier double prime -> quotation mark
	0x2010: 0x2D,    // hyphen -> hyphen-minus
	0x2011: 0x2D     // non-breaking hyphen -> hyphen-minus
};

PP.plainGlyphs = function(text) {
	if (!/[\u02B9\u02BA\u2010\u2011]/.test(text)) {
		return text;
	}
	return text.replace(/[\u02B9\u02BA\u2010\u2011]/g, function(ch) {
		return String.fromCharCode(PP.glyphs[ch.charCodeAt(0)]);
	});
};
