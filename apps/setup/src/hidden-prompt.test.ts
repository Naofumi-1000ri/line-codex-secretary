import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { hiddenPrompt } from "./hidden-prompt.js";

function terminal() {
  const rawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: rawMode }) as unknown as NodeJS.ReadStream;
  const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  let displayed = "";
  output.on("data", chunk => { displayed += chunk; });
  return { input, output, rawMode, displayed: () => displayed };
}

it("accepts Windows Backspace and Enter without echoing the secret, and restores terminal state", async () => {
  const tty = terminal();
  const answer = hiddenPrompt("Hidden: ", tty.input, tty.output);
  tty.input.emit("data", "abc\bx\u007fy\r\n");
  expect(await answer).toBe("aby");
  expect(tty.displayed()).toBe("Hidden: \n");
  expect(tty.rawMode.mock.calls).toEqual([[true], [false]]);
  expect(tty.input.listenerCount("data")).toBe(0);
});

it("cancels on Ctrl+C without returning the partial secret", async () => {
  const tty = terminal();
  const answer = hiddenPrompt("Hidden: ", tty.input, tty.output);
  tty.input.emit("data", "partial\u0003");
  await expect(answer).rejects.toThrow("CANCELLED");
  expect(tty.displayed()).toBe("Hidden: ");
  expect(tty.rawMode.mock.calls).toEqual([[true], [false]]);
  expect(tty.input.listenerCount("data")).toBe(0);
});
