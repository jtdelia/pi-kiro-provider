import { describe, expect, it, vi } from "vitest";

import kiroExtension from "../extensions/kiro";

describe("kiro extension scaffold", () => {
  it("exports a default extension factory", () => {
    expect(typeof kiroExtension).toBe("function");
  });

  it("registers the kiro provider", () => {
    const pi = {
      registerProvider: vi.fn(),
      on: vi.fn(),
    };

    expect(() => kiroExtension(pi as never)).not.toThrow();
    expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    expect(pi.registerProvider).toHaveBeenCalledWith(
      "kiro",
      expect.objectContaining({
        oauth: expect.objectContaining({
          name: "Kiro",
          login: expect.any(Function),
          refreshToken: expect.any(Function),
          getApiKey: expect.any(Function),
        }),
      }),
    );
  });
});
