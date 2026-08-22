const schema = (kind, value) => ({ kind, value });
export const Type = {
  Object: (value) => schema("object", value),
  Array: (value) => schema("array", value),
  Union: (value) => schema("union", value),
  Literal: (value) => schema("literal", value),
  Optional: (value) => schema("optional", value),
  String: (value = {}) => schema("string", value),
  Number: (value = {}) => schema("number", value),
};

export const StringEnum = (values, options = {}) => schema("string-enum", { values, ...options });
