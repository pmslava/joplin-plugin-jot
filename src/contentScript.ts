/** README ******************************************************************************************************************************************
 * Jot's CodeMirror 6 content script, for desktop and mobile from one file (Harper's shape). PHASE 0 PLACEHOLDER: it builds, loads and registers no  *
 * extension yet. The typed trigger (brief 4.4) lands here in phase 3, with Harper's double-mount guard (joplin#12891).                               *
 *                                                                                                                                                  *
 * Any @codemirror/* import added here stays a require() of Joplin's own copy: webpack.config.js marks those modules external for the extra         *
 * scripts, because a bundled second CodeMirror breaks the editor. test/run.js checks the emitted dist/contentScript.js for it.                    *
 ***************************************************************************************************************************************************/

/** Imports *****************************************************************************************************************************************/
import { ContentScriptContext } from 'api/types'

/** default export **********************************************************************************************************************************
 * The content script's entry, called by Joplin with its context (postMessage to the plugin). plugin() receives the editor control on each mount and *
 * will add the trigger's extension there; for now it adds nothing.                                                                                 *
 ***************************************************************************************************************************************************/
export default (context: ContentScriptContext) => {
    return {
        plugin: (editorControl: any) => [],
    }
}
