/** README ******************************************************************************************************************************************
 * The plugin's side of the typed trigger (brief 4.4): the content script that watches the Markdown editor (src/contentScript.ts, registered here     *
 * with ContentScriptType.CodeMirrorPlugin, as Harper registers its own: one file for desktop and mobile) and the handler of its messages.          *
 *                                                                                                                                                  *
 * THE MESSAGES (context.postMessage in the content script resolves with what handleTriggerMessage returns):                                       *
 *   { type: 'config' }                       -> { trigger }: the setting's value, trimmed ("" turns the route off). Asked when the script loads,  *
 *                                               when the editor gets another note, and after every fire.                                          *
 *   { type: 'trigger', from, to, trigger }   -> the form on the trigger route, and once it closes { action: 'remove' }, { action: 'link', link }  *
 *                                               or { action: 'cancel' }, plus open: id after Create and open. The desktop IPC holds the reply as  *
 *                                               long as the form is up (no timeout on that path).                                                 *
 *   { type: 'open', id }                     -> { opened }: Create and open's open, asked by the content script once its edit is made.            *
 * Anything else answers null. from and to are the content script's business (it maps them through whatever changes while the form is up); the     *
 * plugin never touches the editor on this route.                                                                                                   *
 *                                                                                                                                                  *
 * THE SANDBOX PROXY RULE: every joplin.* member is read and called in one expression.                                                              *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import joplin from "api"
import { ContentScriptType } from "api/types"
import { getTrigger } from "./core/settings"
import { openTriggerForm, openTriggerNote } from "./form/form"
const TriggerRule = require("./form/triggerRule")

/** Constants ***************************************************************************************************************************************/
export const CONTENT_SCRIPT_ID = "jot.trigger"
export const CONTENT_SCRIPT_PATH = "./contentScript.js"

/** setupTrigger ************************************************************************************************************************************
 * Registers the content script and its message handler, in that order (Harper's): the script retries a config question that comes back unanswered, *
 * which is what a script loaded in the moment between the two calls gets. Guarded as the menus are: an app that refuses costs the trigger, not the  *
 * plugin.                                                                                                                                          *
 ***************************************************************************************************************************************************/
export async function setupTrigger(){
    try {
        await joplin.contentScripts.register(ContentScriptType.CodeMirrorPlugin, CONTENT_SCRIPT_ID, CONTENT_SCRIPT_PATH)
        await joplin.contentScripts.onMessage(CONTENT_SCRIPT_ID, handleTriggerMessage)
    } catch (error) {
        console.warn("Jot: could not add the typed trigger to the Markdown editor", error)
    }
}

/** handleTriggerMessage ****************************************************************************************************************************
 * Answers the content script (see the README for the shapes). The trigger printed in the form is the one the script fired with, which is what the  *
 * user typed; a message without one falls back to the setting.                                                                                     *
 ***************************************************************************************************************************************************/
export async function handleTriggerMessage(message: any): Promise<any> {
    const type = message && typeof message === "object" ? message.type : null
    if (type === "config") return { trigger: await getTrigger() }
    if (type === "trigger"){
        const trigger = TriggerRule.normalizeTrigger(message.trigger) || (await getTrigger())
        return openTriggerForm(trigger)
    }
    if (type === "open") return { opened: await openTriggerNote(message.id) }
    return null
}
