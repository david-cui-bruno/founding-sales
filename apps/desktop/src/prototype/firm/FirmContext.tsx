import { Circle, ExternalLink, Pause, Play, Plus } from 'lucide-react';
import { useState, type JSX } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Button } from '../../renderer/ui/button.tsx';
import { ineligibility, STAGES, type Firm } from '../fixtures.ts';
import { Block, Chip, dense, Label, PropertyRow } from '../parts.tsx';
import { ActivityIcon, duration } from '../today/Brief.tsx';

/**
 * The shared firm context: one set of parts that Today's context column, the Pipeline's
 * side panel and the full firm page all draw, so a firm reads the same wherever it opens.
 */

export function stageLabel(firm: Pick<Firm, 'stage'>): string {
  return firm.stage === null ? 'Prospect' : (STAGES.find(stage => stage.id === firm.stage)?.label ?? firm.stage);
}

export function FirmProperties({
  firm,
  editField,
  explain = true,
}: {
  readonly firm: Firm;
  readonly editField?: string | null;
  /** Say why an ineligible firm can't be called (Today's call panel already does). */
  readonly explain?: boolean;
}): JSX.Element {
  const location = firm.city === null ? null : `${firm.city}, ${firm.state ?? ''}`;
  const blocked = ineligibility(firm);
  return (
    <div data-testid="properties" className="flex flex-col">
      <PropertyRow key={`${firm.id}-phone-${editField ?? ''}`} label="Phone" value={firm.phone} missing="Add a phone number" mono editing={editField === 'phone'} testId="prop-phone" />
      <PropertyRow key={`${firm.id}-loc-${editField ?? ''}`} label="Location" value={location} missing="Add city and state" editing={editField === 'location'} testId="prop-location" />
      <PropertyRow
        key={`${firm.id}-tz-${editField ?? ''}`}
        label="Time zone"
        value={firm.timeZone === null ? null : 'Central (CT)'}
        missing="Follows from the location"
        testId="prop-tz"
      />
      <PropertyRow key={`${firm.id}-doors-${editField ?? ''}`} label="Doors" value={firm.doors} />
      <PropertyRow key={`${firm.id}-sw-${editField ?? ''}`} label="Software" value={firm.software === 'Unknown' ? null : firm.software} missing="Unknown" />
      <PropertyRow key={`${firm.id}-web-${editField ?? ''}`} label="Website" value={firm.website} />
      <PropertyRow key={`${firm.id}-stage-${editField ?? ''}`} label="Stage" value={stageLabel(firm)} />
      {blocked === null || !explain ? null : (
        <p data-testid="eligibility" className="mt-2 rounded-md bg-warn-soft/70 px-2.5 py-2 text-xs text-warn-ink">
          <span className="font-medium">Not eligible to call.</span> {blocked.detail}
        </p>
      )}
    </div>
  );
}

export function Contacts({ firm }: { readonly firm: Firm }): JSX.Element {
  return (
    <div className="flex flex-col">
      {firm.contacts.length === 0 ? <p className="text-sm text-muted-foreground">No contacts yet.</p> : null}
      {firm.contacts.map(contact => (
        <div key={contact.name} className="group flex items-start gap-2.5 rounded-md py-1.5">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground">
            {contact.name
              .split(' ')
              .map(part => part[0])
              .join('')
              .slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm">
              <span className="truncate font-medium">{contact.name}</span>
              {contact.primary === true ? <Chip tone="outline">Primary</Chip> : null}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {contact.role}
              {contact.phone === undefined ? '' : ` · ${contact.phone}`}
            </p>
            {contact.email === undefined ? null : <p className="truncate text-xs text-muted-foreground">{contact.email}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function NextActions({ firm }: { readonly firm: Firm }): JSX.Element {
  return (
    <ul className="flex flex-col">
      {firm.nextActions.length === 0 ? <li className="text-sm text-muted-foreground">Nothing scheduled.</li> : null}
      {firm.nextActions.map(action => (
        <li key={action.label} className="group flex items-center gap-2.5 rounded-md py-1">
          <Circle className="size-3.5 shrink-0 text-strong" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">{action.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{action.due}</span>
        </li>
      ))}
    </ul>
  );
}

function Recording({ seconds }: { readonly seconds: number }): JSX.Element {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border px-2 py-1">
      <Button variant="ghost" className="size-6 rounded-sm p-0" aria-label={playing ? 'Pause recording' : 'Play recording'} onClick={() => setPlaying(!playing)}>
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </Button>
      <span className="relative h-1 flex-1 rounded-full bg-muted">
        <span className={cn('absolute inset-y-0 left-0 rounded-full bg-foreground/60', playing ? 'w-1/3' : 'w-0')} />
      </span>
      <span className="text-xs text-muted-foreground tabular">{duration(seconds)}</span>
      <button type="button" className="rounded-sm text-xs text-muted-foreground hover:text-foreground">
        Transcript
      </button>
    </div>
  );
}

export function ActivityList({ firm }: { readonly firm: Firm }): JSX.Element {
  if (firm.activity.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="relative flex flex-col">
      {firm.activity.map((item, index) => (
        <li key={`${item.at}:${item.title}`} className="relative flex gap-3 pb-4 last:pb-0">
          {index < firm.activity.length - 1 ? <span aria-hidden className="absolute top-5 bottom-0 left-[6.5px] w-px bg-border" /> : null}
          <span className="relative mt-[3px] flex size-3.5 items-center justify-center bg-background">
            <ActivityIcon kind={item.kind} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-medium">{item.title}</span>
              {item.durationSec === undefined ? null : <span className="text-muted-foreground tabular"> · {duration(item.durationSec)}</span>}
            </p>
            <p className="text-xs text-faint">{item.at}</p>
            {item.detail === undefined ? null : <p className="mt-0.5 text-sm text-muted-foreground">{item.detail}</p>}
            {item.summary === undefined ? null : (
              <div className="mt-1.5 rounded-md bg-muted/60 px-3 py-2">
                <p className="mb-0.5 text-xs font-medium text-muted-foreground">Summary</p>
                <ul className="flex list-disc flex-col pl-4 text-sm marker:text-faint">
                  {item.summary.map(line => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {item.kind === 'call' && item.durationSec !== undefined ? <Recording seconds={item.durationSec} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Research({ firm }: { readonly firm: Firm }): JSX.Element {
  if (firm.research.length === 0) return <p className="text-sm text-muted-foreground">No research yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {firm.research.map(note => (
        <div key={note.heading}>
          <p className="text-sm font-medium">{note.heading}</p>
          <p className="text-sm">
            {note.body}{' '}
            {note.sources.map(index => (
              <sup key={index} className="ml-0.5 text-2xs text-link">
                [{index + 1}]
              </sup>
            ))}
          </p>
        </div>
      ))}
      <ol className="flex flex-col gap-1 border-t border-border pt-2">
        {firm.sources.map((source, index) => (
          <li key={source.url} className="flex items-baseline gap-2 text-xs">
            <span className="w-5 shrink-0 text-faint tabular">[{index + 1}]</span>
            <span className="min-w-0 flex-1 truncate">{source.title}</span>
            <span className="shrink-0 text-faint">{source.observed}</span>
            <ExternalLink className="size-3 shrink-0 text-faint" aria-hidden />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The panel form: one column, key information first, the rest below. */
export function FirmContext({ firm, editField }: { readonly firm: Firm; readonly editField?: string | null }): JSX.Element {
  return (
    <div className="flex flex-col">
      <Block>
        <Label>Properties</Label>
        <FirmProperties firm={firm} editField={editField ?? null} />
      </Block>
      <Block>
        <Label
          actions={
            <Button variant="ghost" className={dense.sm}>
              <Plus /> Add
            </Button>
          }
        >
          Next actions
        </Label>
        <NextActions firm={firm} />
      </Block>
      <Block>
        <Label>Contacts</Label>
        <Contacts firm={firm} />
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
  );
}
