import type { z } from "zod";
import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";

export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = zodToJsonSchemaLib(schema, {
    target: "openApi3",
    $refStrategy: "none",
  });

  // Remove $schema key — LLM providers don't need it
  const { $schema, ...rest } = jsonSchema as Record<string, unknown>;
  return rest;
}
