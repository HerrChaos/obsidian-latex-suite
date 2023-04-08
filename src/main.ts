import { Plugin, Notice } from "obsidian";
import { LatexSuiteSettings, LatexSuiteSettingTab, DEFAULT_SETTINGS } from "./settings";

import { EditorView, ViewUpdate, keymap, tooltips } from "@codemirror/view";
import { SelectionRange, Prec, Extension } from "@codemirror/state";
import { isWithinEquation, isWithinInlineEquation, replaceRange, setCursor, isInsideEnvironment, getOpenBracket, findMatchingBracket, getEquationBounds, getCharacterAtPos } from "./editor_helpers";

import { Environment, Snippet, SNIPPET_VARIABLES, EXCLUSIONS } from "./snippets/snippets";
import { onFileCreate, onFileChange, onFileDelete, debouncedSetSnippetsFromFileOrFolder } from "./snippets/file_watch";
import { sortSnippets, getSnippetsFromString, snippetInvertedEffects, handleUndoRedo } from "./snippets/snippet_helper_functions";
import { expandSnippets, isInsideATabstop, isInsideLastTabstop, removeAllTabstops, consumeAndGotoNextTabstop } from "./snippets/snippet_management";
import { markerStateField } from "./snippets/marker_state_field";
import { tabstopsStateField } from "./snippets/tabstops_state_field";
import { clearSnippetQueue, queueSnippet, snippetQueueStateField } from "./snippets/snippet_queue_state_field";

import { concealPlugin } from "./editor_extensions/conceal";
import { colorPairedBracketsPluginLowestPrec, highlightCursorBracketsPlugin } from "./editor_extensions/highlight_brackets";
import { cursorTooltipBaseTheme, cursorTooltipField } from "./editor_extensions/inline_math_tooltip";

import { editorCommands } from "./editor_commands";


export default class LatexSuitePlugin extends Plugin {
	settings: LatexSuiteSettings;
	snippets: Snippet[];
	autofractionExcludedEnvs: Environment[];
	matrixShortcutsEnvNames: string[];
	autoEnlargeBracketsTriggers: string[];

	private cursorTriggeredByChange = false;


	// When expanding snippets
	private shouldAutoEnlargeBrackets = false;


	private editorExtensions:Extension[] = [];


	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LatexSuiteSettingTab(this.app, this));

		this.legacyEditorWarning();

		// Register keymaps
		this.registerEditorExtension(Prec.highest(keymap.of([
		{
			key: "Tab",
			run: (view: EditorView):boolean => {
				const success = this.handleKeydown("Tab", false, false, view);

				return success;
			}
		},
		{
			key: "Enter",
			run: (view: EditorView):boolean => {
				const success = this.handleKeydown("Enter", false, false, view);

				return success;
			},
			shift: (view: EditorView):boolean => {
				const success = this.handleKeydown("Enter", true, false, view);

				return success;
			}
		}])));

		this.registerEditorExtension(Prec.highest(EditorView.domEventHandlers({
            "keydown": this.onKeydown
        })));


		// Register editor extensions required for snippets
		this.registerEditorExtension([markerStateField, tabstopsStateField, snippetQueueStateField, snippetInvertedEffects]);
		this.registerEditorExtension(EditorView.updateListener.of(this.handleUpdate));


		// Register editor extensions for editor enhancements
		this.registerEditorExtension(tooltips({position: "absolute"}));
		this.registerEditorExtension(this.editorExtensions);
		

		// Watch for changes to the snippets file
		this.registerEvent(this.app.vault.on("modify", (file) => onFileChange(this, file)));
		this.registerEvent(this.app.vault.on("delete", (file) => onFileDelete(this, file)));
		this.registerEvent(this.app.vault.on("create", (file) => onFileCreate(this, file)));


		this.addEditorCommands();
	}


	onunload() {

	}


	legacyEditorWarning() {
		if ((this.app.vault as any).config?.legacyEditor) {
			const message = "Obsidian Latex Suite: This plugin does not support the legacy editor. Switch to Live Preview mode to use this plugin.";

			new Notice(message, 100000);
			console.log(message);

			return;
		}
	}


	private readonly handleUpdate = (update: ViewUpdate) => {
		if (update.docChanged) {
			this.handleDocChange();
		}

		if (update.selectionSet) {
			const pos = update.state.selection.main.head;
			this.handleCursorActivity(update.view, pos);
		}

		handleUndoRedo(update);
	}


	private readonly handleDocChange = () => {
        this.cursorTriggeredByChange = true;
    }


    private readonly handleCursorActivity = (view: EditorView, pos: number) => {
        if (this.cursorTriggeredByChange) {
            this.cursorTriggeredByChange = false;
            return;
        }

        if (!isInsideATabstop(pos, view) || isInsideLastTabstop(view)) {
            removeAllTabstops(view);
        }
    }


	enableExtension(extension: Extension) {
		this.editorExtensions.push(extension);
		this.app.workspace.updateOptions();

	}


	disableExtension(extension: Extension) {
		this.editorExtensions.remove(extension);
		this.app.workspace.updateOptions();
	}



	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if (this.settings.loadSnippetsFromFile) {
			// Use onLayoutReady so that we don't try to read the snippets file too early
			this.app.workspace.onLayoutReady(() => {
				debouncedSetSnippetsFromFileOrFolder(this);
			});
		}
		else {
			this.setSnippets(this.settings.snippets);
		}

		this.setAutofractionExcludedEnvs(this.settings.autofractionExcludedEnvs);
		this.matrixShortcutsEnvNames = this.settings.matrixShortcutsEnvNames.replace(/\s/g,"").split(",");
		this.autoEnlargeBracketsTriggers = this.settings.autoEnlargeBracketsTriggers.replace(/\s/g,"").split(",");


		if (this.settings.concealEnabled) this.enableExtension(concealPlugin.extension);
		if (this.settings.colorPairedBracketsEnabled) this.enableExtension(colorPairedBracketsPluginLowestPrec);
		if (this.settings.highlightCursorBracketsEnabled) this.enableExtension(highlightCursorBracketsPlugin.extension);
		if (this.settings.inlineMathPreviewEnabled) {
			this.enableExtension(cursorTooltipField);
			this.enableExtension(cursorTooltipBaseTheme);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setSnippets(snippetsStr: string) {
		const snippets = getSnippetsFromString(snippetsStr);

		sortSnippets(snippets);
		this.snippets = snippets;
	}


	setAutofractionExcludedEnvs(envsStr: string) {
		const envsJSON = JSON.parse(envsStr);
		const envs = envsJSON.map(function(env: string[]) {
			return {openSymbol: env[0], closeSymbol: env[1]};
		});

		this.autofractionExcludedEnvs = envs;
	}



	private readonly addEditorCommands = () => {
		for (const command of editorCommands) {
			this.addCommand(command);
		}

		this.addCommand({
			id: "latex-suite-enable-all-features",
			name: "Enable all features",
			callback: async () => {
				this.settings.snippetsEnabled = true;
				this.settings.autofractionEnabled = true;
				this.settings.matrixShortcutsEnabled = true;
				this.settings.taboutEnabled = true;
				this.settings.autoEnlargeBrackets = true;

				await this.saveSettings();
			},
		});

		this.addCommand({
			id: "latex-suite-disable-all-features",
			name: "Disable all features",
			callback: async () => {
				this.settings.snippetsEnabled = false;
				this.settings.autofractionEnabled = false;
				this.settings.matrixShortcutsEnabled = false;
				this.settings.taboutEnabled = false;
				this.settings.autoEnlargeBrackets = false;

				await this.saveSettings();
			},
		});

	}


	private readonly onKeydown = (event: KeyboardEvent, view: EditorView) => {
		const success = this.handleKeydown(event.key, event.shiftKey, event.ctrlKey||event.metaKey, view);

		if (success) event.preventDefault();
	}


	private readonly handleKeydown = (key: string, shiftKey: boolean, ctrlKey: boolean, view: EditorView) => {

		const s = view.state.selection;
		const pos = s.main.to;
		const ranges = Array.from(s.ranges).reverse(); // Last to first

		const withinEquation = isWithinEquation(view);

		// Check whether within "\text{}" or "\tag{}"
		let withinMath = false;
		if (withinEquation) withinMath = !(isInsideEnvironment(view, pos, {openSymbol: "\\text{", closeSymbol: "}"}) || isInsideEnvironment(view, pos, {openSymbol: "\\tag{", closeSymbol: "}"}));

		
		let success = false;


		if (this.settings.snippetsEnabled) {

			// Allows Ctrl + z for undo, instead of triggering a snippet ending with z
			if (!ctrlKey) {
				try {
					success = this.runSnippets(view, key, withinMath, ranges);
					if (success) return true;
				}
				catch (e) {
					clearSnippetQueue(view);
					console.error(e);
				}

			}

		}


		const shouldTaboutByCloseBracket = this.shouldTaboutByCloseBracket(view, key);

		if (key === "Tab" || shouldTaboutByCloseBracket) {
			success = this.handleTabstops(view);

			if (success) return true;
		}


		if (this.settings.autofractionEnabled && withinMath) {
			if (key === "/") {
				success = this.runAutoFraction(view, ranges);

				if (success) return true;
			}
		}


		if (this.settings.matrixShortcutsEnabled && withinMath) {
			if (["Tab", "Enter"].contains(key)) {
				success = this.runMatrixShortcuts(view, key, shiftKey, pos);

				if (success) return true;
			}
		}


		if (this.settings.taboutEnabled) {
			if (key === "Tab") {
				success = this.tabout(view, withinEquation);

				if (success) return true;
			}
		}

		return false;
	}



	private readonly checkSnippet = (snippet: Snippet, effectiveLine: string, range:  SelectionRange, sel: string):{triggerPos: number; replacement: string} => {
		let triggerPos;
		let trigger = snippet.trigger;
		trigger = this.insertSnippetVariables(trigger);

		let replacement = snippet.replacement;


		if (snippet.replacement.contains("${VISUAL}")) {
			// "Visual" snippets
			if (!sel) return null;

			// Check whether the trigger text was typed
			if (!(effectiveLine.slice(-trigger.length) === trigger)) return null;


			triggerPos = range.from;
			replacement = snippet.replacement.replace("${VISUAL}", sel);

		}
		else if (sel) {
			// Don't run non-visual snippets when there is a selection
			return null;
		}
		else if (!(snippet.options.contains("r"))) {

			// Check whether the trigger text was typed
			if (!(effectiveLine.slice(-trigger.length) === trigger)) return null;

			triggerPos = effectiveLine.length - trigger.length;

		}
		else {
			// Regex snippet

			// Add $ to match the end of the string
			// i.e. look for a match at the cursor's current position
			const regex = new RegExp(trigger + "$");
			const result = regex.exec(effectiveLine);

			if (!(result)) {
				return null;
			}

			// Compute the replacement string
			// result.length - 1 = the number of capturing groups

			for (let i = 1; i < result.length; i++) {
				// i-1 to start from 0
				replacement = replacement.replaceAll("[[" + (i-1) + "]]", result[i]);
			}

			triggerPos = result.index;
		}

		return {triggerPos: triggerPos, replacement: replacement};
	}



	private readonly insertSnippetVariables = (trigger: string) => {

		for (const [variable, replacement] of Object.entries(SNIPPET_VARIABLES)) {
			trigger = trigger.replace(variable, replacement);
		}

		return trigger;
	}



	private readonly runSnippets = (view: EditorView, key: string, withinMath: boolean, ranges: SelectionRange[]):boolean => {

		this.shouldAutoEnlargeBrackets = false;

		for (const range of ranges) {
			this.runSnippetCursor(view, key, withinMath, range);
		}

		const success = expandSnippets(view);


		if (this.shouldAutoEnlargeBrackets) {
			this.autoEnlargeBrackets(view);
		}

		return success;
	}


	private readonly runSnippetCursor = (view: EditorView, key: string, withinMath: boolean, range: SelectionRange):boolean => {

		const {from, to} = range;
		const sel = view.state.sliceDoc(from, to);


		for (const snippet of this.snippets) {

			let effectiveLine = view.state.sliceDoc(0, to);

			if (snippet.options.contains("m") && (!withinMath)) {
                continue;
            }
            else if (snippet.options.contains("t") && (withinMath)) {
                continue;
            }

            if (snippet.options.contains("A") || snippet.replacement.contains("${VISUAL}")) {
                // If the key pressed wasn't a text character, continue
                if (!(key.length === 1)) continue;

                effectiveLine += key;
            }
            else if (!(key === "Tab")) {
                // The snippet must be triggered by the Tab key
                continue;
            }

			// Check that this snippet is not excluded in a certain environment
			if (snippet.trigger in EXCLUSIONS) {
				const environment = EXCLUSIONS[snippet.trigger];

				if (isInsideEnvironment(view, to, environment)) continue;
			}


			const result = this.checkSnippet(snippet, effectiveLine, range, sel);
			if (result === null) continue;
			const triggerPos = result.triggerPos;


			if (snippet.options.contains("w")) {
				// Check that the trigger is preceded and followed by a word delimiter

				const prevChar = view.state.sliceDoc(triggerPos-1, triggerPos);
				const nextChar = view.state.sliceDoc(to, to+1);

				const wordDelimiters = this.settings.wordDelimiters.replace("\\n", "\n");


				const prevCharIsWordDelimiter = wordDelimiters.contains(prevChar);
				const nextCharIsWordDelimiter = wordDelimiters.contains(nextChar);

				if (!(prevCharIsWordDelimiter && nextCharIsWordDelimiter)) {
					continue;
				}
			}

			let replacement = result.replacement;


			// When in inline math, remove any spaces at the end of the replacement
			if (withinMath && this.settings.removeSnippetWhitespace) {
				let spaceIndex = 0;
				if (replacement.endsWith(" ")) {
					spaceIndex = -1;
				}
				else {
					const lastThreeChars = replacement.slice(-3);
					const lastChar = lastThreeChars.slice(-1);

					if (lastThreeChars.slice(0, 2) === " $" && !isNaN(parseInt(lastChar))) {
						spaceIndex = -3;
					}
				}

				if (spaceIndex != 0) {

					const inlineMath = isWithinInlineEquation(view);

					if (inlineMath) {
						if (spaceIndex === -1) {
							replacement = replacement.trimEnd();
						}
						else if (spaceIndex === -3){
							replacement = replacement.slice(0, -3) + replacement.slice(-2)
						}
					}
				}

			}

			// Expand the snippet
            const start = triggerPos;
			queueSnippet(view, {from: start, to: to, insert: replacement, keyPressed: key});


			const containsTrigger = this.autoEnlargeBracketsTriggers.some(word => replacement.contains("\\" + word));
			if (containsTrigger) this.shouldAutoEnlargeBrackets = true;


			return true;
		}


		return false;
	}


	private readonly handleTabstops = (view: EditorView):boolean => {
        const success = consumeAndGotoNextTabstop(view);

		return success;
    }


	private readonly runAutoFraction = (view: EditorView, ranges: SelectionRange[]):boolean => {

		for (const range of ranges) {
			this.runAutoFractionCursor(view, range);
		}

		const success = expandSnippets(view);

		if (success) {
			this.autoEnlargeBrackets(view);
		}

		return success;
	}


	private readonly runAutoFractionCursor = (view: EditorView, range: SelectionRange):boolean => {

			const {from, to} = range;


			// Don't run autofraction in excluded environments
			for (const env of this.autofractionExcludedEnvs) {
				if (isInsideEnvironment(view, to, env)) {
					return false;
				}
			}

			// Get the bounds of the equation
			const result = getEquationBounds(view);
			if (!result) return false;
			const eqnStart = result.start;


			let curLine = view.state.sliceDoc(0, to);
			let start = eqnStart;

			if (from != to) {
				// We have a selection
				// Set start to the beginning of the selection

				start = from;
			}
			else {
				// Find the contents of the fraction
                // Match everything except spaces and +-, but allow these characters in brackets

				// Also, allow spaces after greek letters
				// By replacing spaces after greek letters with a dummy character (#)

				const regex = new RegExp("(" + SNIPPET_VARIABLES["${GREEK}"] + ") ([^ ])", "g");
				curLine = curLine.replace(regex, "$1#$2");



				for (let i = curLine.length - 1; i >= eqnStart; i--) {
					const curChar = curLine.charAt(i)

					if ([")", "]", "}"].contains(curChar)) {
                        const closeBracket = curChar;
						const openBracket = getOpenBracket(closeBracket);

						const j = findMatchingBracket(curLine, i, openBracket, closeBracket, true);

						if (j === -1) return false;

						// Skip to the beginnning of the bracket
						i = j;

						if (i < eqnStart) {
							start = eqnStart;
							break;
						}

                    }


					if (" $([{\n".concat(this.settings.autofractionBreakingChars).contains(curChar)) {
						start = i+1;
						break;
					}
				}
			}

			// Run autofraction
			let numerator = view.state.sliceDoc(start, to);

			// Don't run on an empty line
            if (numerator === "") return false;


			// Remove brackets
			if (curLine.charAt(start) === "(" && curLine.charAt(to - 1) === ")") {
				numerator = numerator.slice(1, -1);
			}


			const replacement = "\\frac{" + numerator + "}{$0}$1";

			queueSnippet(view, {from: start, to: to, insert: replacement, keyPressed: "/"});

			return true;
	}


	private readonly autoEnlargeBrackets = (view: EditorView) => {
		if (!this.settings.autoEnlargeBrackets) return;

		const result = getEquationBounds(view);
		if (!result) return false;
		const {start, end} = result;

		const text = view.state.doc.toString();
		const left = "\\left";
		const right = "\\right";


		for (let i = start; i < end; i++) {

			const brackets:{[open: string]: string} = {"(": ")", "[": "]", "\\{": "\\}", "\\langle": "\\rangle", "\\lvert": "\\rvert"};
			const openBrackets = Object.keys(brackets);
			let found = false;
			let open = "";

			for (const openBracket of openBrackets) {
				if (text.slice(i, i + openBracket.length) === openBracket) {
					found = true;
					open = openBracket;
					break;
				}
			}

			if (!found) continue;
			const bracketSize = open.length;
			const close = brackets[open];


			const j = findMatchingBracket(text, i, open, close, false, end);
			if (j === -1) continue;


			// If \left and \right already inserted, ignore
			if ((text.slice(i-left.length, i) === left) && (text.slice(j-right.length, j) === right)) continue;


			// Check whether the brackets contain sum, int or frac
			const bracketContents = text.slice(i+1, j);
			const containsTrigger = this.autoEnlargeBracketsTriggers.some(word => bracketContents.contains("\\" + word));

			if (!containsTrigger) {
				i = j;
				continue;
			}

			// Enlarge the brackets
			queueSnippet(view, {from: i, to: i+bracketSize, insert: left + open + " "});
			queueSnippet(view, {from: j, to: j+bracketSize, insert: " " + right + close});
		}

		expandSnippets(view);
	}


	private readonly tabout = (view: EditorView, withinEquation: boolean):boolean => {
		if (!withinEquation) return false;

		const pos = view.state.selection.main.to;
		const result = getEquationBounds(view);
		if (!result) return false;
		const end = result.end;

		const d = view.state.doc;
		const text = d.toString();



        // Move to the next closing bracket: }, ), ], >, |, or \\rangle
		const rangle = "\\rangle";

        for (let i = pos; i < end; i++) {
            if (["}", ")", "]", ">", "|"].contains(text.charAt(i))) {
                setCursor(view, i+1);

                return true;
            }
			else if (text.slice(i, i + rangle.length) === rangle) {
				setCursor(view, i + rangle.length);

				return true;
			}
        }


		// If cursor at end of line/equation, move to next line/outside $$ symbols

		// Check whether we're at end of equation
		// Accounting for whitespace, using trim
		const textBtwnCursorAndEnd = d.sliceString(pos, end);
		const atEnd = textBtwnCursorAndEnd.trim().length === 0;

		if (!atEnd) return false;


		// Check whether we're in inline math or a block eqn
		const inlineMath = d.sliceString(end, end+2) != "$$";

		if (inlineMath) {
			setCursor(view, end + 1);
		}
		else {
			// First, locate the $$ symbol
			const dollarLine = d.lineAt(end+2);

			// If there's no line after the equation, create one

			if (dollarLine.number === d.lines) {
				replaceRange(view, dollarLine.to, dollarLine.to, "\n");
			}

			// Finally, move outside the $$ symbol
			setCursor(view, dollarLine.to + 1);


			// Trim whitespace at beginning / end of equation
			const line = d.lineAt(pos);
			replaceRange(view, line.from, line.to, line.text.trim());

		}

		return true;
	}


	private readonly runMatrixShortcuts = (view: EditorView, key: string, shiftKey: boolean, pos: number):boolean => {
		// Check whether we are inside a matrix / align / case environment
		let isInsideAnEnv = false;

		for (const envName of this.matrixShortcutsEnvNames) {
			const env = {openSymbol: "\\begin{" + envName + "}", closeSymbol: "\\end{" + envName + "}"};

			isInsideAnEnv = isInsideEnvironment(view, pos, env);
			if (isInsideAnEnv) break;
		}

		if (!isInsideAnEnv) return false;


		if (key === "Tab") {
			view.dispatch(view.state.replaceSelection(" & "));

			return true;
		}
		else if (key === "Enter") {
			if (shiftKey) {
				// Move cursor to end of next line
				const d = view.state.doc;

				const nextLineNo = d.lineAt(pos).number + 1;
				const nextLine = d.line(nextLineNo);

				setCursor(view, nextLine.to);
			}
			else {
				view.dispatch(view.state.replaceSelection(" \\\\\n"));
			}

			return true;
		}
		else {
			return false;
		}

	}


	private readonly shouldTaboutByCloseBracket = (view: EditorView, keyPressed: string) => {
		const sel = view.state.selection.main;
		if (!sel.empty) return;
		const pos = sel.from;

		const c = getCharacterAtPos(view, pos);
		const brackets = [")", "]", "}"];

		if ((c === keyPressed) && brackets.contains(c)) {
			return true;
		}
		else {
			return false;
		}
	}
}
