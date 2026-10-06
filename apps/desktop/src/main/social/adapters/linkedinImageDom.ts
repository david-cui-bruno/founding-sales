/** Closed action; binary contents are literal data, never script or selectors. */
export function linkedInImageInputScript(files:readonly {name:string;mime:string;base64:string}[]):string {
 return `(()=>{const files=${JSON.stringify(files)};
 const dialogs=Array.from(document.querySelectorAll('dialog[open][data-testid="dialog"]')).filter(e=>!e.hidden&&window.getComputedStyle(e).display!=='none');
 if(dialogs.length!==1||!Array.from(dialogs[0].querySelectorAll('h2')).some(e=>e.textContent.trim()==='Editor'))return {ok:false};
 const inputs=Array.from(document.querySelectorAll('input[type="file"]')).filter(e=>e.accept.includes('image/png')&&e.accept.includes('image/jpeg'));
 if(inputs.length!==1||inputs[0].disabled||inputs[0].files.length||(!inputs[0].multiple&&files.length>1))return {ok:false};
 const data=new DataTransfer();for(const f of files){const raw=atob(f.base64);const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));data.items.add(new File([bytes],f.name,{type:f.mime}));}
 inputs[0].files=data.files;inputs[0].dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,count:data.files.length};})()`;
}
