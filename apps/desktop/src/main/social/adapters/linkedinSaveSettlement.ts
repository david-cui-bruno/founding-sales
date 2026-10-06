/** Read-only save settlement. A surviving composer or any busy surface must not
 * be interrupted by navigation. Disappearance is not a scheduling receipt: the
 * adapter must still independently match the saved post afterwards.
 */
export function linkedInSaveSettlementScript():string{
 return `(()=>{
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const all=s=>Array.from(document.querySelectorAll(s)).filter(visible);
 if(document.readyState==='loading'||all('[role="progressbar"],progress,[aria-busy="true"]').length)return {settled:false};
 const dialogs=all('dialog[open], [role="dialog"]');
 if(dialogs.length){
  if(dialogs.length!==1||dialogs[0].querySelector('[componentkey="ShareBox_textEditor"],[contenteditable="true"]'))return {settled:false};
  return {settled:!!dialogs[0].querySelector('[data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"]')};
 }
 return {settled:all('main,[role="main"]').length===1};
 })()`;
}
