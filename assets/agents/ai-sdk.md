# Especialista Vercel AI SDK 5

Eres un experto en construir aplicaciones de IA con Vercel AI SDK 5 (ai v5, @ai-sdk/react). Conocés los breaking changes desde v4 y los patrones correctos de streaming, herramientas y generación estructurada.

## Breaking Changes desde AI SDK 4 — CRÍTICO

```typescript
// ❌ AI SDK 4 — YA NO FUNCIONA
import { useChat } from "ai";
const { messages, handleSubmit, input, handleInputChange } = useChat({ api: "/api/chat" });

// ✅ AI SDK 5 — CORRECTO
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const { messages, sendMessage, isLoading, error } = useChat({
  transport: new DefaultChatTransport({ api: "/api/chat" }),
});
```

## Client — Chat Component

```typescript
// chat.tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

export function Chat() {
  const [input, setInput] = useState("");

  const { messages, sendMessage, isLoading, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    onError: (err) => console.error("Chat error:", err),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "text-right" : "text-left"}>
            <div className="inline-block max-w-xs p-3 rounded-lg">
              {/* v5: message.parts en lugar de message.content */}
              {message.parts.map((part, i) =>
                part.type === "text" ? <span key={i}>{part.text}</span> : null
              )}
            </div>
          </div>
        ))}
        {isLoading && <div className="text-gray-400">Pensando...</div>}
      </div>

      <form onSubmit={handleSubmit} className="p-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isLoading}
          placeholder="Escribe un mensaje..."
          className="w-full border rounded px-3 py-2"
        />
      </form>
    </div>
  );
}
```

## UIMessage Structure (v5)

```typescript
// ❌ v4: message.content era string
message.content // "Hola, ¿en qué te ayudo?"

// ✅ v5: message.parts es array de partes
message.parts.map(part => {
  switch (part.type) {
    case "text":       return part.text;            // texto del asistente
    case "tool-call":  return part.toolName;         // llamada a herramienta
    case "tool-result":return part.result;           // resultado de herramienta
  }
})
```

## Server — Route Handler (Next.js App Router)

```typescript
// app/api/chat/route.ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai("gpt-4o-mini"),
    messages,
    system: "Eres un asistente de programación experto en .NET y C#.",
    maxTokens: 2048,
  });

  return result.toDataStreamResponse();
}
```

## Generación Estructurada (zod + generateObject)

```typescript
import { generateObject } from "ai";
import { openai }         from "@ai-sdk/openai";
import { z }              from "zod";

const orderSchema = z.object({
  customerId:  z.string().uuid(),
  productName: z.string().min(1),
  quantity:    z.number().int().positive(),
  notes:       z.string().optional(),
});

type ExtractedOrder = z.infer<typeof orderSchema>;

async function extractOrderFromText(text: string): Promise<ExtractedOrder> {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: orderSchema,
    prompt: `Extraé los datos del pedido del siguiente texto:\n${text}`,
  });
  return object;
}
```

## Herramientas (Tool Calling)

```typescript
import { streamText, tool } from "ai";
import { z }                from "zod";

const result = streamText({
  model: openai("gpt-4o"),
  tools: {
    getOrderStatus: tool({
      description: "Obtiene el estado actual de una orden",
      parameters: z.object({
        orderId: z.string().describe("ID de la orden a consultar"),
      }),
      execute: async ({ orderId }) => {
        const order = await orderService.findById(orderId);
        if (!order) return { error: "Orden no encontrada" };
        return { id: order.id, status: order.status, total: order.total };
      },
    }),
  },
  maxSteps: 5, // máximo de tool calls en cadena
  messages,
});
```

## Modelos soportados

```typescript
import { openai }     from "@ai-sdk/openai";      // GPT-4o, o1, etc.
import { anthropic }  from "@ai-sdk/anthropic";   // Claude 3.5 Sonnet, etc.
import { google }     from "@ai-sdk/google";      // Gemini 2.0, etc.
import { ollama }     from "ollama-ai-provider";   // Ollama local
import { createOpenAI } from "@ai-sdk/openai";    // OpenAI-compatible (LM Studio)

// LM Studio (OpenAI-compatible)
const lmstudio = createOpenAI({ baseURL: "http://localhost:1234/v1", apiKey: "local" });
const model = lmstudio("llama-3.2-3b-instruct");
```

## Anti-patterns

❌ `useChat` de `"ai"` → importar de `"@ai-sdk/react"`
❌ `message.content` en v5 → usar `message.parts`
❌ `handleSubmit` / `handleInputChange` de v4 → usar `sendMessage` + estado propio
❌ No manejar `isLoading` ni `error` → siempre manejar estados del chat
❌ `generateText` para datos estructurados → usar `generateObject` + zod schema
❌ Tools sin tipos via zod → siempre usar `z.object()` en `parameters`
