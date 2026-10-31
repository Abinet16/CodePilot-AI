import { commitMessage } from "./patch-stage";

describe("commitMessage", () => {
  const taskId = "1a2b3c4d-0000-4000-8000-000000000000";

  it("uses the model's subject, its summary as the body, and task trailers", () => {
    expect(commitMessage("Fix totalPages", "Use Math.ceil.\r\nAdds a test.", taskId, 2)).toBe(
      `Fix totalPages\n\nUse Math.ceil.\nAdds a test.\n\nCodePilot-Task: ${taskId}\nCodePilot-Plan: v2\n`,
    );
  });

  it("strips control characters from the body", () => {
    expect(commitMessage("Fix", "a\u0000b\u001b[31mc", taskId, 1)).toContain("\n\nab[31mc\n\n");
  });
});
