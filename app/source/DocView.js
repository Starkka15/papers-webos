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
		{name: "scroller", kind: "Scroller", flex: 1, className: "pp-desk", components: [
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
		} else if (ext === "txt" || ext === "csv") {
			this.showNote("Opening…");
			var opening = this.opens;
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
			if (opening !== this.opens) {
				return;  // another file has been opened since
			}
			if (!model) {
				this.showNote(message);
				this.$.other.setShowing(true);
				return;
			}
			var node = this.$.page.hasNode();
			if (!node) {
				return;
			}
			var blocks = 0;
			try {
				blocks = PP.Docx.render(model, node);
			} catch (e) {
				PP.log("could not draw " + this.file.name + ": " + e + (e.stack ? " " + e.stack : ""));
				this.clearPage();
				this.showNote("Something in this document could not be drawn.");
				this.$.other.setShowing(true);
				return;
			}
			this.showNote("");
			if (this.file.scroll) {
				this.$.scroller.setScrollTop(this.file.scroll);
			}
			PP.log("opened " + this.file.name + ": " + blocks + " blocks in " +
				(new Date().getTime() - this.started) + " ms");
		}));
	},

	unpackFailed: function(inSender, inResponse) {
		PP.log("unpack: " + enyo.json.stringify(inResponse));
		this.showNote((inResponse && inResponse.errorText) || "The file could not be opened.");
		this.$.other.setShowing(true);
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
