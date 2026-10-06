import {BrowserWindow} from 'electron';
import {createSocialRuntime} from './runtime.ts';
/** Remote social pages never receive Callie's preload or authenticated IPC surface. */
export function createElectronSocialRuntime(){
 return createSocialRuntime(options=>new BrowserWindow(options));
}
