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
		{name: "scroller", kind: "Scroller", flex: 1, className: "pp-desk", accelerated: false, components: [
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

	clearPage: function() {
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
		// {scroll: pixels} from a test launch: start that far down the document.
		if (this.file.scroll) {
			this.$.scroller.setScrollTop(this.file.scroll);
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
