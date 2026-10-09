import { expect, it } from "vitest";
import { readSelectedTextFile } from "../src/renderer/firms/selectedImportPorts.ts";
const file = (name: string, text: string) => ({
  name,
  size: new TextEncoder().encode(text).length,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});
it("reads only the explicitly selected bounded UTF-8 text and refuses binary or over-limit files without truncating", async () => {
  expect(
    await readSelectedTextFile(
      file("selected-transcript.txt", "Original selected passage"),
    ),
  ).toEqual({
    label: "selected-transcript.txt",
    text: "Original selected passage",
  });
  await expect(
    readSelectedTextFile(file("recording.mp3", "Not a transcript")),
  ).rejects.toThrow("selected_file_unsupported");
  await expect(
    readSelectedTextFile(file("long.txt", "x".repeat(20001))),
  ).rejects.toThrow("selected_file_limit");
  await expect(
    readSelectedTextFile(file("binary.txt", "before\0after")),
  ).rejects.toThrow("selected_file_limit");
});
