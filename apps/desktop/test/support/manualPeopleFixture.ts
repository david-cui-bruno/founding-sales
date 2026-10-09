import type {PeoplePorts} from '../../src/renderer/firms/People.tsx';
export function peoplePortsFixture(personId:string):PeoplePorts{
 const person={personId,fullName:'Alex Example',firm:null,revision:1};
 return {list:async()=>({people:[person],nextAfterId:null}),read:async()=>({person,sources:[],nextAfterSourceId:null}),create:async()=>({personId}),add:async()=>({sourceId:personId}),recapture:async()=>{},remove:async()=>{},restore:async()=>{}};
}
