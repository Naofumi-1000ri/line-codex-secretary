import { expect, it } from "vitest";
import { immediateReply } from "./conversation.js";
import { jobResultSchema } from "@line-secretary/protocol";

it("does not skip image analysis for work, absent decisions or an internal placeholder", () => {
  for (const execution of ["work", null, undefined] as const) {
    expect(immediateReply(jobResultSchema.parse({ summary: "内部判定完了", execution }))).toBeUndefined();
  }
  expect(immediateReply(jobResultSchema.parse({ summary: "内部判定完了", execution: "reply" }))).toBeUndefined();
});
it("keeps the clarification and clears internal routing fields before delivery", () => {
  expect(immediateReply(jobResultSchema.parse({ summary: "画像5枚を受け取りました。どうしましょうか？", execution: "reply", notification: { mode: "detailed", scope: "turn" } })))
    .toMatchObject({ summary: "画像5枚を受け取りました。どうしましょうか？", execution: null, notification: null });
});
