import {expect,type Page} from 'playwright/test';

/** Real browser interaction with WorkspaceChoice (combobox/listbox) and WorkspaceChoiceGroup (radiogroup). */
const option=(page:Page,label:string,value:string)=>page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`);
export async function chooseWorkspaceOption(page:Page,label:string,value:string):Promise<void>{
 const trigger=page.getByRole('combobox',{name:label,exact:true});
 await expect(trigger).toBeEnabled();
 await trigger.click();
 await option(page,label,value).click();
 await expect(trigger).toHaveAttribute('aria-expanded','false');
}
export async function chooseWorkspaceRadio(page:Page,label:string,value:string):Promise<void>{
 const group=page.getByRole('radiogroup',{name:label,exact:true});
 const radio=group.locator(`input[type="radio"][value="${value}"]`);
 await expect(radio).toBeEnabled();
 // The input may be visually replaced by its chip; the label enclosing that exact radio is the real pointer target.
 await group.locator(`label:has(input[type="radio"][value="${value}"])`).click();
 await expect(radio).toBeChecked();
}
/**
 * Inspect a dynamic choice without changing it. The rendered label is always checked; an enabled menu is also
 * opened to prove the original value is the selected option. A disabled choice (held call, reload, other tab)
 * is never forced open or enabled.
 */
export async function expectWorkspaceOption(page:Page,label:string,value:string,rendered:string|RegExp):Promise<void>{
 const trigger=page.getByRole('combobox',{name:label,exact:true});
 await expect(trigger).toContainText(rendered);
 if(await trigger.isDisabled())return;
 await trigger.click();
 await expect(option(page,label,value)).toHaveAttribute('aria-selected','true');
 await trigger.press('Escape');
 await expect(trigger).toHaveAttribute('aria-expanded','false');
}
/** The first real (non-empty) option of an enabled choice, which must exist; no placeholder offset. */
export async function chooseFirstWorkspaceOption(page:Page,label:string):Promise<string> {
 const values=(await workspaceOptionValues(page,label)).filter(value=>value!=='');
 expect(values.length,`${label} must offer a real option`).toBeGreaterThan(0);
 const first=values[0]!;
 await chooseWorkspaceOption(page,label,first);
 return first;
}
/** Original option values in display order; the menu is closed again. */
export async function workspaceOptionValues(page:Page,label:string):Promise<string[]>{
 const trigger=page.getByRole('combobox',{name:label,exact:true});
 await trigger.click();
 const values=await page.getByRole('listbox',{name:label,exact:true}).locator('[role="option"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-value')??''));
 await trigger.press('Escape');
 return values;
}
