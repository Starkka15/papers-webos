/* One open document. Which reader draws it depends on the kind of file. */
enyo.kind({
	name: "PP.DocView",
	kind: enyo.VFlexBox,
	className: "pp-docview",
	events: {
		onBack: ""
	},
	components: [
		{kind: "HFlexBox", align: "center", className: "pp-top", components: [
			{kind: "Button", caption: "Documents", className: "enyo-button-dark", onclick: "backClick"},
			{name: "title", className: "pp-bar-title pp-doc-title", flex: 1}
		]},
		// accelerated: false. Enyo's scroller normally moves its content with a 3D transform,
		// which makes everything inside it one layer on the graphics chip, as large as the
		// content: a 31-page document would be a texture of some 130 MB. The TouchPad's own
		// office app turned this off for its document and sheet scrollers for the same
		// reason. Moved by its "top" instead, the page is drawn in software and only the
		// part on screen costs anything.
		{name: "scroller", kind: "Scroller", flex: 1, className: "pp-desk", accelerated: false,
			onScrollStop: "scrollStopped", components: [
			{name: "note", className: "pp-doc-note", showing: false},
			{name: "other", kind: "Button", caption: "Open in Another App", className: "pp-other", showing: false,
				onclick: "openElsewhere"},
			// The readers build the document's HTML straight into this node.
			{name: "page", className: "pp-page"}
		]},
		{name: "unpackSvc", kind: "PalmService", service: "palm://com.stark.papers.service/", method: "unpack",
			onSuccess: "unpacked", onFailure: "unpackFailed"},
		{name: "openSvc", kind: "PalmService", service: "palm://com.palm.applicationManager/", method: "open"}
	],

	// file: {path, name}
	openFile: function(file) {
		this.file = file;
		this.opens = (this.opens || 0) + 1;
		var opening = this.opens;
		var name = file.name;
		try {
			name = decodeURIComponent(name);
		} catch (e) {}
		this.$.title.setContent(name);
		this.clearPage();
		this.$.other.setShowing(false);
		this.$.scroller.setScrollTop(0);
		this.started = new Date().getTime();
		var ext = PP.extension(file.name);
		if (ext === "docx") {
			this.showNote("Opening…");
			this.$.unpackSvc.call({file: file.path});
		} else if (ext === "doc") {
			this.showNote("Opening…");
			PP.Doc.open(file.path, enyo.bind(this, function(model, message) {
				if (opening === this.opens) {
					this.draw(PP.Doc, model, message);
				}
			}));
		} else if (ext === "txt" || ext === "csv") {
			this.showNote("Opening…");
			PP.readText(file.path, enyo.bind(this, function(text) {
				if (opening === this.opens) {
					this.showText(text);
				}
			}));
		} else {
			this.unsupported();
		}
	},

	// ---- long documents ------------------------------------------------------------
	//
	// The TouchPad's web engine keeps positions in 16 bits: content more than 32,767
	// pixels down the page is not reachable (the scroller will not go there). A long
	// document passes that at about 30 pages. So when a document is that tall, only a
	// run of its pages around the one being read is kept in the page, positions inside
	// the page stay small, and the run is moved along when scrolling comes to rest near
	// one of its ends. "where" below is a distance down the whole document.

	SAFE_HEIGHT: 30000,   // taller than this and pages are kept in a window
	WINDOW_HEIGHT: 16000, // about how much of the document the window holds
	EDGE: 2500,           // coming to rest this close to an end of the window moves it
	PAGE_GAP: 14,         // the space between sheets (see .pp-sheet + .pp-sheet in app.css)

	// Note each page's height, and start windowing if the whole is too tall.
	measurePages: function(node) {
		this.pages = null;
		var pages = [];
		var total = 0;
		for (var c = node.firstChild; c; c = c.nextSibling) {
			if (c.nodeType === 1) {
				var height = c.offsetHeight + this.PAGE_GAP;
				pages.push({el: c, top: total, height: height});
				total += height;
			}
		}
		if (total <= this.SAFE_HEIGHT || pages.length < 3) {
			return;
		}
		this.pages = pages;
		this.totalHeight = total;
		this.windowAround(0);
	},

	// Keep the pages around a place in the document in the page, and scroll to that place.
	windowAround: function(where) {
		var pages = this.pages;
		var node = this.$.page.hasNode();
		if (!pages || !node) {
			return;
		}
		where = Math.max(0, Math.min(where, this.totalHeight));
		// The page that place is on, then pages before and after it up to the window's size.
		var at = 0;
		while (at < pages.length - 1 && pages[at].top + pages[at].height <= where) {
			at++;
		}
		var first = at;
		var last = at;
		var held = pages[at].height;
		while (held < this.WINDOW_HEIGHT && (first > 0 || last < pages.length - 1)) {
			if (first > 0) {
				first--;
				held += pages[first].height;
			}
			if (last < pages.length - 1 && held < this.WINDOW_HEIGHT) {
				last++;
				held += pages[last].height;
			}
		}
		while (node.firstChild) {
			node.removeChild(node.firstChild);
		}
		for (var i = first; i <= last; i++) {
			node.appendChild(pages[i].el);
		}
		this.windowFirst = first;
		this.windowLast = last;
		this.windowTop = pages[first].top;
		this.windowHeight = held;
		this.$.scroller.setScrollTop(Math.max(0, where - this.windowTop));
	},

	// Scroll to a distance down the whole document.
	scrollDocumentTo: function(where) {
		if (this.pages) {
			this.windowAround(where);
		} else {
			this.$.scroller.setScrollTop(where);
		}
	},

	scrollStopped: function() {
		if (!this.pages) {
			return;
		}
		var local = this.$.scroller.getScrollTop();
		var nearStart = local < this.EDGE && this.windowFirst > 0;
		var nearEnd = local > this.windowHeight - this.EDGE - 700 && this.windowLast < this.pages.length - 1;
		if (nearStart || nearEnd) {
			this.windowAround(this.windowTop + local);
		}
	},

	clearPage: function() {
		this.pages = null;
		var node = this.$.page.hasNode();
		if (node) {
			node.innerHTML = "";
		}
	},

	showNote: function(text) {
		this.$.note.setContent(text);
		this.$.note.setShowing(!!text);
	},

	unsupported: function() {
		this.showNote("Papers cannot show this kind of file yet.");
		this.$.other.setShowing(true);
	},

	unpacked: function(inSender, inResponse) {
		var opening = this.opens;
		PP.Docx.open(inResponse.dir, enyo.bind(this, function(model, message) {
			if (opening === this.opens) {
				this.draw(PP.Docx, model, message);
			}
		}));
	},

	unpackFailed: function(inSender, inResponse) {
		PP.log("unpack: " + enyo.json.stringify(inResponse));
		this.showNote((inResponse && inResponse.errorText) || "The file could not be opened.");
		this.$.other.setShowing(true);
	},

	// Have a reader (PP.Docx, PP.Doc) draw what it read, or say why it could not.
	draw: function(reader, model, message) {
		var node = this.$.page.hasNode();
		if (!model || !node) {
			this.showNote(message || "The file could not be opened.");
			this.$.other.setShowing(true);
			return;
		}
		var blocks = 0;
		try {
			blocks = reader.render(model, node);
		} catch (e) {
			PP.log("could not draw " + this.file.name + ": " + e + (e.stack ? " " + e.stack : ""));
			this.clearPage();
			this.showNote("Something in this document could not be drawn.");
			this.$.other.setShowing(true);
			return;
		}
		this.showNote("");
		this.measurePages(node);
		// {scroll: pixels} from a test launch: start that far down the document.
		if (this.file.scroll) {
			// After the view has settled: showing it makes the scroller check its limits again.
			var self = this;
			var where = this.file.scroll;
			var opening = this.opens;
			setTimeout(function() {
				if (opening === self.opens) {
					self.scrollDocumentTo(where);
				}
			}, 1500);
		}
		PP.log("opened " + this.file.name + ": " + blocks + " blocks in " +
			(new Date().getTime() - this.started) + " ms");
	},

	showText: function(text) {
		var node = this.$.page.hasNode();
		if (text === null || !node) {
			this.showNote("The file could not be read.");
			return;
		}
		var sheet = document.createElement("div");
		sheet.className = "pp-sheet pp-plain";
		sheet.appendChild(document.createTextNode(text));
		node.appendChild(sheet);
		this.showNote("");
	},

	openElsewhere: function() {
		this.$.openSvc.call({target: "file://" + this.file.path});
	},

	backClick: function() {
		this.opens++;
		this.clearPage();
		this.doBack();
	}
});
