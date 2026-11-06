// @vitest-environment jsdom
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {WorkspaceChoice,WorkspaceChoiceGroup,type WorkspaceChoiceOption} from '../../src/client/WorkspaceChoice.tsx';
import {chooseWorkspaceOption,workspaceChoiceValue} from './support/workspaceChoice.ts';
afterEach(cleanup);
const options:WorkspaceChoiceOption[]=[{value:'x',label:'X',disabled:true},{value:'a',label:'A'},{value:'b',label:'B',disabled:true},{value:'c',label:'C'},{value:'y',label:'Y',disabled:true}];
const trigger=():HTMLElement=>screen.getByRole('combobox',{name:'Choice'});
/** The option the active-descendant pointer currently names. */
const active=():string|null=>{const id=trigger().getAttribute('aria-activedescendant');return id?document.getElementById(id)?.getAttribute('data-value')??null:null;};
const key=(name:string):void=>{fireEvent.keyDown(trigger(),{key:name});};

it('keyboard movement never lands on a disabled option, wraps over them and only commits an enabled one',()=>{
 const onChange=vi.fn<(value:string)=>void>();render(<WorkspaceChoice label="Choice" value="" options={options} onChange={onChange}/>);
 expect(trigger().getAttribute('aria-expanded')).toBe('false');
 key('ArrowDown');expect(trigger().getAttribute('aria-expanded')).toBe('true');expect(active()).toBe('a');
 key('ArrowDown');expect(active()).toBe('c');key('ArrowDown');expect(active()).toBe('a');key('ArrowUp');expect(active()).toBe('c');
 key('Home');expect(active()).toBe('a');key('End');expect(active()).toBe('c');
 key('Enter');expect(onChange).toHaveBeenCalledExactlyOnceWith('c');expect(trigger().getAttribute('aria-expanded')).toBe('false');
});
it('Escape closes an open menu without choosing, and is consumed only while it is open',()=>{
 const onChange=vi.fn<(value:string)=>void>(),outer=vi.fn<(key:string)=>void>();
 render(<div onKeyDown={event=>outer(event.key)}><WorkspaceChoice label="Choice" value="a" options={options} onChange={onChange}/></div>);
 key('ArrowDown');expect(trigger().getAttribute('aria-expanded')).toBe('true');
 key('Escape');expect(trigger().getAttribute('aria-expanded')).toBe('false');expect(screen.queryByRole('listbox')).toBeNull();expect(outer).not.toHaveBeenCalledWith('Escape');expect(onChange).not.toHaveBeenCalled();
 key('Escape');expect(outer).toHaveBeenCalledWith('Escape');
});
it('an unselected choice opens on the first enabled option and an already selected one opens on itself',()=>{
 const {rerender}=render(<WorkspaceChoice label="Choice" value="" options={options} onChange={vi.fn()}/>);
 key('ArrowDown');expect(active()).toBe('a');key('Escape');
 rerender(<WorkspaceChoice label="Choice" value="c" options={options} onChange={vi.fn()}/>);key('ArrowDown');expect(active()).toBe('c');
});
it('choosing the selected value is not a change, so authored state the owner resets on change survives',()=>{
 const changes:string[]=[];
 function Owner(){const [value,setValue]=useState('a'),[draft,setDraft]=useState('');return <><WorkspaceChoice label="Choice" value={value} options={options} onChange={next=>{changes.push(next);setValue(next);setDraft('');}}/><textarea aria-label="Authored" value={draft} onChange={event=>setDraft(event.target.value)}/></>;}
 render(<Owner/>);fireEvent.change(screen.getByLabelText('Authored'),{target:{value:'Independent prose'}});
 chooseWorkspaceOption('Choice','a');
 expect(changes).toEqual([]);expect((screen.getByLabelText('Authored') as HTMLTextAreaElement).value).toBe('Independent prose');expect(workspaceChoiceValue('Choice')).toBe('a');
 chooseWorkspaceOption('Choice','c');
 expect(changes).toEqual(['c']);expect((screen.getByLabelText('Authored') as HTMLTextAreaElement).value).toBe('');expect(workspaceChoiceValue('Choice')).toBe('c');
});
it('a stale option element cannot commit once the control or the option became disabled',()=>{
 const onChange=vi.fn<(value:string)=>void>();
 const {rerender}=render(<WorkspaceChoice label="Choice" value="" options={options} onChange={onChange}/>);
 fireEvent.click(trigger());const stale=document.querySelector('[role="option"][data-value="c"]')!;
 // The option is withdrawn while the menu is still open.
 rerender(<WorkspaceChoice label="Choice" value="" options={options.map(option=>option.value==='c'?{...option,disabled:true}:option)} onChange={onChange}/>);
 fireEvent.click(document.querySelector('[role="option"][data-value="c"]')!);expect(onChange).not.toHaveBeenCalled();
 // The whole control is disabled by its prop: the menu closes and nothing can commit.
 rerender(<WorkspaceChoice label="Choice" value="" options={options} onChange={onChange} disabled/>);
 expect(screen.queryByRole('listbox')).toBeNull();fireEvent.click(stale);expect(onChange).not.toHaveBeenCalled();expect((trigger() as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(trigger());expect(screen.queryByRole('listbox')).toBeNull();
});
it('an enclosing disabled fieldset blocks a menu that was opened before it became disabled',()=>{
 const onChange=vi.fn<(value:string)=>void>();
 const view=(disabled:boolean)=><fieldset disabled={disabled}><WorkspaceChoice label="Choice" value="" options={options} onChange={onChange}/></fieldset>;
 const {rerender}=render(view(false));fireEvent.click(trigger());const option=document.querySelector('[role="option"][data-value="a"]')!;
 rerender(view(true));
 fireEvent.click(option);expect(onChange).not.toHaveBeenCalled();
 // The same open menu commits again once the fieldset is enabled.
 rerender(view(false));fireEvent.click(document.querySelector('[role="option"][data-value="a"]')!);expect(onChange).toHaveBeenCalledExactlyOnceWith('a');
});
it('a choice group is real radios: selection reports the original value, repeated selection is silent and a disabled group cannot change',()=>{
 const onChange=vi.fn<(value:string)=>void>(),radios=(label:string)=>screen.getAllByRole('radio',{name:label});
 const view=(disabled:boolean)=><WorkspaceChoiceGroup label="Group" value="a" options={[{value:'a',label:'A'},{value:'c',label:'C'},{value:'b',label:'B',disabled:true}]} onChange={onChange} disabled={disabled}/>;
 const {rerender}=render(view(false));
 expect((radios('A')[0] as HTMLInputElement).checked).toBe(true);fireEvent.click(radios('A')[0]!);expect(onChange).not.toHaveBeenCalled();
 fireEvent.click(radios('B')[0]!);expect(onChange).not.toHaveBeenCalled();
 fireEvent.click(radios('C')[0]!);expect(onChange).toHaveBeenCalledExactlyOnceWith('c');
 rerender(view(true));expect((screen.getByRole('radiogroup',{name:'Group'}) as HTMLFieldSetElement).disabled).toBe(true);
});
it('long current lists filter without changing the selection; Enter commits an exact enabled result and Escape restores the selected label',()=>{
 const choices=Array.from({length:10},(_,index)=>({value:`record-${index}`,label:`Company ${index}`,disabled:index===8})),onChange=vi.fn<(value:string)=>void>();
 const {rerender}=render(<WorkspaceChoice label="Choice" value="record-2" options={choices} onChange={onChange}/>);
 fireEvent.click(trigger());fireEvent.change(trigger(),{target:{value:'Company 8'}});expect(screen.getAllByRole('option')).toHaveLength(1);key('Enter');expect(onChange).not.toHaveBeenCalled();
 fireEvent.change(trigger(),{target:{value:'not present'}});expect(screen.queryByRole('option')).toBeNull();key('Enter');expect(onChange).not.toHaveBeenCalled();
 key('Escape');expect((trigger() as HTMLInputElement).value).toBe('Company 2');
 fireEvent.click(trigger());fireEvent.change(trigger(),{target:{value:'Company 9'}});key('Enter');expect(onChange).toHaveBeenCalledExactlyOnceWith('record-9');
 rerender(<WorkspaceChoice label="Choice" value="record-9" options={choices} onChange={onChange}/>);
 expect((trigger() as HTMLInputElement).value).toBe('Company 9');
});
