import { ChevronLeft, Plus } from 'lucide-react';
import type { JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import type { Firm } from '../fixtures.ts';
import { Block, dense, Label } from '../parts.tsx';
import { FirmHeader } from '../today/Today.tsx';
import { ActivityList, Contacts, FirmProperties, NextActions, Research } from './FirmContext.tsx';

/**
 * The firm page: the same parts as the panel, laid out as a document with a properties
 * column. Back returns to where the firm was opened from, with its place kept.
 */
export function FirmScreen({
  firm,
  from,
  editField,
  onBack,
  onEdit,
}: {
  readonly firm: Firm;
  readonly from: 'today' | 'pipeline';
  readonly editField: string | null;
  onBack(): void;
  onEdit(): void;
}): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col px-10 pt-5 pb-20">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 mb-3 flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> {from === 'today' ? 'Today' : 'Pipeline'}
        </button>
        <FirmHeader firm={firm} onEdit={onEdit} />
        <div className="mt-6 flex gap-12">
          <div className="min-w-0 max-w-[720px] flex-1">
            <Block>
              <Label
                actions={
                  <Button variant="ghost" className={cn(dense.sm, 'text-muted-foreground')}>
                    <Plus /> Add
                  </Button>
                }
              >
                Next actions
              </Label>
              <NextActions firm={firm} />
            </Block>
            <Block>
              <Label>Activity</Label>
              <ActivityList firm={firm} />
            </Block>
            <Block>
              <Label>Research</Label>
              <Research firm={firm} />
            </Block>
          </div>
          <aside aria-label="Properties and contacts" className="w-[300px] shrink-0">
            <Block>
              <Label>Properties</Label>
              <FirmProperties firm={firm} editField={editField} />
            </Block>
            <Block>
              <Label>Contacts</Label>
              <Contacts firm={firm} />
            </Block>
          </aside>
        </div>
      </div>
    </div>
  );
}
