/** README ******************************************************************************************************************************************
 * The selection route's dealings with the editor (brief 4.4): reading the highlighted text, telling which editor holds it, and making the edit the  *
 * In this note choice asks for once the new note exists. The rules (the split, the choices, the link, the edit's text) are formModel.js's; this     *
 * file only calls Joplin.                                                                                                                          *
 *                                                                                                                                                  *
 * THE EDITOR COMMANDS (3.6.14 bundle). selectedText: the Markdown editor (CodeMirror 6) answers the main selection's text; the Rich Text editor     *
 * answers the selection converted to plain text. insertText: CodeMirror replaces the selection with the text; the Rich Text editor renders the     *
 * text as Markdown and replaces the selection with that HTML. replaceSelection: CodeMirror the same as insertText; the Rich Text editor sets raw    *
 * HTML, which is why Add a link after it is never offered there. Which editor is up is the global setting editor.codeView (true: Markdown).        *
 *                                                                                                                                                  *
 * EVERY CALL IS GUARDED. A selection that cannot be read is no selection (the plain route); an editor that cannot be told is treated as the Rich    *
 * Text editor (only the choices that are safe in both are offered); an edit that throws is a console warning, and the new note stays created.      *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"

/** Types *******************************************************************************************************************************************/
// formModel.selectionEdit's answer: the command to run and its one argument.
export interface SelectionEdit {
    command: string
    text: string
}

/** readSelectedText ********************************************************************************************************************************
 * The editor's highlighted text, or "" when there is none, when the command throws (no editor, an app without it) or answers anything but a string. *
 ***************************************************************************************************************************************************/
export async function readSelectedText(): Promise<string> {
    try {
        const value = await joplin.commands.execute("selectedText")
        return typeof value === "string" ? value : ""
    } catch (error) {
        console.warn("Jot: could not read the editor's selection, opening the form without it", error)
        return ""
    }
}

/** editorIsMarkdown ********************************************************************************************************************************
 * Whether the Markdown editor is the one up (editor.codeView is true), rather than the Rich Text editor. Anything but a readable true counts as the  *
 * Rich Text editor, the side on which nothing is offered that could damage the note.                                                              *
 ***************************************************************************************************************************************************/
export async function editorIsMarkdown(): Promise<boolean> {
    try {
        return (await joplin.settings.globalValue("editor.codeView")) === true
    } catch (error) {
        console.warn("Jot: could not tell which editor is open, offering only what is safe in both", error)
        return false
    }
}

/** applySelectionEdit ******************************************************************************************************************************
 * Runs the edit (insertText or replaceSelection with its text) in the editor, which still holds the note the selection came from: the host calls     *
 * this before it opens anything. Resolves whether the edit ran; a throw is logged and swallowed, since the new note exists by then.                *
 ***************************************************************************************************************************************************/
export async function applySelectionEdit(edit: SelectionEdit | null): Promise<boolean> {
    if (!edit) return false
    try {
        await joplin.commands.execute(edit.command, edit.text)
        return true
    } catch (error) {
        console.warn(`Jot: could not change the highlighted text (${edit.command}); the new note is created`, error)
        return false
    }
}
