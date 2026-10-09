import type { JSX } from 'react';
import type { FirmIdentityDto } from '@fss/contracts';
import type { PipelineView } from '../firmWorkspaceContract.ts';
import { Button } from '../ui/button.tsx';
import { Row, RowMain, Rows, Section, Tag } from '../ui/layout.tsx';

/**
 * Firms: every firm on file, cold ones included (1.0.14).
 *
 * Until 1.0.14 the sidebar's Firms was the pipeline board with a "Not in the pipeline
 * yet" list above it, which is two different questions answered on one screen: what am I
 * working, and who is on file. Pipeline answers the first. This answers the second, and
 * so it is a flat list in one order — by name, as the server sent it — with no board, no
 * stage control and no column.
 *
 * It reads nothing of its own. `POST /pipeline/board` already answers with every active
 * firm: the ones in a stage, in their columns, and the ones with no open opportunity
 * beside them. So the list is that answer read the other way round, and a firm added a
 * moment ago is in it because the same read put it there.
 *
 * The stage a firm is in is a tag rather than a heading, and a firm with no open
 * opportunity says so. A person scanning for somebody they have not called yet is
 * looking for exactly that line.
 */

export const NOT_IN_PIPELINE = 'Not in the pipeline';

/** Every active firm the board read carried, in the order the server sent them. */
export function firmsOf(pipeline: PipelineView): readonly FirmIdentityDto[] {
  const placed = pipeline.columns.flatMap(column => column.firms);
  const all = [...new Map([...placed, ...(pipeline.unplacedFirms ?? [])].map(firm=>[firm.id,firm])).values()];
  // The board's own order is by name; the columns re-sliced it, so it is restored here.
  return all.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** The stage's own name, or null when this firm is in no column. */
export function stageNameOf(pipeline: PipelineView, firm: FirmIdentityDto): string | null {
  if(pipeline.plural!==undefined&&Object.values(pipeline.plural.cards).filter(card=>card.firm.id===firm.id).length>1)return 'Multiple deals';
  if (firm.stageKey === null) return null;
  return pipeline.columns.find(column => column.stage.key === firm.stageKey)?.stage.displayName ?? firm.stageKey;
}

export function FirmsList({
  pipeline,
  onOpenFirm,
}: {
  readonly pipeline: PipelineView;
  onOpenFirm(firmId: string): void;
}): JSX.Element {
  const firms = firmsOf(pipeline);
  return (
    <Section data-testid="firms-list" title="Every firm" count={firms.length}>
      {firms.length === 0 ? (
        <p data-testid="firms-list-empty" className="py-2 text-sm text-muted-foreground">
          No firms yet. Add one, or import a list.
        </p>
      ) : (
        <Rows data-testid="firms-rows">
          {firms.map(firm => {
            const stage = stageNameOf(pipeline, firm);
            return (
              <Row key={firm.id} data-testid="firms-row" data-firm-id={firm.id}>
                <RowMain
                  line={
                    <Button
                      variant="link"
                      size="sm"
                      data-testid="firms-open-firm"
                      className="h-auto px-0 text-sm"
                      onClick={() => {
                        onOpenFirm(firm.id);
                      }}
                    >
                      {firm.name}
                    </Button>
                  }
                  detail={[firm.locality, firm.regionCode].filter(part => part !== null).join(', ') || null}
                />
                <Tag data-testid="firms-row-stage">{stage ?? NOT_IN_PIPELINE}</Tag>
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}
