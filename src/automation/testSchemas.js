const { z } = require('zod');

// Schema for a UI test definition
const uiTestSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.literal('ui'),
  config: z.object({
    url: z.string().url(),
    steps: z.array(
      z.object({
        action: z.enum(['navigate', 'click', 'fill', 'select', 'wait', 'screenshot', 'assert_text', 'assert_visible', 'assert_title', 'assert_url']),
        selector: z.string().optional(),
        value: z.string().optional(),
        timeout: z.number().optional(),
      })
    ).min(1).max(50),
    viewport: z.object({
      width: z.number().default(1280),
      height: z.number().default(720),
    }).optional(),
    headless: z.boolean().default(true),
  }),
});

// Schema for an API test definition — JSON payload only (v2.3)
const apiTestSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.literal('api'),
  config: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    // JSON-only: object or array; no raw strings, no form-data
    body: z.union([z.record(z.any()), z.array(z.any())]).nullable().optional(),
    assertions: z.array(
      z.object({
        target: z.enum(['status', 'body', 'header', 'response_time']),
        operator: z.enum(['equals', 'contains', 'greater_than', 'less_than', 'exists', 'matches']),
        expected: z.any(),
        path: z.string().optional(),
      })
    ).min(1).max(20),
    timeout: z.number().default(10000),
    // Response chaining extractors: [{name: "userId", path: "data.id"}]
    extractors: z.array(z.object({
      name: z.string().min(1),
      path: z.string().min(1),
    })).optional(),
  }),
});

// Combined schema
const testDefinitionSchema = z.discriminatedUnion('type', [uiTestSchema, apiTestSchema]);

// Execution request schema
const executeTestSchema = z.object({
  test: testDefinitionSchema,
});

module.exports = {
  uiTestSchema,
  apiTestSchema,
  testDefinitionSchema,
  executeTestSchema,
};
