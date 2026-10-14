/** README ******************************************************************************************************************************************
 * How long the form takes to open, for a test build on a phone (Slava saw 3-4 s from the Jot button on Android, 2026-10-14). With SHOW_OPEN_TIMINGS  *
 * on, the form's heading carries one line - from the tap to the form on screen, and the parts: the selection read, the settings, the notebook and   *
 * tag lists, the dialog's build, and the dialog showing itself (from setHtml to the form's script running). It is OFF in every commit; a test build *
 * flips it, and the flip is never committed (Cockpit's rule for its gesture trace).                                                                *
 ***************************************************************************************************************************************************/
export const SHOW_OPEN_TIMINGS = false

export interface Stopwatch {
    start: number
    parts: [string, number][]
    lap(name: string): void
}

export function stopwatch(start = Date.now()): Stopwatch {
    let last = start
    const parts: [string, number][] = []
    return {
        start,
        parts,
        lap(name: string){
            const now = Date.now()
            parts.push([name, now - last])
            last = now
        },
    }
}
