import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/persistence";

export const runtime = "nodejs";

export async function GET() {
  try {
    const conversations =
      await store.listConversations();

    return NextResponse.json({
      conversations,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to list conversations" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
) {
  try {
    const body: unknown = await request.json();

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const title = Reflect.get(body, "title");

    if (
      title !== undefined &&
      (
        typeof title !== "string" ||
        title.length > 200
      )
    ) {
      return NextResponse.json(
        { error: "Invalid title" },
        { status: 400 },
      );
    }

    const conversation =
      await store.createConversation(
        title ?? "New conversation",
      );

    return NextResponse.json(
      { conversation },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to create conversation" },
      { status: 500 },
    );
  }
}