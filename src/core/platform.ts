/** README ******************************************************************************************************************************************
 * This file tells which Joplin app the plugin is running in (copied from Cockpit's src/core/platform.ts, cut down to what Jot needs).              *
 * Parts of the plugin API (menus, the editor's context menu) and all node modules are desktop only, so the plugin has to know where it is running   *
 * before it registers those features.                                                                                                              *
 ***************************************************************************************************************************************************/

/** Imports ****************************************************************************************************************************************/
import joplin from "api"

/** Variable Setup *********************************************************************************************************************************/
var cachedPlatform = null

/** getPlatform *************************************************************************************************************************************
 * Returns the name of the platform the plugin is running on, "desktop" or "mobile". The result is cached, as it cannot change while the plugin is   *
 * loaded.                                                                                                                                          *
 ***************************************************************************************************************************************************/
export async function getPlatform(){
    if (cachedPlatform == null){
        cachedPlatform = await detectPlatform()
    }
    return cachedPlatform
}

/** isMobile ****************************************************************************************************************************************
 * Returns true when the plugin is running in the Joplin mobile app (including its web build).                                                      *
 ***************************************************************************************************************************************************/
export async function isMobile(){
    return (await getPlatform()) == "mobile"
}

/** detectPlatform **********************************************************************************************************************************
 * Works out the current platform. joplin.versionInfo() reports it directly on every app version Jot supports (desktop 3.1, mobile 3.3). The         *
 * presence of a working node module is the fallback, kept from Cockpit for an answer that carries no platform.                                     *
 ***************************************************************************************************************************************************/
async function detectPlatform(){
    try {
        var versionInfo = await joplin.versionInfo() as any
        if (versionInfo && typeof versionInfo.platform == "string"){
            return versionInfo.platform
        }
    } catch (error) {
        console.warn("Jot: could not read the app version info", error)
    }
    return requireNodeModule("fs-extra", "readFile") ? "desktop" : "mobile"
}

/** requireNodeModule *******************************************************************************************************************************
 * Loads one of the node modules that Joplin exposes to plugins, and returns null when it is not usable. joplin.require() is a desktop only API: on  *
 * mobile it resolves to a promise rather than a module, so the returned value is checked for a member that the real module is known to have.        *
 ***************************************************************************************************************************************************/
export function requireNodeModule(moduleName, expectedMember){
    try {
        var module = joplin.require(moduleName)
        if (module && typeof module[expectedMember] == "function"){
            return module
        }
    } catch (error) {
        // joplin.require throws on platforms where the module is unavailable
    }
    return null
}
