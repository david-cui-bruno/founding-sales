import {useCallback, useEffect,useId,useMemo,useRef,useState,type JSX, type KeyboardEventHandler} from 'react';
import {createPortal} from 'react-dom';
import './workspacePatterns.css';

export interface WorkspaceChoiceOption {value:string;label:string;disabled?:boolean;}
/** Explicit selection, keyboard navigation and current options; never invent a default. */
export function WorkspaceChoice({label,value,options,onChange,disabled=false,placeholder='Choose an option'}:{
 label:string;value:string;options:readonly WorkspaceChoiceOption[];onChange:(value:string)=>void;disabled?:boolean;placeholder?:string;
}):JSX.Element {
 const id=useId(),control=useRef<HTMLElement|null>(null),menu=useRef<HTMLDivElement>(null);
 const bindControl=useCallback((node:HTMLElement|null)=>{control.current=node;},[]);
 const [position,setPosition]=useState<{top:number;left:number;width:number}|null>(null),[active,setActive]=useState(-1),[query,setQuery]=useState('');
 const selected=options.find(option=>option.value===value),searchable=options.length>8;
 const matching=useMemo(()=>{const needle=query.trim().toLocaleLowerCase(),indexes:number[]=[];for(let index=0;index<options.length;index++)if(!needle||options[index]!.label.toLocaleLowerCase().includes(needle))indexes.push(index);return indexes;},[options,query]);
 const open=():void=>{
  if(disabled||!control.current||control.current.matches(':disabled'))return;
  const box=control.current.getBoundingClientRect(),height=Math.min(280,options.length*38+12);
  setPosition({left:Math.max(12,Math.min(box.left,window.innerWidth-Math.max(200,box.width)-12)),top:box.bottom+height+8>window.innerHeight?Math.max(12,box.top-height-4):box.bottom+4,width:Math.min(Math.max(200,box.width),window.innerWidth-24)});
  setQuery('');const current=options.findIndex(option=>option.value===value&&!option.disabled);
  setActive(current>=0?current:options.findIndex(option=>!option.disabled));
 };
 const choose=(index:number):void=>{
  const option=options[index];
  if(!option||option.disabled||disabled||control.current?.matches(':disabled')||!matching.includes(index))return;
  setPosition(null);setQuery('');if(option.value!==value)onChange(option.value);control.current?.focus();
 };
 useEffect(()=>{
  if(!position)return;
  const outside=(event:PointerEvent):void=>{if(event.target instanceof Node&&!control.current?.contains(event.target)&&!menu.current?.contains(event.target))setPosition(null);};
  const close=():void=>setPosition(null);
  const scroll=(event:Event):void=>{if(!(event.target instanceof Node)||!menu.current?.contains(event.target))close();};
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true);};
 },[position]);
 useEffect(()=>{if(disabled)setPosition(null);},[disabled]);
 useEffect(()=>{
  if(!position||active<0||!menu.current)return;
  const option=document.getElementById(`${id}-${active}`);
  if(!option)return;
  if(option.offsetTop<menu.current.scrollTop)menu.current.scrollTop=option.offsetTop;
  else if(option.offsetTop+option.offsetHeight>menu.current.scrollTop+menu.current.clientHeight)menu.current.scrollTop=option.offsetTop+option.offsetHeight-menu.current.clientHeight;
 },[active,id,position,matching]);
 const visible=position!==null&&!disabled;
 const host=control.current?.closest('[data-theme]')??document.body;
 const keyDown: KeyboardEventHandler<HTMLElement> = event=>{
  if(event.key==='Escape'&&visible){event.preventDefault();event.stopPropagation();setPosition(null);setQuery('');return;}
  if(event.key==='Tab'){setPosition(null);setQuery('');return;}
  if(event.key==='Enter'||event.key===' '&&!searchable){event.preventDefault();if(visible)choose(active);else open();return;}
  if(searchable&&!visible&&event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){open();setQuery(event.key);setActive(options.findIndex(option=>!option.disabled&&option.label.toLocaleLowerCase().includes(event.key.toLocaleLowerCase())));event.preventDefault();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();if(!visible){open();return;}
  const direction=event.key==='ArrowUp'||event.key==='End'?-1:1;
  let next=event.key==='Home'?-1:event.key==='End'?matching.length:matching.indexOf(active);
  for(let attempts=0;attempts<matching.length;attempts++){
   next=(next+direction+matching.length)%matching.length;
   const index=matching[next]!;
   if(!options[index]?.disabled){setActive(index);return;}
  }
 }
 const attributes={role:'combobox','aria-label':label,'aria-haspopup':'listbox' as const,'aria-expanded':visible,'aria-controls':visible?id:undefined,'aria-activedescendant':visible&&matching.includes(active)&&active>=0?`${id}-${active}`:undefined,disabled,onKeyDown:keyDown};
 return <div className="workspace-choice">
  {searchable?<><input ref={bindControl} {...attributes} type="text" autoComplete="off" aria-autocomplete="list" readOnly={!visible} placeholder={visible?'Search current options':placeholder} value={visible?query:selected?.label??''} onClick={()=>{if(!visible)open();}} onChange={event=>{
   if(disabled||control.current?.matches(':disabled'))return;
   const text=event.target.value;setQuery(text);setActive(options.findIndex(option=>!option.disabled&&option.label.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase())));
  }}/><small className="workspace-choice-hint" aria-hidden="true">{visible?'Search':'Change'}</small></>:<button ref={bindControl} {...attributes} type="button" onClick={()=>visible?setPosition(null):open()}><span>{selected?.label??placeholder}</span><small>Change</small></button>}
  {visible?createPortal(<div ref={menu} className="workspace-choice-menu" style={{position:'fixed',...position}}><div id={id} role="listbox" aria-label={label}>
   {matching.map(index=>{const option=options[index]!;return <div id={`${id}-${index}`} key={option.value} data-value={option.value} role="option" aria-selected={value===option.value} aria-disabled={option.disabled||undefined} data-active={index===active} onMouseDown={event=>event.preventDefault()} onPointerMove={()=>{if(!option.disabled)setActive(index);}} onClick={()=>choose(index)}><span className="workspace-choice-mark" aria-hidden="true">{value===option.value?'✓':''}</span>{option.label}</div>;})}</div>
   {!matching.length?<p role="status">{options.length?'No matching current options':'No current options'}</p>:null}
  </div>,host):null}
 </div>;
}

/** Native radio semantics, presented as outcome/action chips rather than a dropdown. */
export function WorkspaceChoiceGroup({label,value,options,onChange,disabled=false}:{label:string;value:string;options:readonly WorkspaceChoiceOption[];onChange:(value:string)=>void;disabled?:boolean}):JSX.Element {
 const name=useId();
 return <fieldset className="workspace-choice-group" role="radiogroup" aria-label={label} disabled={disabled}>
  <legend>{label}</legend><div>{options.map(option=><label key={option.value} data-selected={value===option.value}>
   <input type="radio" name={name} value={option.value} checked={value===option.value} disabled={option.disabled} onChange={event=>{if(!disabled&&!option.disabled&&!event.currentTarget.matches(':disabled')&&value!==option.value)onChange(option.value);}}/><span><span className="workspace-choice-mark" aria-hidden="true">{value===option.value?'✓':''}</span>{option.label}</span>
  </label>)}</div>
 </fieldset>;
}
