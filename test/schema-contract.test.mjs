import test from "node:test";
import assert from "node:assert/strict";
import { setupRuntime } from "./runtime-helpers.mjs";

// Locks the provider-facing schema shape: a root `type: "object"` wrapping the
// request union. These invariants keep root-union-intolerant providers (e.g.
// DeepSeek) working and keep cross-action parameters schema-rejected; a
// TypeBox/pi-ai upgrade or a "simplification" must not silently break them.
// See src/SPEC.md (tool contract) and CHANGELOG (Unreleased).

test("midcompact parameters: root object wrapping the request union", () => {
  const { pi } = setupRuntime([]);
  const schema = pi.tools.get("midcompact").parameters;

  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);

  const request = schema.properties.request;
  assert.ok(Array.isArray(request.anyOf), "request must be a discriminated union");

  const actions = request.anyOf.map((branch) => {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    const discriminant = branch.properties.action;
    assert.ok(
      Array.isArray(discriminant.enum) && discriminant.enum.length === 1,
      "branch discriminant must be a single-value enum",
    );
    assert.equal(discriminant.const, undefined, "discriminant must not serialize as const");
    return discriminant.enum[0];
  });

  assert.deepEqual(actions.sort(), ["inspect", "locate", "plan", "recall"]);
});
