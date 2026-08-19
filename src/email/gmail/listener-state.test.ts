import { describe, expect, it } from "vitest";

import { reconnectDelayMs } from "./listener-state.js";

describe("reconnectDelayMs", () => {
  it("uses the bounded reconnect schedule", () => {
    expect([0, 1, 2, 3, 4, 5, 100].map(reconnectDelayMs)).toEqual([
      1_000,
      2_000,
      5_000,
      10_000,
      30_000,
      30_000,
      30_000,
    ]);
  });
});
