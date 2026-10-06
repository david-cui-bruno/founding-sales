import type {SpawnSyncOptions,SpawnSyncReturns} from 'node:child_process';
export type GitRunner=(command:string,args:string[],options:SpawnSyncOptions)=>SpawnSyncReturns<string|Buffer>;
export function historySnapshot(root:string,run?:GitRunner):string;
export function stageSecretHistory(root:string,destination:string,run?:GitRunner):{path:string;versions:number;paths:number;commits:number;snapshot:string};
