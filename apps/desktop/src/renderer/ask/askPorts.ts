import {manualWorkPorts} from "./manualWorkPorts.ts";
import { operations } from "../app/bridges.ts";
import type { AskPorts } from "./Ask.tsx";
export const askPorts: AskPorts = {
  ...manualWorkPorts,
  sessionCreate:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.sessionCreate',input);},
  sessionTurn:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.sessionTurn',input);},
  sessionChange:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.sessionChange',input);},
  sessionRead:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.read('ask.sessionRead',{...input,includeExactResultCitations:true});},
  sessionList:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.read('ask.sessionList',{...input,includeExactResultCitations:true});},

  actionCreate:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.actionCreate',input);},
  historyChange:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.historyChange',input);},
  historyList: async input => {
    const bridge=operations();
    if(bridge===undefined)throw new Error('unavailable');
    return await bridge.read('ask.historyList',input);
  },
  answerCancel:async input=>{const bridge=operations();if(!bridge)throw new Error('unavailable');return await bridge.command('ask.answerCancel',input);},
  investigationPreview:async input=>{const bridge=operations();if(!bridge)throw new Error('unavailable');return await bridge.read('ask.investigationPreview',input);},
  investigationCommit:async input=>{const bridge=operations();if(!bridge)throw new Error('unavailable');return await bridge.command('ask.investigationCommit',input);},
  answerRequest: async input => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.command('ask.answerRequest',input);
  },
  answerRead: async input => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.read('ask.answerRead',{...input,includeExactResultCitations:true});
  },
  answerSourceRead: async input => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.read('ask.answerSourceRead',input);
  },
  read: async (input) => {
    const bridge = operations();
    if (bridge === undefined) throw new Error("unavailable");
    return await bridge.read("ask.read", input);
  },
};
