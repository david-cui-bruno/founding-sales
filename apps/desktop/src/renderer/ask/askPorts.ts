import {manualWorkPorts} from "./manualWorkPorts.ts";
import { operations } from "../app/bridges.ts";
import type { AskPorts } from "./Ask.tsx";
export const askPorts: AskPorts = {
  ...manualWorkPorts,
  actionCreate:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.actionCreate',input);},
  historyChange:async input=>{const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return await bridge.command('ask.historyChange',input);},
  historyList: async input => {
    const bridge=operations();
    if(bridge===undefined)throw new Error('unavailable');
    return await bridge.read('ask.historyList',input);
  },
  answerRequest: async input => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.command('ask.answerRequest',input);
  },
  answerRead: async input => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.read('ask.answerRead',input);
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
