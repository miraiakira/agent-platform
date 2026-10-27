import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AIError,
  AIService,
  createModelProvider,
} from "@eap/ai";

export const runtime = "nodejs";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(8000),
});

const requestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(20),
});

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid chat request",
          },
        },
        { status: 400 },
      );
    }

    // Day 2 只允许用户和助手消息。
    // 系统指令必须由服务端控制。
    if (
      parsed.data.messages.some(
        (message) => message.role === "system",
      )
    ) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "System messages are not allowed",
          },
        },
        { status: 400 },
      );
    }

    const providerName =
      process.env.LLM_PROVIDER ?? "mock";

    if (
      providerName !== "openai" &&
      providerName !== "deepseek" &&
      providerName !== "mock"
    ) {
      throw new AIError(
        "CONFIG_ERROR",
        "Invalid LLM_PROVIDER",
      );
    }

    const provider = createModelProvider({
      provider: providerName,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL,
      baseURL: process.env.LLM_BASE_URL || undefined,
    });

    const service = new AIService(provider);

    const configuredTimeout = Number(
      process.env.LLM_TIMEOUT_MS ?? 30000,
    );

    const timeoutMs =
      Number.isFinite(configuredTimeout) &&
      configuredTimeout >= 1000 &&
      configuredTimeout <= 120000
        ? configuredTimeout
        : 30000;

    const result = await service.generate({
      messages: [
        {
          role: "system",
          content:
            "You are a helpful enterprise AI assistant.",
        },
        ...parsed.data.messages,
      ],
      signal: request.signal,
      timeoutMs,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AIError) {
      return NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
          },
        },
        {
          status:
            error.statusCode === 499
              ? 503
              : error.statusCode,
        },
      );
    }

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid JSON",
          },
        },
        { status: 400 },
      );
    }

    console.error("Chat request failed", error);

    return NextResponse.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      },
      { status: 500 },
    );
  }
}
