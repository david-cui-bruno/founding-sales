import {fireEvent,screen,within} from '@testing-library/react';

/** Real WorkspaceChoice (combobox + listbox) and WorkspaceChoiceGroup (radiogroup) interactions. */
const radios=(label:string):HTMLInputElement[]=>within(screen.getByRole('radiogroup',{name:label})).getAllByRole('radio') as HTMLInputElement[];
const optionsOf=(label:string):HTMLElement[]=>within(screen.getByRole('listbox',{name:label})).queryAllByRole('option');
const openMenu=(label:string):HTMLElement=>{const trigger=screen.getByRole('combobox',{name:label});if(trigger.getAttribute('aria-expanded')!=='true')fireEvent.click(trigger);return trigger;};
const closeMenu=(trigger:HTMLElement):void=>{if(trigger.getAttribute('aria-expanded')==='true')fireEvent.keyDown(trigger,{key:'Escape'});};

export function hasWorkspaceChoice(label:string):boolean{return screen.queryByRole('combobox',{name:label})!==null||screen.queryByRole('radiogroup',{name:label})!==null;}
export function workspaceChoiceDisabled(label:string):boolean{
 const group=screen.queryByRole('radiogroup',{name:label});
 if(group){for(let node:Element|null=group;node;node=node.parentElement)if(node instanceof HTMLFieldSetElement&&node.disabled)return true;return radios(label).every(radio=>radio.disabled);}
 return (screen.getByRole('combobox',{name:label}) as HTMLButtonElement).disabled;
}
/** Selects an exact original option value the way a user does: open the menu, then pick the option. */
export function chooseWorkspaceOption(label:string,value:string):void{
 const trigger=openMenu(label);
 const option=optionsOf(label).find(candidate=>candidate.getAttribute('data-value')===value);
 if(!option)throw Error(`No ${label} option ${JSON.stringify(value)}`);
 fireEvent.click(option);
 closeMenu(trigger);
}
/** Static choices are actual radios; the original enum value is the input value. */
export function chooseWorkspaceRadio(label:string,value:string):void{
 const radio=radios(label).find(candidate=>candidate.value===value);
 if(!radio)throw Error(`No ${label} radio ${JSON.stringify(value)}`);
 fireEvent.click(radio);
}
/** Chooses through whichever real control currently carries the label. */
export function chooseWorkspace(label:string,value:string):void{
 if(screen.queryByRole('combobox',{name:label}))chooseWorkspaceOption(label,value);else chooseWorkspaceRadio(label,value);
}
/** Original selected value, or null when nothing is selected. Menus are closed again after inspection. */
export function workspaceChoiceValue(label:string):string|null{
 if(screen.queryByRole('radiogroup',{name:label}))return radios(label).find(radio=>radio.checked)?.value??null;
 const trigger=openMenu(label);
 const selected=optionsOf(label).find(option=>option.getAttribute('aria-selected')==='true');
 const value=selected?.getAttribute('data-value')??null;
 closeMenu(trigger);
 return value;
}
/** Current original option values, in display order. */
export function workspaceChoiceValues(label:string):string[]{
 if(screen.queryByRole('radiogroup',{name:label}))return radios(label).map(radio=>radio.value);
 const trigger=openMenu(label);
 const values=optionsOf(label).map(option=>option.getAttribute('data-value')??'');
 closeMenu(trigger);
 return values;
}
