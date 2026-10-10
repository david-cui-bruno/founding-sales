import type {PilotWindow} from './realPilot.ts';
import {pilotHash} from './pilotHash.ts';
/** Identical body for reservation and the existing answer transport serialization. */
export function pilotAnswerRequest(question:string,windows:readonly PilotWindow[]) {return {question,windows:windows.map((window,ordinal)=>({...window,ordinal,textHash:pilotHash(window.text)})),groups:windows.map((window,ordinal)=>({id:window.id,windowIds:[window.id],earliestOrdinal:ordinal,score:1}))};}
