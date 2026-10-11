/** README ******************************************************************************************************************************************
 * The typed trigger's rule (brief 4.4), in ONE pure module: no CodeMirror, no DOM, no joplin. The content script (src/contentScript.ts) requires it *
 * through webpack and asks it about every typed insertion; the Node harness requires it directly (module.exports) and pins every case. UMD in the  *
 * shape of formModel.js, except that inside a bundle it only fills module.exports: the editor's window is not Jot's to write on.                   *
 *                                                                                                                                                  *
 * THE RULE. A typed insertion fires the trigger when the document text that ENDS where the insertion ends is the trigger string, and the character *
 * before the trigger's first character is a line start or whitespace (the start of the document counts as a line start). So "hello ++" fires on   *
 * its second "+", "C++" and "i++" never do, and neither does a third "+" ("+++": the "++" that ends there follows a "+"). An empty trigger never    *
 * fires, which is how the setting turns the route off. Which insertions are typed (not paste, undo, redo or Jot's own edits) and when composition  *
 * is over are the content script's to decide; this module only sees the text.                                                                     *
 *                                                                                                                                                  *
 * THE CANCELLED OCCURRENCES. When the user cancels the form, the content script remembers the occurrence ({ from, to, text }) and maps it through   *
 * every later change by its END (so text typed after it, or before it, moves it along). It stays remembered while the document still holds that    *
 * same trigger text there, after a line start or whitespace (occurrenceHolds); any change that alters it - a character deleted or retyped inside    *
 * it, a character typed right before it - drops it. A remembered occurrence never fires again: a change that rewrites it with the very same text   *
 * (an input method re-committing what it composed) leaves it remembered and asks nothing. Retyping it after a deletion is a new occurrence.         *
 ***************************************************************************************************************************************************/
;(function(root, factory){
    var api = factory()
    if (typeof module !== 'undefined' && module.exports) module.exports = api        // the content script bundle and the Node harness
    else if (root) root.TriggerRule = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
    'use strict'

    // The setting's default (brief 4.6).
    var DEFAULT_TRIGGER = '++'

    function text(value){ return value == null ? '' : String(value) }

    /** normalizeTrigger ********************************************************************************************************************************
     * The trigger string as the rule uses it: the setting's value with the whitespace around it trimmed, since a trigger that starts or ends with a      *
     * space is a typing slip in the settings field, not a trigger anyone could type on purpose. Anything that is not a string, and a value of spaces   *
     * only, is "" (the route off).                                                                                                                      *
     ***************************************************************************************************************************************************/
    function normalizeTrigger(value){
        return typeof value === 'string' ? value.trim() : ''
    }

    /** contextRange ************************************************************************************************************************************
     * The document range the content script reads for an insertion ending at `end`: the trigger's length back, plus the one character before it that   *
     * the rule looks at. Never before the document's start.                                                                                            *
     ***************************************************************************************************************************************************/
    function contextRange(end, triggerLength){
        var to = Math.max(0, Number(end) || 0)
        return { from: Math.max(0, to - (Number(triggerLength) || 0) - 1), to: to }
    }

    /** occurrenceHolds *********************************************************************************************************************************
     * Whether the document still holds `occurrence.text` at [occurrence.from, occurrence.to) with a line start or whitespace before it. `source` is the *
     * document text from position `offset` on, and must reach from the character before the occurrence (when there is one) to its end; anything that   *
     * does not (an occurrence mapped off the document's start, a slice too short) does not hold.                                                       *
     ***************************************************************************************************************************************************/
    function occurrenceHolds(source, offset, occurrence){
        if (!occurrence) return false
        var wanted = text(occurrence.text)
        var from = Number(occurrence.from), to = Number(occurrence.to)
        if (!wanted || !(from >= 0) || to - from !== wanted.length) return false
        var body = text(source)
        var start = from - Number(offset || 0), end = to - Number(offset || 0)
        if (start < 0 || end > body.length) return false
        if (body.slice(start, end) !== wanted) return false
        if (from === 0) return true
        if (start < 1) return false
        return /\s/.test(body.charAt(start - 1))
    }

    /** triggerAt ***************************************************************************************************************************************
     * The rule for one typed insertion. `source` is the document text from position `offset` on (contextRange's slice: the trigger's length back from   *
     * the insertion's end, and one character more); `insertion` is the inserted range { from, to } in the document after the change; `cancelled` the  *
     * remembered occurrences, in that same document. Answers { fires, from, to, cancelled }: from and to bound the trigger when the text ending at the  *
     * insertion's end is a trigger in a place the rule accepts (null otherwise), fires is whether to open the form, and cancelled says that the        *
     * occurrence is one the user cancelled before (then fires is false).                                                                               *
     ***************************************************************************************************************************************************/
    function triggerAt(source, offset, trigger, insertion, cancelled){
        var none = { fires: false, from: null, to: null, cancelled: false }
        var wanted = text(trigger)
        if (!wanted || !insertion) return none
        var insertFrom = Number(insertion.from), insertTo = Number(insertion.to)
        if (!(insertTo > insertFrom)) return none
        var occurrence = { from: insertTo - wanted.length, to: insertTo, text: wanted }
        if (!occurrenceHolds(source, offset, occurrence)) return none
        var list = Array.isArray(cancelled) ? cancelled : []
        var known = false
        for (var index = 0; index < list.length; index++){
            var item = list[index]
            if (item && item.from === occurrence.from && item.to === occurrence.to && text(item.text) === wanted) known = true
        }
        return { fires: !known, from: occurrence.from, to: occurrence.to, cancelled: known }
    }

    return {
        DEFAULT_TRIGGER: DEFAULT_TRIGGER,
        normalizeTrigger: normalizeTrigger,
        contextRange: contextRange,
        occurrenceHolds: occurrenceHolds,
        triggerAt: triggerAt,
    }
})
