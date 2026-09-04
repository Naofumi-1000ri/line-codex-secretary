import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "./index.js";

describe("verifyLineSignature", () => {
  it("accepts the HMAC for the exact raw request body", async () => {
    const body = '{"events":[]}';
    const secret = "test-channel-secret";
    const signature = createHmac("sha256", secret).update(body).digest("base64");
    await expect(verifyLineSignature(body, signature, secret)).resolves.toBe(true);
  });

  it("rejects modified bodies and malformed signatures", async () => {
    const secret = "test-channel-secret";
    const signature = createHmac("sha256", secret).update("original").digest("base64");
    await expect(verifyLineSignature("modified", signature, secret)).resolves.toBe(false);
    await expect(verifyLineSignature("modified", "%%%", secret)).resolves.toBe(false);
  });
});
