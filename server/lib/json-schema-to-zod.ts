import { z, type ZodTypeAny, type ZodRawShape } from "zod";

// Best-effort JSON-Schema -> Zod conversion. The Claude Agent SDK's `tool()`
// helper wants a ZodRawShape (it serialises it back to JSON Schema for the
// model via zod-to-json-schema). Clients like Hermes hand us tool parameters
// as JSON Schema, so we translate the common subset and preserve descriptions
// (which is what actually steers the model's tool calls). Anything exotic
// falls back to z.any(), so we never reject a tool — worst case the model sees
// a looser schema for that one field.

function nodeToZod(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  const s = schema as Record<string, any>;

  // Union-ish constructs.
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return withMeta(z.enum(s.enum.map(String) as [string, ...string[]]), s);
  }
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const variants = union.map(nodeToZod);
    const built =
      variants.length === 1
        ? variants[0]
        : z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return withMeta(built, s);
  }

  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "string":
      return withMeta(z.string(), s);
    case "number":
      return withMeta(z.number(), s);
    case "integer":
      return withMeta(z.number().int(), s);
    case "boolean":
      return withMeta(z.boolean(), s);
    case "null":
      return withMeta(z.null(), s);
    case "array":
      return withMeta(z.array(s.items ? nodeToZod(s.items) : z.any()), s);
    case "object":
      return withMeta(objectToZod(s), s);
    default:
      return withMeta(z.any(), s);
  }
}

function objectToZod(s: Record<string, any>): ZodTypeAny {
  const shape = propsToShape(s);
  const obj = z.object(shape);
  // Permit unknown keys so the model is never blocked by an incomplete schema.
  return (obj as any).passthrough?.() ?? obj;
}

function withMeta(zod: ZodTypeAny, s: Record<string, any>): ZodTypeAny {
  return typeof s.description === "string" ? zod.describe(s.description) : zod;
}

/** Convert a JSON-Schema object's `properties` into a Zod raw shape. */
export function propsToShape(schema: Record<string, any> | undefined): ZodRawShape {
  const shape: ZodRawShape = {};
  if (!schema || typeof schema !== "object") return shape;
  const props = schema.properties ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  for (const [key, propSchema] of Object.entries(props)) {
    let zod = nodeToZod(propSchema);
    if (!required.includes(key)) zod = zod.optional();
    shape[key] = zod;
  }
  return shape;
}
