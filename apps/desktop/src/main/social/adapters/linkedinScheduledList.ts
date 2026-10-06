/** Read-only native receipt discovery. A thumbnail/list excerpt is NOT an approval match.
 * Full text, media, alt text, account and time still require independent detail verification.
 */
export function linkedInScheduledListScript():string{
 return `(()=>{
 const visible=e=>{for(let p=e;p;p=p.parentElement){const s=window.getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden')return false;}return true;};
 const lists=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"] [data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareSchedulePostList"]')).filter(visible);
 if(lists.length!==1)return {ok:false};const root=lists[0];
 const counts=Array.from(root.querySelectorAll('a')).filter(visible).map(e=>e.textContent.trim()).filter(t=>/^Scheduled \\(\\d+\\)$/.test(t));if(counts.length!==1)return {ok:false};
 const total=Number(counts[0].match(/\\d+/)[0]);if(!Number.isSafeInteger(total)||total>10000)return {ok:false};
 const nodes=Array.from(root.querySelectorAll('[id^="ScheduledPostRowSlot_"]')).filter(visible);if(nodes.length>100)return {ok:false};const rows=[];const ids=new Set();
 for(const node of nodes){
  const match=node.id.match(/^ScheduledPostRowSlot_(urn:li:share:\\d+)_gen\\d+$/);if(!match||ids.has(match[1]))return {ok:false};ids.add(match[1]);
  const cards=Array.from(node.querySelectorAll('[role="listitem"]')).filter(visible);if(cards.length!==1)return {ok:false};const card=cards[0];
  const labels=Array.from(node.querySelectorAll('p')).filter(visible).map(e=>e.textContent.trim()).filter(t=>/^Posting .+ at .+$/.test(t));if(labels.length!==1)return {ok:false};
  const paragraphs=Array.from(card.querySelectorAll('p')).filter(visible);if(paragraphs.length!==1)return {ok:false};const text=paragraphs[0].textContent.trim();if(text.length>10000)return {ok:false};
  const images=Array.from(card.querySelectorAll('img')).map(e=>({src:e.getAttribute('src')??'',alt:e.getAttribute('alt')??''}));if(images.length>20||images.some(i=>i.src.length>4096||i.alt.length>1000))return {ok:false};
  rows.push({receiptId:match[1],text,scheduleLabel:labels[0],images});
 }
 if(rows.length>total)return {ok:false};
 const loading=Array.from(root.querySelectorAll('[role="progressbar"],progress')).some(visible);
 const empty=Array.from(root.querySelectorAll('p,span,div')).some(e=>visible(e)&&e.textContent.trim()==='When you schedule a post, it automatically posts at the date and time you chose');
 return {ok:true,total,complete:!loading&&rows.length===total&&(total>0||empty),rows};
 })()`;
}
