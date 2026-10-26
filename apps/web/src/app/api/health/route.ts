import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl =
    process.env.BUSINESS_API_URL ??
    "http://127.0.0.1:8080";

  try {
    const response = await fetch(
      `${baseUrl}/api/health`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      },
    );

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }

    const data: unknown = await response.json();

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      {
        status: "error",
        service: "business-api",
      },
      { status: 503 },
    );
  }
}
