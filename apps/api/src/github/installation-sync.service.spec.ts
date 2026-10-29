import { permissionFrom } from "./installation-sync.service";

describe("permissionFrom", () => {
  it("maps GitHub permission flags to the highest level", () => {
    expect(permissionFrom({ admin: true, push: true, pull: true })).toBe("ADMIN");
    expect(permissionFrom({ admin: false, maintain: true, push: true, pull: true })).toBe("MAINTAIN");
    expect(permissionFrom({ admin: false, push: true, pull: true })).toBe("WRITE");
    expect(permissionFrom({ admin: false, push: false, triage: true, pull: true })).toBe("TRIAGE");
    expect(permissionFrom({ admin: false, push: false, pull: true })).toBe("READ");
  });

  it("grants nothing when GitHub reports no permissions", () => {
    expect(permissionFrom(undefined)).toBeNull();
    expect(permissionFrom({ admin: false, push: false, pull: false })).toBeNull();
  });
});
