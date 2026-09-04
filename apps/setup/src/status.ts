import { readFile } from "node:fs/promises";
import path from "node:path";

const progressPath = path.resolve(".setup/progress.json");
const progress = JSON.parse(await readFile(progressPath, "utf8")) as {
  currentStep: string;
  steps: Record<string, { status: string }>;
};
const complete = Object.values(progress.steps).filter((step) => step.status === "complete").length;
console.log(`LINE秘書セットアップ: ${complete}/26 完了（現在 ${progress.currentStep}）`);
