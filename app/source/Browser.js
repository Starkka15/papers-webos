/* The file browser: places on the left, the documents found on the right. */
enyo.kind({
	name: "PP.Browser",
	kind: enyo.HFlexBox,
	className: "pp-browser",
	events: {
		// A document was tapped: (file) with {path, name, size, modified}
		onOpen: ""
	},
	components: [
		{kind: "VFlexBox", className: "pp-places", components: [
			{kind: "HFlexBox", align: "center", className: "pp-top", components: [
				{content: "Places", className: "pp-bar-title"}
			]},
			{flex: 1, components: [
				{kind: "HFlexBox", align: "center", className: "pp-place pp-place-selected", components: [
					{className: "pp-place-icon"},
					{content: "My TouchPad", flex: 1}
				]}
			]},
			{className: "pp-bottom"}
		]},
		{kind: "VFlexBox", flex: 1, className: "pp-files", components: [
			{kind: "HFlexBox", align: "center", className: "pp-top", components: [
				{content: "My TouchPad", className: "pp-bar-title", flex: 1},
				{name: "show", kind: "Button", caption: "Show: All", className: "enyo-button-dark", onclick: "showClick"}
			]},
			{name: "search", kind: "SearchInput", hint: "Search My TouchPad", className: "pp-search",
				onchange: "searchChanged", oninput: "searchChanged", onCancel: "searchChanged",
				autoCapitalize: "lowercase", autocorrect: false, spellcheck: false, changeOnInput: true},
			{name: "note", className: "pp-note", showing: false},
			{name: "list", kind: "VirtualList", flex: 1, onSetupRow: "setupRow", components: [
				{name: "row", kind: "Item", layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
					className: "pp-row", onclick: "rowClick", components: [
						{name: "icon", className: "pp-icon"},
						{kind: "VFlexBox", flex: 1, className: "pp-row-text", components: [
							{kind: "HFlexBox", components: [
								{name: "name", className: "pp-name"},
								{name: "ext", className: "pp-ext"}
							]},
							{name: "date", className: "pp-date"}
						]},
						{name: "size", className: "pp-size"}
					]}
			]},
			{kind: "HFlexBox", align: "center", pack: "end", className: "pp-bottom", components: [
				{kind: "Button", caption: "Refresh", className: "enyo-button-dark", onclick: "refresh"}
			]}
		]},
		// lazy: false, so the menu's items exist before it is first opened.
		{name: "showMenu", kind: "Menu", lazy: false, components: [
			{caption: "All", family: "", onclick: "showPicked"},
			{caption: "Documents", family: "text", onclick: "showPicked"},
			{caption: "Spreadsheets", family: "sheet", onclick: "showPicked"},
			{caption: "Presentations", family: "slides", onclick: "showPicked"}
		]},
		{name: "findSvc", kind: "PalmService", service: "palm://com.stark.papers.service/", method: "find",
			onSuccess: "found", onFailure: "findFailed"}
	],

	create: function() {
		this.inherited(arguments);
		this.all = [];       // every document found
		this.shown = [];     // those matching the search and the Show choice
		this.family = "";
	},

	refresh: function() {
		if (!window.PalmSystem) {
			return;
		}
		this.showNote("Looking for documents…");
		this.$.findSvc.call({});
	},

	found: function(inSender, inResponse) {
		var files = (inResponse && inResponse.files) || [];
		for (var i = 0; i < files.length; i++) {
			// Names saved from the web often still carry %20 and the like.
			var name = files[i].name;
			try {
				name = decodeURIComponent(name);
			} catch (e) {}
			var dot = name.lastIndexOf(".");
			files[i].title = dot > 0 ? name.substring(0, dot) : name;
			files[i].ext = dot > 0 ? name.substring(dot) : "";
			files[i].family = PP.family(files[i].name);
			files[i].key = name.toLowerCase();
		}
		files.sort(function(a, b) {
			return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
		});
		this.all = files;
		this.filter();
	},

	findFailed: function(inSender, inResponse) {
		PP.log("find: " + enyo.json.stringify(inResponse));
		this.showNote("The documents on this TouchPad could not be listed.");
	},

	showNote: function(text) {
		this.$.note.setContent(text);
		this.$.note.setShowing(!!text);
	},

	filter: function() {
		var words = String(this.$.search.getValue() || "").toLowerCase();
		var out = [];
		for (var i = 0; i < this.all.length; i++) {
			var f = this.all[i];
			if ((!this.family || f.family === this.family) && (!words || f.key.indexOf(words) >= 0)) {
				out.push(f);
			}
		}
		this.shown = out;
		this.showNote(out.length ? "" : (this.all.length ? "No documents match." : "No documents on this TouchPad yet."));
		this.$.list.punt();
	},

	searchChanged: function() {
		this.filter();
	},

	showClick: function(inSender, inEvent) {
		this.$.showMenu.openAroundControl(this.$.show);
	},

	showPicked: function(inSender) {
		this.family = inSender.family;
		this.$.show.setCaption("Show: " + inSender.caption);
		this.filter();
	},

	setupRow: function(inSender, inIndex) {
		var f = this.shown[inIndex];
		if (!f) {
			return false;
		}
		// The row's controls are reused for every row, so each one sets all of this.
		this.$.icon.setClassName("pp-icon pp-icon-" + f.family);
		this.$.icon.setContent(f.family === "text" ? "W" : (f.family === "sheet" ? "X" : (f.family === "slides" ? "P" : "T")));
		this.$.name.setContent(f.title);
		this.$.ext.setContent(f.ext);
		this.$.date.setContent(PP.when(f.modified));
		this.$.size.setContent(PP.size(f.size));
		return true;
	},

	rowClick: function(inSender, inEvent) {
		var f = this.shown[inEvent.rowIndex];
		if (f) {
			this.doOpen(f);
		}
	}
});
