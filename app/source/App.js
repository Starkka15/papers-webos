/* The app: the file browser, or one open document. */
enyo.kind({
	name: "PP.App",
	kind: enyo.VFlexBox,
	className: "pp-app",
	components: [
		{kind: "ApplicationEvents", onBack: "backGesture", onWindowParamsChange: "windowParamsChanged"},
		{name: "pane", kind: "Pane", flex: 1, transitionKind: "enyo.transitions.Simple", components: [
			{name: "browser", kind: "PP.Browser", onOpen: "openFile"},
			{name: "doc", kind: "PP.DocView", onBack: "closeDoc"}
		]}
	],

	rendered: function() {
		this.inherited(arguments);
		if (!this.begun) {
			this.begun = true;
			this.$.browser.refresh();
			this.launched(enyo.windowParams || {});
		}
	},

	windowParamsChanged: function() {
		this.launched(enyo.windowParams || {});
	},

	// Launched with a file to open, as the system does for a tapped attachment or
	// download: {target: "file:///media/internal/report.docx"}. From a PC:
	//   luna-send -n 1 palm://com.palm.applicationManager/launch
	//       '{"id":"com.stark.papers","params":{"target":"file:///media/internal/a.docx"}}'
	launched: function(params) {
		var target = params.target || params.file;
		if (!target) {
			return;
		}
		var path = String(target).replace(/^file:\/\//, "");
		try {
			path = decodeURIComponent(path);
		} catch (e) {}
		// {scroll: pixels} starts that far down the document, to check a later part by screenshot.
		this.openFile(this, {path: path, name: path.substring(path.lastIndexOf("/") + 1), scroll: params.scroll});
	},

	openFile: function(inSender, file) {
		this.$.pane.selectViewByName("doc");
		this.$.doc.openFile(file);
	},

	closeDoc: function() {
		this.$.pane.selectViewByName("browser");
	},

	backGesture: function(inSender, inEvent) {
		if (this.$.pane.getViewName() === "doc") {
			this.$.doc.backClick();
			inEvent.preventDefault();
			return true;
		}
	}
});
