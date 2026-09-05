import { describe, it, expect } from "vitest";
import { resolveRole } from "../../src/access-role";
import type { AccessRecord } from "../../src/access-role";

const base: AccessRecord = { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

describe("resolveRole", () => {
  it("grants the owner editor access regardless of general access", () => {
    expect(resolveRole(base, "alice")).toBe("editor");
    expect(resolveRole({ ...base, generalAccess: "anyone" }, "alice")).toBe("editor");
  });

  it("grants the general-access role to anyone when the link doesn't require an account", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: false, role: "reviewer" };
    expect(resolveRole(access, null)).toBe("reviewer");
    expect(resolveRole(access, "carol")).toBe("reviewer");
  });

  it("denies an anonymous visitor when the general-access link requires an account", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: true, role: "reviewer" };
    expect(resolveRole(access, null)).toBeNull();
  });

  it("still grants the general-access role to a signed-in stranger when an account is required", () => {
    const access: AccessRecord = { ...base, generalAccess: "anyone", requireAccount: true, role: "reviewer" };
    expect(resolveRole(access, "carol")).toBe("reviewer");
  });

  it("grants an invited person their assigned role on a restricted workspace", () => {
    const access: AccessRecord = { ...base, invited: [{ username: "bob", role: "reviewer" }] };
    expect(resolveRole(access, "bob")).toBe("reviewer");
  });

  it("denies a signed-in stranger not on the invited list", () => {
    const access: AccessRecord = { ...base, invited: [{ username: "bob", role: "reviewer" }] };
    expect(resolveRole(access, "carol")).toBeNull();
  });

  it("denies an anonymous visitor on a restricted workspace", () => {
    expect(resolveRole(base, null)).toBeNull();
  });

  it("denies everyone when there's no owner yet", () => {
    const access: AccessRecord = { ...base, owner: null };
    expect(resolveRole(access, null)).toBeNull();
    expect(resolveRole(access, "carol")).toBeNull();
  });
});
