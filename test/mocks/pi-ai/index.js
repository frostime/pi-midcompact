// Mirrors the JSON-Schema shape real TypeBox serializes to, so tests can
// assert on provider-facing schema structure (see schema-contract.test.mjs).
// Only the surface the extension relies on is modeled; optionality is
// identity here (real TypeBox marks it via an internal symbol).
export const Type = {
  Object: (value, options = {}) => ({ type: "object", properties: value, ...options }),
  Array: (value, options = {}) => ({ type: "array", items: value, ...options }),
  Union: (value) => ({ anyOf: value }),
  Literal: (value, options = {}) => ({ type: "string", const: value, ...options }),
  Optional: (value) => value,
  String: (options = {}) => ({ type: "string", ...options }),
  Number: (options = {}) => ({ type: "number", ...options }),
};

export const StringEnum = (values, options = {}) => ({ type: "string", enum: values, ...options });
