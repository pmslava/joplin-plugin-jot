// Copied from Cockpit (joplin-plugin-cockpit, src/ui/panel/searchTokens.js, same author, MIT), cut down to the one rule Jot uses: matchesFilter.
/** README ******************************************************************************************************************************************
 * The filter rule of the form's suggestion lists (the Notebook field and the token being typed in the Tags field), kept byte-identical to Cockpit's *
 * so a list narrows the same way in both plugins. ONE pure module - no DOM, no webviewApi - so the dialog (formWebview.js, through formModel.js, via   *
 * window.SearchTokens) and the Node test harness (require, module.exports below) run the same decision.                                              *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // Node test harness (require)
    if (typeof window !== 'undefined') window.SearchTokens = api                      // the form dialog's iframe
    else if (root) root.SearchTokens = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    /** matchesFilter *******************************************************************************************************************************
     * Whether a suggestion row survives the dropdown's embedded filter box: a case-insensitive substring of its visible label ("fam" matches         *
     * "Family / Payments"). An empty or blank filter matches everything. The same rule the notebook menu's filter has always used.                    *
     ***********************************************************************************************************************************************/
    function matchesFilter(label, filter){
        var needle = String(filter == null ? '' : filter).trim().toLowerCase()
        if (!needle) return true
        return String(label == null ? '' : label).toLowerCase().indexOf(needle) !== -1
    }

    return {
        matchesFilter: matchesFilter,
    }
})
