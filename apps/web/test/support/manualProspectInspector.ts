import type {Page} from 'playwright/test';
import {expect} from 'playwright/test';

/** Deliberate selection through the actual current-page worklist, not a hidden card. */
export async function inspectManualProspect(page:Page,candidateId:string):Promise<void>{
 const worklist=page.getByRole('region',{name:'Manual prospect worklist',exact:true});
 if(await worklist.getByRole('button',{name:'Worklist',exact:true}).getAttribute('aria-pressed')==='false')await worklist.getByRole('button',{name:'Worklist',exact:true}).click();
 await worklist.getByRole('table').locator(`tr[data-candidate-id="${candidateId}"]`).getByRole('button').click();
 await expect(worklist.getByRole('article',{name:`Manual prospect ${candidateId}`,exact:true})).toBeVisible();
}
