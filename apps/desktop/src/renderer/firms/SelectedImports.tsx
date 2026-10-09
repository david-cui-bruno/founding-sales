import { useCallback, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { z } from "zod";
import type {
  selectedImportInputSchema,
  selectedImportPreviewSchema,
  selectedImportPageSchema,
  selectedImportCommitPayloadSchema,
  selectedImportCorrectPayloadSchema,
  selectedImportChangePayloadSchema,
  selectedImportResultSchema,
} from "@fss/contracts";
import { SelectedAttachments, type SelectedAttachmentPorts } from "./SelectedAttachments.tsx";
import { Button } from "../ui/button.tsx";
import { Select } from "../ui/select.tsx";
type Input = z.infer<typeof selectedImportInputSchema>;
type Preview = z.infer<typeof selectedImportPreviewSchema>;
type Page = z.infer<typeof selectedImportPageSchema>;
type Change = z.infer<typeof selectedImportChangePayloadSchema>;
export interface SelectedImportPorts {
  attachments?: SelectedAttachmentPorts;
  read(scope: {
    personId?: string;
    firmId?: string;
    afterId?: string | undefined;
  }): Promise<Page>;
  preview(input: Input): Promise<Preview>;
  commit(
    input: z.infer<typeof selectedImportCommitPayloadSchema>,
  ): Promise<z.infer<typeof selectedImportResultSchema>>;
  correct(
    input: z.infer<typeof selectedImportCorrectPayloadSchema>,
  ): Promise<void>;
  remove(input: Change): Promise<void>;
  restore(input: Change): Promise<void>;
  recapture(
    input: z.infer<typeof selectedImportCorrectPayloadSchema>,
  ): Promise<void>;
  readFile(file: File): Promise<{ text: string; label: string }>;
}
export function SelectedImports({
  personId,
  firmId,
  ports,
  enabled,
  onChange,
  sourceVersion,
  privacyKey,
}: {
  personId?: string;
  firmId?: string;
  ports: SelectedImportPorts;
  enabled: boolean;
  onChange?: (isCurrent?: () => boolean) => Promise<void>;
  sourceVersion?: string;
  privacyKey?: string;
}): JSX.Element {
  const scope = useMemo(
    () => ({
      ...(personId === undefined ? {} : { personId }),
      ...(firmId === undefined ? {} : { firmId }),
    }),
    [personId, firmId],
  );
  const [page, setPage] = useState<Page | null>(null);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("Selected conversation");
  const [subtype, setSubtype] = useState<Input["subtype"]>("pasted_text");
  const [direction, setDirection] = useState<Input["direction"]>("unknown");
  const [participants, setParticipants] = useState("");
  const [date, setDate] = useState("");
  const [attachment, setAttachment] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [otherAttachments, setOtherAttachments] = useState<
    Input["attachments"]
  >([]);
  const [exactOriginalDate, setExactOriginalDate] = useState<string | null>(
    null,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editing, setEditing] = useState<Page["imports"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importKey, setImportKey] = useState(() => crypto.randomUUID());
  const sourceEpoch = useRef(0);
  const invalidateReads = useCallback(() => ++sourceEpoch.current, []);
  useLayoutEffect(() => {
    const ticket = invalidateReads();
    setBusy(false);
    setPage(null);
    setText("");
    setLabel("Selected conversation");
    setDirection("unknown");
    setSubtype("pasted_text");
    setPreview(null);
    setEditing(null);
    setParticipants("");
    setDate("");
    setAttachment("");
    setAttachmentUrl("");
    setOtherAttachments([]);
    setExactOriginalDate(null);
    setError("");
    if (!enabled) return () => { invalidateReads(); };
    void ports
      .read(scope)
      .then((value) => {
        if (ticket === sourceEpoch.current) setPage(value);
      })
      .catch(() => {
        if (ticket === sourceEpoch.current) setError("Imported conversations could not be loaded.");
      });
    return () => {
      invalidateReads();
    };
  }, [ports, scope, sourceVersion, privacyKey, enabled, invalidateReads]);
  const run = async (work: (ticket: number) => Promise<void>) => {
    const ticket = invalidateReads();
    setBusy(true);
    setError("");
    try {
      await work(ticket);
    } catch (error) {
      if (ticket !== sourceEpoch.current) return;
      setPage(null);
      setText("");
      setLabel("Selected conversation");
      setParticipants("");
      setDate("");
      setAttachment("");
      setAttachmentUrl("");
      setOtherAttachments([]);
      setExactOriginalDate(null);
      setEditing(null);
      setPreview(null);
      setError(
        error instanceof Error && error.message === "import_context_required"
          ? "Select the permitted firm for this import. The person’s original contact association is unavailable."
          : "The import could not be completed. Check the selected text, source versions and current access.",
      );
    } finally {
      if (ticket === sourceEpoch.current) setBusy(false);
    }
  };
  const input = (): Input => ({
    text,
    label,
    subtype,
    direction,
    participants: participants
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const [label, endpoint] = value.split("|");
        return {
          label: label?.trim() ?? "",
          endpoint: endpoint?.trim() || null,
          provenance: "user_supplied",
        };
      }),
    occurredAt:
      exactOriginalDate ?? (date ? new Date(date).toISOString() : null),
    attachments: [
      ...(attachment ? [{ name: attachment, url: attachmentUrl || null }] : []),
      ...otherAttachments,
    ],
  });
  const refresh = async (ticket: number) => {
    if (ticket !== sourceEpoch.current) return;
    setPage(null);
    await onChange?.(() => ticket === sourceEpoch.current);
    if (ticket !== sourceEpoch.current) return;
    const next = await ports.read(scope);
    if (ticket === sourceEpoch.current) setPage(next);
  };
  const change = (item: Page["imports"][number]): Change => ({
    sourceId: item.source.sourceId,
    expectedSourceRevision: item.source.revision,
    expectedMetadataRevision: item.metadata.revision,
  });
  return (
    <section aria-label="Selected conversation imports" className="space-y-3">
      <h4>Selected conversations</h4>
      <p>
        Selected imported evidence. Direction is unverified; attachments are
        references only.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {ports.attachments ? <SelectedAttachments ports={ports.attachments} enabled={enabled} personId={personId} firmId={firmId} privacyKey={privacyKey} sourceVersion={sourceVersion} sources={page?.imports.filter(item => item.metadata.subtype === "selected_file").map(item => ({sourceId:item.source.sourceId,label:item.metadata.label ?? "Deleted file"})) ?? []} onChange={async()=>{ const ticket=sourceEpoch.current; await onChange?.(() => ticket === sourceEpoch.current); if(ticket!==sourceEpoch.current)return; const value=await ports.read(scope); if(ticket===sourceEpoch.current)setPage(value); }} /> : <label>
        Selected text file
        <input
          aria-label="Selected text file"
          type="file"
          accept=".txt,.md,.csv,.srt,.vtt"
          disabled={!enabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file)
              void run(async (ticket) => {
                setPreview(null);
                const selected = await ports.readFile(file);
                if (ticket !== sourceEpoch.current) return;
                setText(selected.text);
                setLabel(selected.label);
                setSubtype("selected_file");
              });
            event.target.value = "";
          }}
        />
      </label>}
      <label>
        Import label
        <input
          aria-label="Import label"
          value={label}
          maxLength={240}
          onChange={(event) => {
            setLabel(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        Selected conversation text
        <textarea
          aria-label="Selected conversation text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      {text.length > 20000 ? (
        <p role="alert">
          Select at most 20,000 characters; the text will not be truncated.
        </p>
      ) : null}
      <label>
        Selected source type
        <Select
          aria-label="Selected source type"
          value={subtype}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "pasted_text" ||
              value === "transcript" ||
              value === "selected_file"
            )
              setSubtype(value);
            setPreview(null);
          }}
        >
          <option value="pasted_text">Pasted text</option>
          <option value="transcript">Transcript excerpt</option>
          <option value="selected_file">Selected text file</option>
        </Select>
      </label>
      <label>
        Asserted direction
        <Select
          aria-label="Asserted direction"
          value={direction}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "incoming" ||
              value === "outgoing" ||
              value === "draft" ||
              value === "unknown"
            )
              setDirection(value);
            setPreview(null);
          }}
        >
          <option value="unknown">Unknown</option>
          <option value="incoming">Incoming assertion</option>
          <option value="outgoing">Outgoing assertion</option>
          <option value="draft">Draft</option>
        </Select>
      </label>
      <label>
        Participant labels
        <textarea
          aria-label="Participant labels"
          placeholder="Optional: label | email or phone, one per line"
          value={participants}
          onChange={(event) => {
            setParticipants(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        Original conversation date
        <input
          aria-label="Original conversation date"
          type="datetime-local"
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            setExactOriginalDate(null);
            setPreview(null);
          }}
        />
      </label>
      <p>Leave dates and participants blank when unknown.</p>
      <label>
        Attachment reference name
        <input
          aria-label="Attachment reference name"
          value={attachment}
          maxLength={240}
          onChange={(event) => {
            setAttachment(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        Attachment reference link
        <input
          aria-label="Attachment reference link"
          value={attachmentUrl}
          onChange={(event) => {
            setAttachmentUrl(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      {otherAttachments.map((reference, index) => (
        <p key={index}>
          {reference.name} — reference only{" "}
          <Button
            disabled={busy}
            onClick={() => {
              setOtherAttachments(
                otherAttachments.filter((_, item) => item !== index),
              );
              setPreview(null);
            }}
          >
            Remove reference {reference.name}
          </Button>
        </p>
      ))}
      <Button
        disabled={
          !enabled ||
          busy ||
          !text.trim() ||
          text.length > 20000 ||
          !label.trim()
        }
        onClick={() =>
          void run(async (ticket) => {
            const value = await ports.preview(input());
            if (ticket === sourceEpoch.current) setPreview(value);
          })
        }
      >
        Preview selected conversation
      </Button>
      {preview ? (
        <section aria-label="Import preview">
          <p>
            {preview.occurredAt === null
              ? "Original date unknown"
              : `Original date: ${preview.occurredAt} (${preview.dateProvenance})`}
          </p>
          <p>
            {preview.participants.length === 0
              ? "Participants unknown"
              : preview.participants
                  .map((item) => `${item.label} (${item.provenance})`)
                  .join(", ")}
          </p>
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {preview.candidates.map((candidate, index) => (
            <p key={`${candidate.endpoint}:${index}`}>
              {candidate.endpoint}: {candidate.outcome}; review before
              association.
            </p>
          ))}
        </section>
      ) : null}
      <Button
        disabled={!enabled || busy || preview === null}
        onClick={() =>
          void run(async (ticket) => {
            if (preview === null) return;
            const selected = {
              ...input(),
              previewHash: preview.previewHash,
              parserVersion: preview.parserVersion,
            };
            if (editing === null)
              await ports.commit({
                ...selected,
                importKey,
                personId: personId ?? null,
                firmId: firmId ?? null,
              });
            else if (editing.source.availability === "awaiting_recapture")
              await ports.recapture({ ...selected, ...change(editing) });
            else await ports.correct({ ...selected, ...change(editing) });
            if (ticket !== sourceEpoch.current) return;
            setPreview(null);
            setEditing(null);
            setText("");
            setImportKey(crypto.randomUUID());
            await refresh(ticket);
          })
        }
      >
        {editing === null
          ? "Import selected conversation"
          : editing.source.availability === "awaiting_recapture"
            ? "Recapture selected conversation"
            : "Save import correction"}
      </Button>
      {editing ? (
        <Button
          onClick={() => {
            setEditing(null);
            setText("");
            setPreview(null);
          }}
        >
          Cancel import correction
        </Button>
      ) : null}
      <ul>
        {page?.imports.map((item) => (
          <li key={item.source.sourceId}>
            <p>{item.metadata.label ?? "Deleted imported conversation"}</p>
            <p>{item.source.excerpt}</p>
            <p>
              {item.source.occurredAt === null
                ? "Original date unknown"
                : `Original date: ${item.source.occurredAt} (${item.metadata.dateProvenance ?? "unknown"})`}
            </p>
            <p>
              {item.metadata.direction === null
                ? "Imported assertion unavailable"
                : `${item.metadata.direction} — unverified imported assertion`}
            </p>
            <p>
              {item.metadata.participants?.length
                ? item.metadata.participants
                    .map(
                      (participant) =>
                        `${participant.label} (${participant.provenance})`,
                    )
                    .join(", ")
                : "Participants unknown"}
            </p>
            {item.metadata.attachments?.map((reference, index) => (
              <p key={index}>
                {reference.name}
                {reference.url ? (
                  <>
                    {" "}
                    — <a href={reference.url}>Reference link</a>
                  </>
                ) : null}{" "}
                — content not analyzed
              </p>
            ))}
            {item.source.availability === "deleted" ? (
              <Button
                disabled={!enabled || busy}
                onClick={() =>
                  void run(async (ticket) => {
                    await ports.restore(change(item));
                    await refresh(ticket);
                  })
                }
              >
                Restore imported source for recapture
              </Button>
            ) : (
              <>
                <Button
                  disabled={!enabled || busy}
                  onClick={() => {
                    setEditing(item);
                    setText(item.source.excerpt ?? "");
                    setLabel(item.metadata.label ?? "Selected conversation");
                    setSubtype(item.metadata.subtype);
                    setDirection(item.metadata.direction ?? "unknown");
                    setParticipants(
                      item.metadata.participants
                        ?.map(
                          (participant) =>
                            `${participant.label}${participant.endpoint ? ` | ${participant.endpoint}` : ""}`,
                        )
                        .join("\n") ?? "",
                    );
                    setDate(
                      item.source.occurredAt === null
                        ? ""
                        : new Date(
                            new Date(item.source.occurredAt).getTime() -
                              new Date(
                                item.source.occurredAt,
                              ).getTimezoneOffset() *
                                60000,
                          )
                            .toISOString()
                            .slice(0, 16),
                    );
                    setExactOriginalDate(item.source.occurredAt);
                    setOtherAttachments(
                      item.metadata.attachments?.slice(1) ?? [],
                    );
                    setAttachment(item.metadata.attachments?.[0]?.name ?? "");
                    setAttachmentUrl(item.metadata.attachments?.[0]?.url ?? "");
                    setPreview(null);
                  }}
                >
                  {item.source.availability === "awaiting_recapture"
                    ? "Recapture imported conversation"
                    : "Correct imported conversation"}
                </Button>
                <Button
                  disabled={!enabled || busy}
                  onClick={() =>
                    void run(async (ticket) => {
                      setPage(null);
                      setText("");
                      setLabel("Selected conversation");
                      setDate("");
                      setDirection("unknown");
                      setPreview(null);
                      setEditing(null);
                      setParticipants("");
                      setAttachment("");
                      setAttachmentUrl("");
                      setOtherAttachments([]);
                      setExactOriginalDate(null);
                      await ports.remove(change(item));
                      await refresh(ticket);
                    })
                  }
                >
                  Delete imported conversation
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {page?.nextAfterId ? (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async (ticket) => {
              setPage(null);
              const next = await ports.read({
                ...scope,
                afterId: page.nextAfterId ?? undefined,
              });
              if (ticket === sourceEpoch.current) setPage(next);
            })
          }
        >
          More imported conversations
        </Button>
      ) : null}
    </section>
  );
}
